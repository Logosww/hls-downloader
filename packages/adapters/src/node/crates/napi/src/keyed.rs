use hls_transmux::crypto::key::KeyFuture;
use hls_transmux::*;
use napi::bindgen_prelude::{Buffer, Promise};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Instant,
};
#[path = "../../../../rust/keyed.rs"]
mod wire;
#[napi(object)]
pub struct KeyReply {
    pub status: String,
    pub key: Buffer,
    pub version: Option<String>,
    pub ttl: Option<String>,
}
struct Host {
    read: Arc<ThreadsafeFunction<String, Promise<Buffer>>>,
    resolve: Arc<ThreadsafeFunction<String, Promise<KeyReply>>>,
    abort: ThreadsafeFunction<String>,
    start: Instant,
}
impl wire::Host for Host {
    fn now(&self) -> u64 {
        self.start.elapsed().as_millis().min(u64::MAX as u128) as u64
    }
    fn abort(&self, id: String) {
        self.abort
            .call(Ok(id), ThreadsafeFunctionCallMode::NonBlocking);
    }
    fn read(&self, request: String) -> wire::ReadFuture {
        let callback = self.read.clone();
        Box::pin(async move {
            Ok(callback
                .call_async(Ok(request))
                .await
                .map_err(|_| Error::Http("read bridge failed".into()))?
                .await
                .map_err(|_| Error::Http("read bridge failed".into()))?
                .to_vec())
        })
    }
    fn resolve(&self, request: String) -> KeyFuture<wire::Reply> {
        let callback = self.resolve.clone();
        Box::pin(async move {
            let result = async { callback.call_async(Ok(request)).await?.await }.await;
            match result {
                Ok(r) => wire::Reply {
                    status: r.status,
                    key: r.key.to_vec(),
                    version: r.version,
                    ttl: r.ttl.and_then(|t| t.parse().ok()),
                },
                Err(_) => wire::Reply {
                    status: "failure".into(),
                    key: Vec::new(),
                    version: None,
                    ttl: None,
                },
            }
        })
    }
}
type Pending = Pin<Box<dyn Future<Output = std::io::Result<usize>> + Send>>;
struct Writer {
    write: Arc<ThreadsafeFunction<Buffer, Promise<()>>>,
    pending: Option<Pending>,
}
impl tokio::io::AsyncWrite for Writer {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.pending.is_none() {
            let write = self.write.clone();
            let bytes = bytes.to_vec();
            let len = bytes.len();
            self.pending = Some(Box::pin(async move {
                write
                    .call_async(Ok(Buffer::from(bytes)))
                    .await
                    .map_err(|_| std::io::Error::other("write failed"))?
                    .await
                    .map_err(|_| std::io::Error::other("write failed"))?;
                Ok(len)
            }));
        }
        let result = self.pending.as_mut().unwrap().as_mut().poll(cx);
        if result.is_ready() {
            self.pending = None;
        }
        result
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
#[napi]
pub fn parse_media_playlist_native(text: String, url: String) -> String {
    wire::metadata(text, url)
}
#[napi]
pub async fn keyed_native(
    request: String,
    cancel_job_id: String,
    read: ThreadsafeFunction<String, Promise<Buffer>>,
    write: ThreadsafeFunction<Buffer, Promise<()>>,
    resolve: ThreadsafeFunction<String, Promise<KeyReply>>,
    abort: ThreadsafeFunction<String>,
    progress: ThreadsafeFunction<String>,
) -> napi::Result<String> {
    let r: wire::Request = serde_json::from_str(&request)
        .map_err(|_| napi::Error::from_reason("invalid keyed request"))?;
    let cancel = super::registry()
        .get(&cancel_job_id)
        .map(|e| Arc::clone(&e))
        .ok_or_else(|| napi::Error::from_reason("missing cancel token"))?;
    let host = Arc::new(Host {
        read: Arc::new(read),
        resolve: Arc::new(resolve),
        abort,
        start: Instant::now(),
    });
    let options = KeyedPrepareOptions::default()
        .with_cancel(cancel)
        .with_on_event(Arc::new(move |e| {
            progress.call(
                Ok(wire::progress(e)),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }));
    let p = match wire::prepare(&r, host, options).await {
        Ok(p) => p,
        Err(e) => return Ok(e.to_string()),
    };
    let result = if r.mode == "file" {
        p.write_to_file(
            r.output
                .ok_or_else(|| napi::Error::from_reason("missing output"))?,
            FileOutputOptions::default(),
        )
        .await
    } else {
        p.write_to(&mut Writer {
            write: Arc::new(write),
            pending: None,
        })
        .await
    };
    Ok(match result {
        Ok(report) => serde_json::json!({"totalSegments":report.media().segment_count}),
        Err(e) => wire::failure(e),
    }
    .to_string())
}

struct TimelineOutputHost {
    control: Arc<ThreadsafeFunction<String, Promise<String>>>,
    write: Arc<ThreadsafeFunction<(Buffer, String), Promise<()>>>,
}
impl wire::timeline::OutputHost for TimelineOutputHost {
    fn control(&self, value: String) -> wire::timeline::OutputFuture<String> {
        let callback = self.control.clone();
        Box::pin(async move {
            callback
                .call_async(Ok(value))
                .await
                .map_err(|_| std::io::Error::other("output control failed"))?
                .await
                .map_err(|_| std::io::Error::other("output control failed"))
        })
    }
    fn write(&self, index: String, bytes: Vec<u8>) -> wire::timeline::OutputFuture<()> {
        let callback = self.write.clone();
        Box::pin(async move {
            callback
                .call_async(Ok((Buffer::from(bytes), index)))
                .await
                .map_err(|_| std::io::Error::other("output write failed"))?
                .await
                .map_err(|_| std::io::Error::other("output write failed"))
        })
    }
}
#[napi]
pub async fn timeline_native(
    request: String,
    cancel_job_id: String,
    read: ThreadsafeFunction<String, Promise<Buffer>>,
    write: ThreadsafeFunction<(Buffer, String), Promise<()>>,
    resolve: ThreadsafeFunction<String, Promise<KeyReply>>,
    abort: ThreadsafeFunction<String>,
    control: ThreadsafeFunction<String, Promise<String>>,
) -> napi::Result<String> {
    let r: wire::Request = match serde_json::from_str(&request) {
        Ok(r) => r,
        Err(_) => return Ok(wire::error("RANGE_INVALID", "InvalidOptions").to_string()),
    };
    let cancel = super::registry()
        .get(&cancel_job_id)
        .map(|e| Arc::clone(&e))
        .ok_or_else(|| napi::Error::from_reason("missing cancel token"))?;
    let host = Arc::new(Host {
        read: Arc::new(read),
        resolve: Arc::new(resolve),
        abort,
        start: Instant::now(),
    });
    let output = Arc::new(TimelineOutputHost {
        control: Arc::new(control),
        write: Arc::new(write),
    });
    // Timeline leases intentionally allow non-Send futures. Own their local executor
    // on a blocking worker; only thread-safe callback handles cross this boundary.
    tokio::task::spawn_blocking(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map(|rt| {
                rt.block_on(wire::timeline::run(&r, host, output, Some(cancel)))
                    .to_string()
            })
            .map_err(|_| napi::Error::from_reason("timeline executor failed"))
    })
    .await
    .map_err(|_| napi::Error::from_reason("timeline worker failed"))?
}

fn recordings() -> &'static dashmap::DashMap<String, Arc<wire::continuous::Bridge>> {
    static RECORDINGS: std::sync::OnceLock<
        dashmap::DashMap<String, Arc<wire::continuous::Bridge>>,
    > = std::sync::OnceLock::new();
    RECORDINGS.get_or_init(dashmap::DashMap::new)
}
#[napi]
pub fn continuous_create(
    request: String,
    read: ThreadsafeFunction<String, Promise<Buffer>>,
    write: ThreadsafeFunction<(Buffer, String), Promise<()>>,
    resolve: ThreadsafeFunction<String, Promise<KeyReply>>,
    abort: ThreadsafeFunction<String>,
    control: ThreadsafeFunction<String, Promise<String>>,
) -> String {
    let host = Arc::new(Host {
        read: Arc::new(read),
        resolve: Arc::new(resolve),
        abort,
        start: Instant::now(),
    });
    let output = Arc::new(TimelineOutputHost {
        control: Arc::new(control),
        write: Arc::new(write),
    });
    match wire::continuous::Bridge::new(&request, host, output) {
        Ok(bridge) => {
            let id = uuid::Uuid::new_v4().to_string();
            recordings().insert(id.clone(), Arc::new(bridge));
            serde_json::json!({"id":id}).to_string()
        }
        Err(e) => e.to_string(),
    }
}
#[napi]
pub async fn continuous_command(id: String, command: String) -> String {
    let bridge = recordings().get(&id).map(|b| b.clone());
    match bridge {
        Some(b) => b.command(&command).await.to_string(),
        None => wire::error("RECORDING_FAILED", "Closed").to_string(),
    }
}
#[napi]
pub async fn continuous_run(id: String) -> napi::Result<String> {
    let bridge = recordings()
        .get(&id)
        .map(|b| b.clone())
        .ok_or_else(|| napi::Error::from_reason("recording closed"))?;
    let result = tokio::task::spawn_blocking(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map(|rt| rt.block_on(bridge.run()).to_string())
            .map_err(|_| napi::Error::from_reason("recording executor failed"))
    })
    .await
    .map_err(|_| napi::Error::from_reason("recording worker failed"));
    recordings().remove(&id);
    result?
}
