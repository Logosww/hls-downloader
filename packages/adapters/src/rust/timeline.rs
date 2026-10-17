use super::*;
use hls_engine::crypto::sample::{SampleError, SampleErrorKind};
fn key_code(e: &KeyError) -> &'static str {
    match e.kind() {
        KeyErrorKind::Unavailable => "KEY_UNAVAILABLE",
        KeyErrorKind::InvalidKey => "KEY_INVALID",
        KeyErrorKind::Expired => "KEY_EXPIRED",
        KeyErrorKind::Provider
            if e.provider_failure()
                .is_some_and(|p| p.kind() == ProviderFailureKind::InvalidResponse) =>
        {
            "KEY_INVALID"
        }
        KeyErrorKind::Provider => "KEY_RESOLUTION_FAILED",
        KeyErrorKind::Cancelled => "ABORTED",
        KeyErrorKind::BudgetExceeded => "RESOURCE_LIMIT_EXCEEDED",
        KeyErrorKind::ConflictingMetadata => "ENCRYPTION_INVALID",
        _ => "UNSUPPORTED_ENCRYPTION",
    }
}
pub fn sample_code(e: &SampleError) -> &'static str {
    if let Some(k) = e.key_error() {
        return key_code(k);
    }
    match e.kind() {
        SampleErrorKind::Unsupported => "UNSUPPORTED_ENCRYPTION",
        SampleErrorKind::InvalidMetadata => "ENCRYPTION_INVALID",
        SampleErrorKind::Key => "KEY_RESOLUTION_FAILED",
        SampleErrorKind::Decrypt => "DECRYPT_FAILED",
        SampleErrorKind::BudgetExceeded => "RESOURCE_LIMIT_EXCEEDED",
        SampleErrorKind::Cancelled => "ABORTED",
        _ => "MEDIA_INVALID",
    }
}
pub fn resource_code(e: &ResourceError) -> &'static str {
    if let Some(k) = e.key_error() {
        return key_code(k);
    }
    match e.kind() {
        ResourceErrorKind::Read => "SEGMENT_FETCH_FAILED",
        ResourceErrorKind::ResourceTooLarge | ResourceErrorKind::BudgetExceeded => {
            "RESOURCE_LIMIT_EXCEEDED"
        }
        ResourceErrorKind::Cancelled => "ABORTED",
        ResourceErrorKind::InvalidIv | ResourceErrorKind::InvalidCiphertextLength => {
            "ENCRYPTION_INVALID"
        }
        ResourceErrorKind::AuthenticationFailed => "AUTHENTICATION_FAILED",
        ResourceErrorKind::Decrypt => "DECRYPT_FAILED",
        ResourceErrorKind::MediaValidation => "MEDIA_INVALID",
        _ => "UNSUPPORTED_ENCRYPTION",
    }
}
#[cfg(target_arch = "wasm32")]
pub type OutputFuture<T> = Pin<Box<dyn Future<Output = std::io::Result<T>>>>;
#[cfg(not(target_arch = "wasm32"))]
pub type OutputFuture<T> = Pin<Box<dyn Future<Output = std::io::Result<T>> + Send>>;
pub trait OutputHost: Send + Sync {
    fn control(&self, value: String) -> OutputFuture<String>;
    fn write(&self, index: String, bytes: Vec<u8>) -> OutputFuture<()>;
}
