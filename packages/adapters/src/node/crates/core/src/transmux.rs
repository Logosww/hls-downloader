use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use hls_transmux::{
    ByteRange, CancelToken, Error as TransmuxError, HlsInput, OutputFormat, ReqwestSource, Source,
    SourceLocation, TextResource, TransmuxOptions, TransmuxProgress, transmux_hls_to_mp4_async,
    transmux_hls_to_writer_async,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::HlsError;
use crate::cancel::JobCancelToken;
use crate::download::{DownloadProgress, ProgressCallback};

#[derive(Debug)]
struct RetryingSource {
    inner: ReqwestSource,
    max_attempts: usize,
    cancel: Option<Arc<JobCancelToken>>,
}

impl RetryingSource {
    fn new(
        concurrency: usize,
        headers: HeaderMap,
        max_attempts: usize,
        cancel: Option<Arc<JobCancelToken>>,
    ) -> Self {
        Self {
            inner: ReqwestSource::with_concurrency_and_headers(concurrency.max(1), headers),
            max_attempts: max_attempts.max(1),
            cancel,
        }
    }

    async fn wait(&self, attempt: usize) -> Result<(), TransmuxError> {
        let base = 250_u64.saturating_mul(2_u64.saturating_pow((attempt - 1) as u32));
        let base = base.min(4_000);
        let jitter = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| 90 + u64::from(duration.subsec_nanos() % 21))
            .unwrap_or(100);
        let delay = tokio::time::sleep(std::time::Duration::from_millis(base * jitter / 100));
        tokio::pin!(delay);
        if let Some(cancel) = &self.cancel {
            tokio::select! {
                _ = &mut delay => Ok(()),
                _ = cancel.cancelled() => Err(TransmuxError::Cancelled),
            }
        } else {
            delay.await;
            Ok(())
        }
    }

    fn should_retry(error: &TransmuxError) -> bool {
        let TransmuxError::Http(message) = error else {
            return false;
        };
        let status = message
            .split_whitespace()
            .find_map(|part| part.parse::<u16>().ok());
        status.is_none_or(|status| matches!(status, 408 | 425 | 429 | 500..=599))
    }
}

impl Source for RetryingSource {
    fn read_text<'a>(
        &'a self,
        location: &'a SourceLocation,
    ) -> Pin<Box<dyn Future<Output = Result<TextResource, TransmuxError>> + Send + 'a>> {
        Box::pin(async move {
            for attempt in 1..=self.max_attempts {
                if self
                    .cancel
                    .as_ref()
                    .is_some_and(|cancel| cancel.is_cancelled())
                {
                    return Err(TransmuxError::Cancelled);
                }
                match self.inner.read_text(location).await {
                    Ok(resource) => return Ok(resource),
                    Err(error) if attempt < self.max_attempts && Self::should_retry(&error) => {
                        self.wait(attempt).await?;
                    }
                    Err(error) => return Err(error),
                }
            }
            unreachable!()
        })
    }

    fn read_bytes<'a>(
        &'a self,
        location: &'a SourceLocation,
        range: Option<&'a ByteRange>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, TransmuxError>> + Send + 'a>> {
        Box::pin(async move {
            for attempt in 1..=self.max_attempts {
                if self
                    .cancel
                    .as_ref()
                    .is_some_and(|cancel| cancel.is_cancelled())
                {
                    return Err(TransmuxError::Cancelled);
                }
                match self.inner.read_bytes(location, range).await {
                    Ok(bytes) => return Ok(bytes),
                    Err(error) if attempt < self.max_attempts && Self::should_retry(&error) => {
                        self.wait(attempt).await?;
                    }
                    Err(error) => return Err(error),
                }
            }
            unreachable!()
        })
    }
}

/// Download HLS segments and transmux to MP4 using hls-transmux's built-in
/// concurrent HTTP client + transmuxer. Writes the result directly to `output_path`.
///
/// `playlist_url` 必须是已选定 variant 的 media playlist URL（由 NodeAdapter
/// 上层 resolveToSegments 解析 master playlist 后给出）。
///
/// `cancel` 为 `Some` 时，hls-transmux 会在每段循环顶部及 await 点检查取消信号。
pub async fn transmux_segments_to_mp4_file(
    playlist_url: &str,
    output_path: &Path,
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    max_retry: usize,
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

    let source = Arc::new(RetryingSource::new(
        concurrency,
        header_map,
        max_retry,
        cancel.clone(),
    ));
    let location = SourceLocation::Url(
        url::Url::parse(playlist_url).map_err(|e| HlsError::Parse(e.to_string()))?,
    );
    let input = HlsInput::custom(source, location);

    let progress_cb = on_progress.as_ref().map(|cb| {
        let cb = Arc::clone(cb);
        let cb_fn: Arc<dyn Fn(TransmuxProgress) + Send + Sync> =
            Arc::new(move |p: TransmuxProgress| {
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
pub async fn transmux_hls_to_stream<W>(
    playlist_url: &str,
    writer: &mut W,
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    max_retry: usize,
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

    let source = Arc::new(RetryingSource::new(
        concurrency,
        header_map,
        max_retry,
        cancel.clone(),
    ));
    let location = SourceLocation::Url(
        url::Url::parse(playlist_url).map_err(|e| HlsError::Parse(e.to_string()))?,
    );
    let input = HlsInput::custom(source, location);

    let progress_cb = on_progress.as_ref().map(|cb| {
        let cb = Arc::clone(cb);
        let cb_fn: Arc<dyn Fn(TransmuxProgress) + Send + Sync> =
            Arc::new(move |p: TransmuxProgress| {
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

#[cfg(test)]
mod retry_tests {
    use super::*;

    #[test]
    fn retries_network_and_transient_status_errors_only() {
        assert!(RetryingSource::should_retry(&TransmuxError::Http(
            "transport closed".into()
        )));
        assert!(RetryingSource::should_retry(&TransmuxError::Http(
            "GET example returned status 503 Service Unavailable".into()
        )));
        assert!(!RetryingSource::should_retry(&TransmuxError::Http(
            "GET example returned status 404 Not Found".into()
        )));
        assert!(!RetryingSource::should_retry(&TransmuxError::InvalidInput(
            "bad playlist".into()
        )));
    }
}
