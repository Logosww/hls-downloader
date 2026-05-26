use std::collections::HashMap;
use std::io::{copy, BufReader, BufWriter as StdBufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use tokio::io::{AsyncWriteExt, BufWriter as TokioBufWriter};

use crate::hls::Segment;
use crate::HlsError;

#[derive(Debug, Clone)]
pub enum DownloadProgress {
    Downloading { completed: usize, total: usize },
    Merging { completed: usize, total: usize },
}

pub type MergeProgress = DownloadProgress;
pub type ProgressCallback = Arc<dyn Fn(DownloadProgress) + Send + Sync>;

#[derive(Debug, Clone, Default)]
pub struct TranscodeOptions {
    pub ffmpeg_output_args: Vec<String>,
}

/// Optional knobs for aria2 (only used when downloading via aria2).
#[derive(Debug, Clone, Default)]
pub struct Aria2Options {
    /// Overrides `--max-concurrent-downloads` when set; otherwise the download `concurrency` value is used.
    pub max_concurrent_downloads: Option<usize>,
    pub max_connection_per_server: Option<usize>,
    pub split: Option<usize>,
    pub min_split_size: Option<String>,
    pub extra_args: Vec<String>,
}

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

    let file_path = dir.join(format!("{index:06}.ts"));
    let file = tokio::fs::File::create(&file_path).await?;
    let mut writer = TokioBufWriter::new(file);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        writer.write_all(&chunk).await?;
    }
    writer.flush().await?;

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

fn write_aria2_input_file(
    path: &Path,
    segments: &[Segment],
    headers: Option<&HashMap<String, String>>,
) -> Result<(), HlsError> {
    let mut file = std::fs::File::create(path)?;
    for (i, seg) in segments.iter().enumerate() {
        writeln!(file, "{}", seg.uri)?;
        writeln!(file, "  out={i:06}.ts")?;
        if let Some(h) = headers {
            for (k, v) in h {
                writeln!(file, "  header={k}: {v}")?;
            }
        }
    }
    Ok(())
}

fn run_aria2_download(
    work_dir: &Path,
    segments: &[Segment],
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    max_retry: usize,
    aria2_executable: &str,
    aria2_options: &Aria2Options,
    on_progress: Option<&ProgressCallback>,
    total: usize,
) -> Result<Vec<PathBuf>, HlsError> {
    if let Some(cb) = on_progress {
        cb(DownloadProgress::Downloading {
            completed: 0,
            total,
        });
    }

    let session_path = work_dir.join("hls-aria2-session.txt");
    write_aria2_input_file(&session_path, segments, headers)?;

    let max_concurrent_downloads = aria2_options
        .max_concurrent_downloads
        .unwrap_or(concurrency)
        .max(1);
    let max_retry = max_retry.max(1);

    let mut cmd = Command::new(aria2_executable);
    cmd.current_dir(work_dir)
        .arg("--no-conf=true")
        .arg("-i")
        .arg(&session_path)
        .arg("-d")
        .arg(work_dir)
        .arg(format!("--max-concurrent-downloads={max_concurrent_downloads}"))
        .arg(format!("--max-tries={max_retry}"));
    if let Some(n) = aria2_options.max_connection_per_server.filter(|n| *n >= 1) {
        cmd.arg(format!("--max-connection-per-server={n}"));
    }
    if let Some(s) = aria2_options.split.filter(|s| *s > 0) {
        cmd.arg(format!("--split={s}"));
    }
    if let Some(ref s) = aria2_options.min_split_size {
        let t = s.trim();
        if !t.is_empty() {
            cmd.arg(format!("--min-split-size={t}"));
        }
    }
    cmd.arg("--auto-file-renaming=false")
        .arg("--allow-overwrite=true")
        .arg("--continue=false")
        .arg("--console-log-level=warn");
    for arg in aria2_options.extra_args.iter().filter(|a| !a.is_empty()) {
        cmd.arg(arg);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            HlsError::Aria2(format!(
                "`{aria2_executable}` not found. Install aria2 and ensure it is on PATH, or set `aria2.path` on RustAdapter."
            ))
        } else {
            HlsError::Aria2(format!("Failed to spawn aria2: {e}"))
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = stderr.trim();
        let msg = if hint.is_empty() {
            format!("aria2 exited with status {}", output.status)
        } else {
            format!("aria2 failed: {hint}")
        };
        return Err(HlsError::Aria2(msg));
    }

    let mut paths = Vec::with_capacity(segments.len());
    for i in 0..segments.len() {
        let p = work_dir.join(format!("{i:06}.ts"));
        if !p.is_file() {
            return Err(HlsError::Aria2(format!(
                "Expected segment file missing after aria2: {}",
                p.display()
            )));
        }
        paths.push(p);
    }

    if let Some(cb) = on_progress {
        cb(DownloadProgress::Downloading {
            completed: total,
            total,
        });
    }

    let _ = std::fs::remove_file(&session_path);

    Ok(paths)
}

