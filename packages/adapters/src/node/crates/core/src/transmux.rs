use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use hls_transmux::{
    transmux_hls_to_mp4_async, transmux_hls_to_writer_async, CancelToken, HlsInput, OutputFormat,
    ReqwestSource, SourceLocation, TransmuxOptions, TransmuxProgress,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::cancel::JobCancelToken;
use crate::download::{DownloadProgress, ProgressCallback};
use crate::HlsError;

/// Download HLS segments and transmux to MP4 using hls-transmux's built-in
/// concurrent HTTP client + transmuxer. Writes the result directly to `output_path`.
///
/// `playlist_url` 必须是已选定 variant 的 media playlist URL（由 NodeAdapter
/// 上层 resolveToSegments 解析 master playlist 后给出）。
///
/// `max_retry` 当前由 hls-transmux 内置 reqwest 客户端决定（不支持显式
/// 重试次数配置；本次先标注为已知限制）。
///
/// `cancel` 为 `Some` 时，hls-transmux 会在每段循环顶部及 await 点检查取消信号。
pub async fn transmux_segments_to_mp4_file(
    playlist_url: &str,
    output_path: &Path,
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    _max_retry: usize,
    cancel: Option<Arc<JobCancelToken>>,
    on_progress: Option<ProgressCallback>,
) -> Result<(), HlsError> {
    let mut header_map = HeaderMap::new();
    if let Some(h) = headers {
        for (k, v) in h {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }
    }

    let source = Arc::new(ReqwestSource::with_concurrency_and_headers(
        concurrency.max(1),
        header_map,
    ));
    let location = SourceLocation::Url(
        url::Url::parse(playlist_url).map_err(|e| HlsError::Parse(e.to_string()))?,
    );
    let input = HlsInput::custom(source, location);

    let progress_cb = on_progress.as_ref().map(|cb| {
        let cb = Arc::clone(cb);
        let cb_fn: Arc<dyn Fn(TransmuxProgress) + Send + Sync> = Arc::new(move |p: TransmuxProgress| {
            cb(DownloadProgress::Downloading {
                completed: p.completed_segments,
                total: p.total_segments,
            });
        });
        cb_fn
    });

    let report = transmux_hls_to_mp4_async(
        input,
        output_path,
        TransmuxOptions {
            output_format: OutputFormat::StreamingMp4,
            on_progress: progress_cb,
            cancel: cancel.map(|c| c as Arc<dyn CancelToken>),
            ..Default::default()
        },
    )
    .await
    .map_err(map_transmux_error)?;

    // 末端 mux 完成 → 触发一次 Merging 完成事件，保持与原 download_and_merge
    // 的两阶段事件语义一致。
    if let Some(cb) = on_progress.as_ref() {
        cb(DownloadProgress::Merging {
            completed: report.segment_count,
            total: report.segment_count,
        });
    }
    Ok(())
}

fn map_transmux_error(e: hls_transmux::Error) -> HlsError {
    use hls_transmux::Error as E;
    match e {
        E::Io(io) => HlsError::Io(io),
        E::Http(msg) => HlsError::Parse(format!("HTTP error: {msg}")),
        E::InvalidInput(msg) => HlsError::Parse(format!("invalid input: {msg}")),
        E::Unsupported(msg) => HlsError::Parse(format!("unsupported: {msg}")),
        E::Bitstream(msg) => HlsError::Parse(format!("bitstream: {msg}")),
        E::Muxing(msg) => HlsError::Parse(format!("muxing: {msg}")),
        E::Cancelled => HlsError::Parse("transmux cancelled".into()),
    }
}

/// 把 HLS 流式 transmux 为 fMP4 字节，写入任意 `AsyncWrite` sink。
///
/// 选用 `OutputFormat::FragmentedMp4`：首段输出 `ftyp`+`moov`，每段输出
/// `styp`+`moof`+`mdat`，末端可选 `mfra`。字节序列与文件版（同 format）一致。
///
/// `on_progress` 每段完成后触发，反映下载与 mux 进度。
///
/// `max_retry` 当前由 hls-transmux 内置 reqwest 决定（不支持显式重试次数）。
pub async fn transmux_hls_to_stream<W>(
    playlist_url: &str,
    writer: &mut W,
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    _max_retry: usize,
    cancel: Option<Arc<JobCancelToken>>,
    on_progress: Option<ProgressCallback>,
) -> Result<(), HlsError>
where
    W: tokio::io::AsyncWrite + Send + Unpin,
{
    let mut header_map = HeaderMap::new();
    if let Some(h) = headers {
        for (k, v) in h {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                header_map.insert(name, val);
            }
        }
    }

    let source = Arc::new(ReqwestSource::with_concurrency_and_headers(
        concurrency.max(1),
        header_map,
    ));
    let location = SourceLocation::Url(
        url::Url::parse(playlist_url).map_err(|e| HlsError::Parse(e.to_string()))?,
    );
    let input = HlsInput::custom(source, location);

    let progress_cb = on_progress.as_ref().map(|cb| {
        let cb = Arc::clone(cb);
        let cb_fn: Arc<dyn Fn(TransmuxProgress) + Send + Sync> = Arc::new(move |p: TransmuxProgress| {
            cb(DownloadProgress::Downloading {
                completed: p.completed_segments,
                total: p.total_segments,
            });
        });
        cb_fn
    });

    let report = transmux_hls_to_writer_async(
        input,
        writer,
        TransmuxOptions {
            output_format: OutputFormat::FragmentedMp4,
            on_progress: progress_cb,
            cancel: cancel.map(|c| c as Arc<dyn CancelToken>),
            write_mfra: true,
            ..Default::default()
        },
    )
    .await
    .map_err(map_transmux_error)?;

    // 末端触发一次 Merging 完成事件，保持两阶段事件语义一致
    if let Some(cb) = on_progress.as_ref() {
        cb(DownloadProgress::Merging {
            completed: report.segment_count,
            total: report.segment_count,
        });
    }
    Ok(())
}
