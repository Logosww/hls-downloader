#![deny(clippy::all)]

use std::collections::HashMap;
use std::sync::Arc;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use hls_core::download::DownloadProgress;
use hls_core::hls::ParseHlsResult;

// ── NAPI-compatible types ──────────────────────────────────────────────

#[napi(object)]
pub struct NapiPlaylist {
    pub name: String,
    pub bandwidth: u32,
    pub uri: String,
}

#[napi(object)]
pub struct NapiSegment {
    pub uri: String,
    pub duration: f64,
}

#[napi(object)]
pub struct NapiParseHlsResult {
    pub result_type: String,
    pub playlists: Option<Vec<NapiPlaylist>>,
    pub segments: Option<Vec<NapiSegment>>,
    pub message: Option<String>,
}

// ── Helper ─────────────────────────────────────────────────────────────

fn to_napi_err(e: hls_core::HlsError) -> Error {
    Error::from_reason(e.to_string())
}

#[napi(object)]
pub struct NapiAria2Config {
    pub enabled: Option<bool>,
    pub path: Option<String>,
    pub max_concurrent_downloads: Option<u32>,
    pub max_connection_per_server: Option<u32>,
    pub split: Option<u32>,
    pub min_split_size: Option<String>,
    pub extra_args: Option<Vec<String>>,
}

fn transcode_binding_to_core(n: Option<Vec<String>>) -> Option<hls_core::TranscodeOptions> {
    n.map(|ffmpeg_output_args| hls_core::TranscodeOptions { ffmpeg_output_args })
}

fn aria2_binding_to_core(
    n: Option<NapiAria2Config>,
) -> (bool, Option<String>, hls_core::Aria2Options) {
    match n {
        None => (false, None, hls_core::Aria2Options::default()),
        Some(cfg) => {
            let use_aria2 = cfg.enabled.unwrap_or(false);
            let exe = cfg
                .path
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_owned());
            let cli = hls_core::Aria2Options {
                max_concurrent_downloads: cfg.max_concurrent_downloads.map(|x| x as usize),
                max_connection_per_server: cfg.max_connection_per_server.map(|x| x as usize),
                split: cfg.split.map(|x| x as usize),
                min_split_size: cfg.min_split_size,
                extra_args: cfg.extra_args.unwrap_or_default(),
            };
            (use_aria2, exe, cli)
        }
    }
}

// ── Exported functions ─────────────────────────────────────────────────

#[napi]
pub fn init_ffmpeg() -> Result<()> {
    hls_core::init().map_err(to_napi_err)
}

#[napi]
pub async fn parse_hls_native(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<NapiParseHlsResult> {
    let result = hls_core::parse_hls(&url, headers.as_ref()).await;

    match result {
        Ok(ParseHlsResult::Playlist(playlists)) => Ok(NapiParseHlsResult {
            result_type: "playlist".to_string(),
            playlists: Some(
                playlists
                    .into_iter()
                    .map(|p| NapiPlaylist {
                        name: p.name,
                        bandwidth: p.bandwidth as u32,
                        uri: p.uri,
                    })
                    .collect(),
            ),
            segments: None,
            message: None,
        }),
        Ok(ParseHlsResult::Segments(segments)) => Ok(NapiParseHlsResult {
            result_type: "segment".to_string(),
            playlists: None,
            segments: Some(
                segments
                    .into_iter()
                    .map(|s| NapiSegment {
                        uri: s.uri,
                        duration: s.duration,
                    })
                    .collect(),
            ),
            message: None,
        }),
        Err(e) => Ok(NapiParseHlsResult {
            result_type: "error".to_string(),
            playlists: None,
            segments: None,
            message: Some(e.to_string()),
        }),
    }
}

#[napi(
    ts_args_type = "segments: NapiSegment[], workDir: string, filename: string, headers: Record<string, string> | undefined | null, concurrency: number, maxRetry: number, aria2: NapiAria2Config | undefined | null, transcodeArgs: string[] | undefined | null, onProgress: (phase: string, completed: number, total: number) => void"
)]
pub async fn download_and_merge(
    segments: Vec<NapiSegment>,
    work_dir: String,
    filename: String,
    headers: Option<HashMap<String, String>>,
    concurrency: u32,
    max_retry: u32,
    aria2: Option<NapiAria2Config>,
    transcode_args: Option<Vec<String>>,
    on_progress: ThreadsafeFunction<(String, u32, u32)>,
) -> Result<String> {
    let core_segments: Vec<hls_core::Segment> = segments
        .into_iter()
        .map(|s| hls_core::Segment {
            uri: s.uri,
            duration: s.duration,
        })
        .collect();

    let work = std::path::PathBuf::from(work_dir);

    let progress_cb: hls_core::download::ProgressCallback = Arc::new(move |p: DownloadProgress| {
        let (phase, completed, total) = match p {
            DownloadProgress::Downloading { completed, total } => {
                ("downloading".to_string(), completed as u32, total as u32)
            }
            DownloadProgress::Merging { completed, total } => {
                ("merging".to_string(), completed as u32, total as u32)
            }
        };
        on_progress.call(
            Ok((phase, completed, total)),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    });

    let (use_aria2, aria2_path_owned, aria2_core) = aria2_binding_to_core(aria2);
    let aria2_exec = aria2_path_owned.as_deref();
    let transcode_core = transcode_binding_to_core(transcode_args);

    let result = hls_core::download_and_merge(
        &core_segments,
        &work,
        filename.as_str(),
        headers.as_ref(),
        concurrency as usize,
        max_retry as usize,
        use_aria2,
        aria2_exec,
        aria2_core,
        transcode_core,
        Some(progress_cb),
    )
    .await
    .map_err(to_napi_err)?;

    Ok(result.to_string_lossy().to_string())
}

#[napi]
pub async fn extract_poster(
    segment_url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<Option<String>> {
    let jpeg_bytes = hls_core::extract_poster(&segment_url, headers.as_ref())
        .await
        .map_err(to_napi_err)?;

    Ok(jpeg_bytes.map(|bytes| {
        let b64 = BASE64.encode(&bytes);
        format!("data:image/jpeg;base64,{b64}")
    }))
}

#[napi(
    ts_args_type = "segments: NapiSegment[], headers: Record<string, string> | undefined | null, concurrency: number, maxRetry: number, onProgress: (loaded: number) => void"
)]
pub async fn transmux_hls_native(
    segments: Vec<NapiSegment>,
    headers: Option<HashMap<String, String>>,
    concurrency: u32,
    max_retry: u32,
    on_progress: ThreadsafeFunction<u32>,
) -> Result<Buffer> {
    let core_segments: Vec<hls_core::Segment> = segments
        .into_iter()
        .map(|s| hls_core::Segment {
            uri: s.uri,
            duration: s.duration,
        })
        .collect();

    let total = core_segments.len().max(1) as u32;
    let progress_cb: hls_core::download::ProgressCallback = Arc::new(move |p: DownloadProgress| {
        if let DownloadProgress::Downloading { completed, .. } = p {
            on_progress.call(
                Ok(completed as u32),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        } else if let DownloadProgress::Merging { .. } = p {
            on_progress.call(Ok(total), ThreadsafeFunctionCallMode::NonBlocking);
        }
    });

    let bytes = hls_core::transmux_segments_to_mp4_buffer(
        &core_segments,
        headers.as_ref(),
        concurrency as usize,
        max_retry as usize,
        Some(progress_cb),
    )
    .await
    .map_err(to_napi_err)?;

    Ok(Buffer::from(bytes))
}