/// Stream-concatenate TS segments to one file, then remux to the output path via ffmpeg-next (stream copy).
pub(crate) fn merge_segments_with_ffmpeg(
    segment_paths: &[PathBuf],
    output_path: &Path,
    on_progress: Option<&ProgressCallback>,
) -> Result<(), HlsError> {
    if segment_paths.is_empty() {
        return Err(HlsError::Parse("No segments to merge".into()));
    }
    let concat_ts = output_path.with_extension("ts");
    {
        let mut out = StdBufWriter::new(std::fs::File::create(&concat_ts)?);
        let n = segment_paths.len().max(1);
        for (i, path) in segment_paths.iter().enumerate() {
            let mut inp = BufReader::new(std::fs::File::open(path)?);
            copy(&mut inp, &mut out)?;
            if let Some(cb) = on_progress {
                cb(DownloadProgress::Merging {
                    completed: ((i + 1) * 50) / n,
                    total: 100,
                });
            }
        }
        out.flush()?;
    }

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

fn concat_segments_to_ts(
    segment_paths: &[PathBuf],
    concat_ts: &Path,
    on_progress: Option<&ProgressCallback>,
) -> Result<(), HlsError> {
    if segment_paths.is_empty() {
        return Err(HlsError::Parse("No segments to merge".into()));
    }

    let mut out = StdBufWriter::new(std::fs::File::create(concat_ts)?);
    let n = segment_paths.len().max(1);
    for (i, path) in segment_paths.iter().enumerate() {
        let mut inp = BufReader::new(std::fs::File::open(path)?);
        copy(&mut inp, &mut out)?;
        if let Some(cb) = on_progress {
            cb(DownloadProgress::Merging {
                completed: ((i + 1) * 50) / n,
                total: 100,
            });
        }
    }
    out.flush()?;
    Ok(())
}

fn transcode_segments_with_ffmpeg(
    segment_paths: &[PathBuf],
    output_path: &Path,
    transcode: &TranscodeOptions,
    on_progress: Option<&ProgressCallback>,
) -> Result<(), HlsError> {
    let concat_ts = output_path.with_extension("concat.ts");
    concat_segments_to_ts(segment_paths, &concat_ts, on_progress)?;

    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-i")
        .arg(&concat_ts);
    for arg in &transcode.ffmpeg_output_args {
        cmd.arg(arg);
    }
    cmd.arg(output_path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            HlsError::Parse(
                "`ffmpeg` not found. Install FFmpeg and ensure it is on PATH to use transcode options."
                    .to_string(),
            )
        } else {
            HlsError::Parse(format!("Failed to spawn ffmpeg: {e}"))
        }
    })?;

    std::fs::remove_file(&concat_ts).ok();

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = stderr.trim();
        let msg = if hint.is_empty() {
            format!("ffmpeg exited with status {}", output.status)
        } else {
            format!("ffmpeg failed: {hint}")
        };
        return Err(HlsError::Parse(msg));
    }

    if let Some(cb) = on_progress {
        cb(DownloadProgress::Merging {
            completed: 100,
            total: 100,
        });
    }

    Ok(())
}

