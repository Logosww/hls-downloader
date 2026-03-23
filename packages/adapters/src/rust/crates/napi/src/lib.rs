#![deny(clippy::all)]

use std::collections::HashMap;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
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
    ts_args_type = "segments: NapiSegment[], outputPath: string, headers: Record<string, string> | undefined | null, concurrency: number, maxRetry: number, onProgress: (phase: string, completed: number, total: number) => void"
)]
pub async fn download_and_merge(
    segments: Vec<NapiSegment>,
    output_path: String,
    headers: Option<HashMap<String, String>>,
    concurrency: u32,
    max_retry: u32,
    on_progress: ThreadsafeFunction<(String, u32, u32)>,
) -> Result<String> {
    let core_segments: Vec<hls_core::Segment> = segments
        .into_iter()
        .map(|s| hls_core::Segment {
            uri: s.uri,
            duration: s.duration,
        })
        .collect();

    let output = std::path::PathBuf::from(&output_path);

    let progress_cb: hls_core::download::ProgressCallback =
        Arc::new(move |p: DownloadProgress| {
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

    let result = hls_core::download_and_merge(
        &core_segments,
        &output,
        headers.as_ref(),
        concurrency as usize,
        max_retry as usize,
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
