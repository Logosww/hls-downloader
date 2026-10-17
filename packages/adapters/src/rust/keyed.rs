//! Versioned, sensitive-data-free keyed host contract shared by N-API and WASM.
use hls_engine::legacy::Error;
use hls_engine::*;
use hls_engine::{
    crypto::{key::*, resource::*},
    playlist::*,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

#[path = "continuous.rs"]
pub mod continuous;
#[path = "multitrack.rs"]
pub mod multitrack;
#[path = "subtitle.rs"]
pub mod subtitle;
#[path = "timeline.rs"]
pub mod timeline;

pub type ReadFuture = Pin<Box<dyn Future<Output = hls_engine::legacy::Result<Vec<u8>>> + Send>>;
pub trait Host: Send + Sync {
    fn read(&self, request: String) -> ReadFuture;
    fn resolve(&self, request: String) -> KeyFuture<Reply>;
    fn abort(&self, id: String);
    fn now(&self) -> u64;
}
pub struct Reply {
    pub status: String,
    pub key: Vec<u8>,
    pub version: Option<String>,
    pub ttl: Option<u64>,
}
#[derive(Deserialize)]
pub struct Snapshot {
    pub url: String,
    pub text: String,
}
fn default_samples() -> usize {
    65536
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(default = "default_samples")]
    pub samples: usize,
    pub resource_bytes: u64,
    pub waiting_bytes: u64,
    pub resources: usize,
    pub key_requests: usize,
    pub cached_keys: usize,
    pub key_waiters: usize,
}
#[derive(Deserialize)]
pub struct Format {
    pub format: String,
    pub versions: Vec<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub wire_version: u32,
    pub operation_id: String,
    pub scope: String,
    pub limits: Limits,
    pub key_formats: Vec<Format>,
    pub encrypted_ranges: String,
    #[serde(default)]
    pub experimental_gcm: bool,
}
fn location(l: &SourceLocation) -> String {
    match l {
        SourceLocation::Url(u) => u.to_string(),
        _ => String::new(),
    }
}
pub fn parse(s: &Snapshot, id: &str) -> std::result::Result<PlaylistSnapshot, Value> {
    let url = url::Url::parse(&s.url).map_err(|_| error("MANIFEST_INVALID", "url"))?;
    parse_playlist_snapshot(
        &TextResource {
            content: s.text.clone(),
            location: SourceLocation::Url(url),
        },
        PlaylistContext::new(InputId::new(id).unwrap(), 0),
    )
    .map_err(|_| error("MANIFEST_INVALID", "playlist"))
}
pub fn error(code: &str, reason: &str) -> Value {
    json!({"error":{"code":code,"reason":reason}})
}
fn key_request(r: &KeyRequest) -> String {
    let s = r.resource().slot();
    let k = r.reference();
    json!({"requestId":format!("key:{}",r.resolve_revision()),"operationId":r.operation(),"inputId":s.input_id().as_str(),"resourceKind":if r.resource().kind()==KeyResourceKind::Map {"map"} else {"media"},"uri":location(k.location().location()),"method":k.method().as_str(),"kid":r.resource().kid().map(|k|k.iter().map(|b|format!("{b:02x}")).collect::<String>()),"keyFormat":k.format(),"keyFormatVersions":k.versions(),"originalSequence":s.sequence().to_string(),"epoch":s.epoch().to_string(),"generation":s.generation().to_string(),"declaration":{"revision":k.declaration().revision().to_string(),"ordinal":k.declaration().ordinal().to_string()},"resolveRevision":r.resolve_revision().to_string(),"refreshGeneration":r.refresh_generation().to_string(),"refreshReason":format!("{:?}",r.refresh_reason())}).to_string()
}
struct Provider(Arc<dyn Host>);
fn provider_failure(kind: ProviderFailureKind) -> KeyResolution {
    KeyResolution::Failure(ProviderFailure::new(
        kind,
        Arc::new(std::io::Error::other("key provider failed")),
    ))
}
impl KeyProvider for Provider {
    fn resolve(&self, r: KeyRequest) -> KeyFuture<KeyResolution> {
        let host = self.0.clone();
        let future = host.resolve(key_request(&r));
        Box::pin(async move {
            let reply = future.await;
            match reply.status.as_str() {
                "unavailable" => KeyResolution::Unavailable,
                "available" => {
                    let secret = if *r.reference().method() == EncryptionMethod::Aes256Gcm {
                        SecretKey::aes256(reply.key)
                    } else {
                        SecretKey::new(reply.key)
                    };
                    let Ok(secret) = secret else {
                        return provider_failure(ProviderFailureKind::InvalidResponse);
                    };
                    let mut key = match r.reference().method() {
                        EncryptionMethod::Aes256Gcm => AvailableKey::aes256_gcm(secret),
                        EncryptionMethod::Aes128 => AvailableKey::aes128(secret),
                        EncryptionMethod::SampleAes => AvailableKey::sample_aes(secret),
                        EncryptionMethod::SampleAesCtr => AvailableKey::sample_aes_ctr(secret),
                        _ => return KeyResolution::Unavailable,
                    };
                    if let Some(kid) = r.resource().kid() {
                        key = key.with_kid(kid);
                    }
                    if let Some(version) = reply.version {
                        key = key.with_version(version);
                    }
                    if let Some(ttl) = reply.ttl {
                        let Some(deadline) = host.now().checked_add(ttl) else {
                            return provider_failure(ProviderFailureKind::InvalidResponse);
                        };
                        key = key.with_valid_until(deadline);
                    }
                    KeyResolution::Available(key)
                }
                "invalid" => provider_failure(ProviderFailureKind::InvalidResponse),
                _ => provider_failure(ProviderFailureKind::Transport),
            }
        })
    }
    fn abort(&self, r: &KeyRequest) {
        self.0.abort(format!("key:{}", r.resolve_revision()));
    }
}
struct Clock(Arc<dyn Host>);
impl KeyClock for Clock {
    fn now(&self) -> u64 {
        self.0.now()
    }
}
struct SourceHost {
    host: Arc<dyn Host>,
    cap: u64,
    ids: Mutex<Vec<String>>,
    next: Arc<AtomicU32>,
}
impl std::fmt::Debug for SourceHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KeyedSource")
    }
}
struct Lease {
    host: Arc<dyn Host>,
    id: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.host.abort(self.id.clone())
    }
}
impl Source for SourceHost {
    fn create_session_with_options(&self, o: &SourceSessionOptions) -> Option<Arc<dyn Source>> {
        Some(Arc::new(Self {
            host: self.host.clone(),
            cap: o.max_resource_bytes().unwrap_or(self.cap),
            ids: Mutex::new(Vec::new()),
            next: self.next.clone(),
        }))
    }
    fn stop_session(&self) {
        let ids = std::mem::take(&mut *self.ids.lock().unwrap());
        for id in ids {
            self.host.abort(id)
        }
    }
    fn read_text<'a>(
        &'a self,
        _: &'a SourceLocation,
    ) -> Pin<Box<dyn Future<Output = hls_engine::legacy::Result<TextResource>> + Send + 'a>> {
        Box::pin(async { Err(Error::invalid("snapshot only")) })
    }
    fn read_bytes<'a>(
        &'a self,
        l: &'a SourceLocation,
        r: Option<&'a ByteRange>,
    ) -> Pin<Box<dyn Future<Output = hls_engine::legacy::Result<Vec<u8>>> + Send + 'a>> {
        let id = format!("read:{}", self.next.fetch_add(1, Ordering::Relaxed));
        self.ids.lock().unwrap().push(id.clone());
        let lease = Lease {
            host: self.host.clone(),
            id: id.clone(),
        };
        let future=self.host.read(json!({"requestId":id,"url":location(l),"offset":r.map(|r|r.offset.to_string()),"length":r.map(|r|r.length.to_string()),"maxBytes":self.cap.to_string()}).to_string());
        Box::pin(async move {
            let result = future.await;
            self.ids.lock().unwrap().retain(|i| i != &lease.id);
            drop(lease);
            result
        })
    }
}
impl Drop for SourceHost {
    fn drop(&mut self) {
        self.stop_session()
    }
}
fn keys(k: &KeyContext) -> Value {
    json!(k.candidates().iter().map(|k|json!({"method":k.method().as_str(),"uri":location(k.location().location()),"keyFormat":k.format(),"keyFormatVersions":k.versions(),"iv":k.explicit_iv().map(|iv|iv.iter().map(|b|format!("{b:02x}")).collect::<String>()),"declaration":{"revision":k.declaration().revision().to_string(),"ordinal":k.declaration().ordinal().to_string()}})).collect::<Vec<_>>())
}
fn range(r: Option<ResourceRange>) -> Value {
    r.map(|r| json!({"offset":r.offset().to_string(),"length":r.length().to_string()}))
        .unwrap_or(Value::Null)
}
pub fn metadata(text: String, url: String) -> String {
    match parse(&Snapshot{text,url},"primary") {
        Err(e)=>e.to_string(), Ok(s)=>json!({"version":1,"url":location(s.location().location()),"inputId":s.context().input_id().as_str(),"generation":s.context().generation().to_string(),"revision":s.context().revision().to_string(),"hlsVersion":s.version().map(|v|v.to_string()),"targetDuration":s.target_duration().map(|v|v.to_string()),"playlistType":s.playlist_type().map(|v|format!("{v:?}")),"independentSegments":s.independent_segments(),"iframeOnly":s.iframe_only(),"retainedTags":s.retained_tags().iter().map(|t|t.text()).collect::<Vec<_>>(),"mediaSequence":s.media_sequence().to_string(),"discontinuitySequence":s.discontinuity_sequence().to_string(),"endList":s.end_list(),"segments":s.segments().iter().map(|s|json!({"originalSequence":s.slot().sequence().to_string(),"epoch":s.slot().epoch().to_string(),"uri":location(s.location().location()),"range":range(s.range()),"duration":{"ticks":s.duration().ticks().to_string(),"timescale":s.duration().timescale()},"keys":keys(s.keys()),"map":s.map().map(|m|json!({"uri":location(m.location().location()),"range":range(m.range()),"keys":keys(m.keys())})),"gap":s.gap(),"discontinuity":s.discontinuity(),"programDateTime":s.program_date_time()})).collect::<Vec<_>>()}).to_string()
    }
}

#[path = "capability.rs"]
pub mod capability;

#[cfg(not(target_arch = "wasm32"))]
#[path = "recovery.rs"]
pub mod recovery;