fn validate_output_filename(name: &str) -> Result<(), HlsError> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(HlsError::Parse("Invalid output filename".into()));
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(HlsError::Parse(
            "Output filename must be a base name without path separators".into(),
        ));
    }
    Ok(())
}

/// Downloads HLS segments to `work_dir` using either reqwest or aria2. Used by benches to measure phase 1 only.
#[doc(hidden)]
pub async fn download_segments_to_dir(
    work_dir: &Path,
    segments: &[Segment],
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    max_retry: usize,
    use_aria2: bool,
    aria2_executable: Option<&str>,
    aria2_options: Aria2Options,
    on_progress: Option<ProgressCallback>,
) -> Result<Vec<PathBuf>, HlsError> {
    let total = segments.len();
    let on_progress = on_progress.as_ref();

    if use_aria2 {
        let exe_owned = aria2_executable
            .map(String::from)
            .unwrap_or_else(|| "aria2c".to_string());
        let aria2_opts = aria2_options.clone();
        let work = work_dir.to_path_buf();
        let segs = segments.to_vec();
        let hdrs = headers.cloned();
        let progress_owned = on_progress.cloned();

        tokio::task::spawn_blocking(move || {
            run_aria2_download(
                &work,
                &segs,
                hdrs.as_ref(),
                concurrency,
                max_retry,
                &exe_owned,
                &aria2_opts,
                progress_owned.as_ref(),
                total,
            )
        })
        .await
        .map_err(|e| HlsError::Parse(format!("Join error: {e}")))?
    } else {
        let client = reqwest::Client::new();
        let completed = Arc::new(AtomicUsize::new(0));
        let headers_owned = headers.cloned();

        let indexed: Vec<(usize, Segment)> = segments.iter().cloned().enumerate().collect();

        let segment_paths: Vec<Result<(usize, PathBuf), HlsError>> = stream::iter(indexed)
            .map(|(i, seg)| {
                let client = client.clone();
                let tmp_path = work_dir.to_path_buf();
                let completed = completed.clone();
                let progress = on_progress.cloned();
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
                    if let Some(cb) = progress.as_ref() {
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
        Ok(ordered.into_iter().map(|(_, p)| p).collect())
    }
}

pub async fn download_and_merge(
    segments: &[Segment],
    work_dir: &Path,
    output_filename: &str,
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    max_retry: usize,
    use_aria2: bool,
    aria2_executable: Option<&str>,
    aria2_options: Aria2Options,
    transcode_options: Option<TranscodeOptions>,
    on_progress: Option<ProgressCallback>,
) -> Result<PathBuf, HlsError> {
    validate_output_filename(output_filename)?;
    std::fs::create_dir_all(work_dir)?;

    let paths = download_segments_to_dir(
        work_dir,
        segments,
        headers,
        concurrency,
        max_retry,
        use_aria2,
        aria2_executable,
        aria2_options,
        on_progress.clone(),
    )
    .await?;

    let output_path_buf = work_dir.join(output_filename);
    let merge_paths = paths.clone();
    let output = output_path_buf.clone();
    let merge_progress_cloned = on_progress.clone();
    tokio::task::spawn_blocking(move || match transcode_options {
        Some(transcode) => transcode_segments_with_ffmpeg(
            &merge_paths,
            &output,
            &transcode,
            merge_progress_cloned.as_ref(),
        ),
        None => merge_segments_with_ffmpeg(&merge_paths, &output, merge_progress_cloned.as_ref()),
    })
    .await
    .map_err(|e| HlsError::Parse(format!("Join error: {e}")))??;

    for p in &paths {
        let _ = std::fs::remove_file(p);
    }

    Ok(output_path_buf)
}
