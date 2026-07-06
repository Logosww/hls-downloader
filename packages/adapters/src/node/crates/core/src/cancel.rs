use std::future::Future;
use std::pin::Pin;

use hls_transmux::CancelToken;

/// Cooperative cancellation token bridging napi `AbortSignal` to the
/// `hls-transmux` pipeline.
///
/// Wraps `tokio_util::sync::CancellationToken` and implements
/// `hls_transmux::CancelToken` so it can be threaded into `TransmuxOptions`.
#[derive(Debug, Clone, Default)]
pub struct JobCancelToken {
    token: tokio_util::sync::CancellationToken,
}

impl JobCancelToken {
    pub fn new() -> Self {
        Self {
            token: tokio_util::sync::CancellationToken::new(),
        }
    }

    pub fn cancel(&self) {
        self.token.cancel();
    }
}

impl CancelToken for JobCancelToken {
    fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            self.token.cancelled().await;
        })
    }
}
