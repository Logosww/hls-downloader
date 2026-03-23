use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use tempfile::TempDir;

use crate::hls::Segment;
use crate::HlsError;

#[derive(Debug, Clone)]
pub enum DownloadProgress {
    Downloading { completed: usize, total: usize },
    Merging { completed: usize, total: usize },
}

pub type MergeProgress = DownloadProgress;
pub type ProgressCallback = Arc<dyn Fn(DownloadProgress) + Send + Sync>;

async fn download_segment(
    client: &reqwest::Client,
    segment: &Segment,
    index: usize,
    dir: &Path,
    headers: Option<&HashMap<String, String>>,
) -> Result<PathBuf, HlsError> {
    let mut req = client.get(&segment.uri);
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let response = req.send().await?;
    if !response.status().is_success() {
        return Err(HlsError::Parse(format!(
            "Failed to fetch segment {}: {}",
            segment.uri,
            response.status()
        )));
    }

    let bytes = response.bytes().await?;
    let file_path = dir.join(format!("{index:06}.ts"));
    let mut file = std::fs::File::create(&file_path)?;
    file.write_all(&bytes)?;

    Ok(file_path)
}

async fn download_segment_with_retry(
    client: &reqwest::Client,
    segment: &Segment,
    index: usize,
    dir: &Path,
    headers: Option<&HashMap<String, String>>,
    max_retry: usize,
) -> Result<PathBuf, HlsError> {
    let mut last_err = None;
    for _ in 0..max_retry {
        match download_segment(client, segment, index, dir, headers).await {
            Ok(path) => return Ok(path),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| HlsError::Parse("Download failed".to_string())))
}

/// Concatenate TS segments and remux to MP4 via ffmpeg-next (stream copy, no re-encoding).
fn merge_segments_with_ffmpeg(
    segment_paths: &[PathBuf],
    output_path: &Path,
    on_progress: Option<&ProgressCallback>,
) -> Result<(), HlsError> {
    // MPEG-TS can be concatenated byte-for-byte
    let concat_ts = output_path.with_extension("ts");
    {
        let mut out = std::fs::File::create(&concat_ts)?;
        for (i, path) in segment_paths.iter().enumerate() {
            let data = std::fs::read(path)?;
            out.write_all(&data)?;
            if let Some(cb) = on_progress {
                cb(DownloadProgress::Merging {
                    completed: ((i + 1) * 50) / segment_paths.len(),
                    total: 100,
                });
            }
        }
    }

    // Remux concatenated TS -> MP4 via stream copy
    let mut ictx = ffmpeg_next::format::input(&concat_ts)?;
    let mut octx = ffmpeg_next::format::output(output_path)?;

    let mut stream_count = 0;
    for stream in ictx.streams() {
        let mut out_stream =
            octx.add_stream(ffmpeg_next::encoder::find(ffmpeg_next::codec::Id::None))?;
        out_stream.set_parameters(stream.parameters());
        unsafe {
            (*out_stream.parameters().as_mut_ptr()).codec_tag = 0;
        }
        stream_count += 1;
    }

    octx.set_metadata(ictx.metadata().to_owned());
    octx.write_header()?;

    let mut packet_count: usize = 0;
    for (stream, packet) in ictx.packets() {
        let idx = stream.index();
        if idx < stream_count {
            let mut pkt = packet.clone();
            pkt.set_stream(idx);
            pkt.rescale_ts(
                stream.time_base(),
                octx.stream(idx).unwrap().time_base(),
            );
            pkt.set_position(-1);
            pkt.write_interleaved(&mut octx)?;
        }
        packet_count += 1;
        if packet_count % 100 == 0 {
            if let Some(cb) = on_progress {
                cb(DownloadProgress::Merging {
                    completed: 50 + (packet_count % 50),
                    total: 100,
                });
            }
        }
    }

    octx.write_trailer()?;
    std::fs::remove_file(&concat_ts).ok();

    if let Some(cb) = on_progress {
        cb(DownloadProgress::Merging {
            completed: 100,
            total: 100,
        });
    }

    Ok(())
}

pub async fn download_and_merge(
    segments: &[Segment],
    output_path: &Path,
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    max_retry: usize,
    on_progress: Option<ProgressCallback>,
) -> Result<PathBuf, HlsError> {
    let tmp_dir = TempDir::new()?;
    let client = reqwest::Client::new();
    let total = segments.len();
    let completed = Arc::new(AtomicUsize::new(0));
    let headers_owned = headers.cloned();

    // Phase 1: Download segments concurrently
    let indexed: Vec<(usize, Segment)> = segments.iter().cloned().enumerate().collect();

    let segment_paths: Vec<Result<(usize, PathBuf), HlsError>> = stream::iter(indexed)
        .map(|(i, seg)| {
            let client = client.clone();
            let tmp_path = tmp_dir.path().to_path_buf();
            let completed = completed.clone();
            let progress = on_progress.clone();
            let hdrs = headers_owned.clone();
            async move {
                let path = download_segment_with_retry(
                    &client,
                    &seg,
                    i,
                    &tmp_path,
                    hdrs.as_ref(),
                    max_retry,
                )
                .await?;
                let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                if let Some(ref cb) = progress {
                    cb(DownloadProgress::Downloading {
                        completed: done,
                        total,
                    });
                }
                Ok((i, path))
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    let mut ordered: Vec<(usize, PathBuf)> =
        segment_paths.into_iter().collect::<Result<Vec<_>, _>>()?;
    ordered.sort_by_key(|(i, _)| *i);
    let paths: Vec<PathBuf> = ordered.into_iter().map(|(_, p)| p).collect();

    // Phase 2: Merge with ffmpeg (blocking)
    let output = output_path.to_path_buf();
    let merge_progress = on_progress;

    tokio::task::spawn_blocking(move || {
        merge_segments_with_ffmpeg(&paths, &output, merge_progress.as_ref())
    })
    .await
    .map_err(|e| HlsError::Parse(format!("Join error: {e}")))??;

    Ok(output_path.to_path_buf())
}
