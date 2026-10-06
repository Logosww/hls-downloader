//! Shared timeline contract. No transport/provider causes cross this boundary.
use super::*;
use hls_transmux::crypto::sample::{SampleError, SampleErrorKind};
use std::task::{Context, Poll};
use tokio::io::AsyncWrite;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub range: Option<PresentationRange>,
    pub gap_policy: Option<String>,
    pub change_policy: Option<String>,
    #[serde(default)]
    pub epoch_anchors: Vec<Anchor>,
    pub limits: Option<Planning>,
    pub tail_duration: Option<MediaTime>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Anchor {
    input_id: String,
    epoch: String,
    source: MediaTime,
    presentation: MediaTime,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Planning {
    samples: Option<usize>,
    resources: Option<usize>,
}
impl Selection {
    fn options(&self) -> std::result::Result<TimelinePrepareOptions, Value> {
        let mut o = TimelinePrepareOptions::default();
        if let Some(range) = self.range {
            o = o.with_range(range);
        }
        o = o
            .with_gap_policy(match self.gap_policy.as_deref().unwrap_or("preserve") {
                "preserve" => GapPolicy::Preserve,
                "collapse" => GapPolicy::Collapse,
                _ => return Err(error("TIMELINE_FAILED", "InvalidOptions")),
            })
            .with_change_policy(match self.change_policy.as_deref().unwrap_or("fail") {
                "fail" => TimelineChangePolicy::Fail,
                "split" => TimelineChangePolicy::Split,
                _ => return Err(error("TIMELINE_FAILED", "InvalidOptions")),
            });
        if let Some(l) = &self.limits {
            o = o.with_planning_limits(
                TimelinePlanningLimits::new(
                    l.samples.unwrap_or(65536),
                    l.resources.unwrap_or(4096),
                )
                .map_err(failure)?,
            );
        }
        if let Some(t) = self.tail_duration {
            o = o.with_tail_duration(TailDurationPolicy::Explicit(t));
        }
        for a in &self.epoch_anchors {
            let epoch = a
                .epoch
                .parse::<u64>()
                .map_err(|_| error("TIMELINE_FAILED", "InvalidOptions"))?;
            if epoch.to_string() != a.epoch || !matches!(a.input_id.as_str(), "primary" | "audio") {
                return Err(error("TIMELINE_FAILED", "InvalidOptions"));
            }
            o = o.with_epoch_anchor(EpochAnchor::new(
                InputId::new(&a.input_id)
                    .map_err(|_| error("TIMELINE_FAILED", "InvalidOptions"))?,
                epoch,
                a.source,
                a.presentation,
            ));
        }
        Ok(o)
    }
}
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
        ResourceErrorKind::Decrypt => "DECRYPT_FAILED",
        ResourceErrorKind::MediaValidation => "MEDIA_INVALID",
        _ => "UNSUPPORTED_ENCRYPTION",
    }
}
pub fn failure(e: TimelineSessionError) -> Value {
    let code = if let Some(s) = e.sample_error() {
        sample_code(s)
    } else if let Some(r) = e.resource_error() {
        resource_code(r)
    } else {
        match e.kind() {
            TimelineErrorKind::InvalidRange
            | TimelineErrorKind::OutOfBounds
            | TimelineErrorKind::EmptyRange
            | TimelineErrorKind::NoRandomAccessPoint => "RANGE_INVALID",
            TimelineErrorKind::ResourceChanged => "RESOURCE_CHANGED",
            TimelineErrorKind::PlanningBudgetExceeded => "RESOURCE_LIMIT_EXCEEDED",
            TimelineErrorKind::Output => "OUTPUT_WRITE_FAILED",
            TimelineErrorKind::Cancelled => "ABORTED",
            TimelineErrorKind::Media => "MEDIA_INVALID",
            _ => "TIMELINE_FAILED",
        }
    };
    let slot = e.sample_error().map(|s| s.resource().slot()).or(e.slot());
    json!({"error":{"code":code,"reason":format!("{:?}",e.kind()),"phase":"timeline","inputId":slot.map(|s|s.input_id().as_str()),"epoch":slot.map(|s|s.epoch().to_string()),"originalSequence":slot.map(|s|s.sequence().to_string()),"trackId":e.sample_error().and_then(|s|s.track_id()),"sampleIndex":e.sample_error().and_then(|s|s.sample_index()).map(|s|s.to_string()),"scheme":e.sample_error().and_then(|s|s.scheme()),"completedOutputs":e.completed_outputs()}})
}
fn report(r: TimelineSessionReport) -> Value {
    let total: usize = r.outputs().iter().map(|o| o.media().segment_count).sum();
    let mut v = serde_json::to_value(&r).unwrap();
    v["preroll"] = json!(r.preroll().ok().flatten());
    v["postroll"] = json!(r.postroll().ok().flatten());
    json!({"totalSegments":total,"timelineReport":v})
}
pub type OutputFuture<T> = Pin<Box<dyn Future<Output = std::io::Result<T>>>>;
pub trait OutputHost: Send + Sync {
    fn control(&self, value: String) -> OutputFuture<String>;
    fn write(&self, index: String, bytes: Vec<u8>) -> OutputFuture<()>;
}
fn descriptor(r: &TimelineOutputRequest) -> Value {
    json!({"index":r.index().to_string(),"actualRange":r.presentation_range(),"reason":format!("{:?}",r.reason()),"tracks":r.tracks().iter().map(|t|json!({"codec":format!("{:?}",t.codec),"timescale":t.timescale,"duration":t.duration.to_string(),"sampleCount":t.sample_count.to_string()})).collect::<Vec<_>>()})
}
struct Outputs {
    host: Arc<dyn OutputHost>,
    completed: Arc<Mutex<Vec<usize>>>,
    descriptors: Arc<Mutex<Vec<Value>>>,
}
impl Clone for Outputs {
    fn clone(&self) -> Self {
        Self {
            host: self.host.clone(),
            completed: self.completed.clone(),
            descriptors: self.descriptors.clone(),
        }
    }
}
impl Outputs {
    async fn drain(&self) -> std::io::Result<()> {
        let completed = std::mem::take(&mut *self.completed.lock().unwrap());
        for index in completed {
            let output = self
                .descriptors
                .lock()
                .unwrap()
                .get(index)
                .cloned()
                .ok_or_else(|| std::io::Error::other("unknown output"))?;
            self.host
                .control(json!({"action":"complete","output":output}).to_string())
                .await?;
        }
        Ok(())
    }
    async fn acquire_output(&self, r: &TimelineOutputRequest) -> TimelineResult<String> {
        self.drain()
            .await
            .map_err(|e| TimelineSessionError::output(Error::from(e)))?;
        let output = descriptor(r);
        self.descriptors.lock().unwrap().push(output.clone());
        self.host
            .control(json!({"action":"acquire","output":output}).to_string())
            .await
            .map_err(|e| TimelineSessionError::output(Error::from(e)))
    }
}
struct Writer {
    outputs: Outputs,
    index: String,
    pending: Option<OutputFuture<usize>>,
}
impl AsyncWrite for Writer {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.pending.is_none() {
            let outputs = self.outputs.clone();
            let index = self.index.clone();
            let bytes = bytes.to_vec();
            let len = bytes.len();
            self.pending = Some(Box::pin(async move {
                outputs.drain().await?;
                outputs.host.write(index, bytes).await?;
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
impl TimelineWriterProvider for Outputs {
    type Writer = Writer;
    fn acquire<'a>(
        &'a mut self,
        r: TimelineOutputRequest,
    ) -> Pin<Box<dyn Future<Output = TimelineResult<Writer>> + 'a>> {
        Box::pin(async move {
            self.acquire_output(&r).await?;
            Ok(Writer {
                outputs: self.clone(),
                index: r.index().to_string(),
                pending: None,
            })
        })
    }
}
#[cfg(not(target_arch = "wasm32"))]
impl TimelineFileProvider for Outputs {
    fn acquire<'a>(
        &'a mut self,
        r: TimelineOutputRequest,
    ) -> Pin<Box<dyn Future<Output = TimelineResult<std::path::PathBuf>> + 'a>> {
        Box::pin(async move { Ok(std::path::PathBuf::from(self.acquire_output(&r).await?)) })
    }
}
pub async fn run(
    r: &Request,
    host: Arc<dyn Host>,
    output: Arc<dyn OutputHost>,
    cancel: Option<Arc<dyn CancelToken>>,
) -> Value {
    if r.wire_version != 3 {
        return error("BRIDGE_VERSION_MISMATCH", "wireVersion");
    }
    let result = async {
        let selection = r
            .timeline
            .as_ref()
            .ok_or_else(|| error("TIMELINE_FAILED", "MissingOptions"))?;
        if selection.change_policy.as_deref() == Some("split") && !r.mode.ends_with("-outputs") {
            return Err(error("UNSUPPORTED_OUTPUT", "SplitRequiresProvider"));
        }
        let mut outputs = Outputs {
            host: output,
            completed: Arc::new(Mutex::new(Vec::new())),
            descriptors: Arc::new(Mutex::new(Vec::new())),
        };
        let completed = outputs.completed.clone();
        let mut options = selection.options()?.with_on_event(Arc::new(move |e| {
            if e.kind() == TimelineEventKind::OutputCompleted {
                completed.lock().unwrap().push(e.output_index());
            }
        }));
        if let Some(c) = cancel {
            options = options.with_cancel(c);
        }
        let source = Arc::new(SourceHost {
            host: host.clone(),
            cap: r.limits.resource_bytes,
            ids: Mutex::new(Vec::new()),
            next: Arc::new(AtomicU32::new(1)),
        });
        let mut inputs = KeyedInputs::new(KeyedInput::new(
            parse(&r.primary, "primary")?,
            source.clone(),
        ));
        if let Some(a) = &r.audio {
            inputs = inputs.with_audio(KeyedInput::new(parse(a, "audio")?, source));
        }
        let keys = KeySession::new(
            r.operation_id.clone(),
            r.scope.clone(),
            Arc::new(Provider(host.clone())),
            Arc::new(Clock(host)),
            KeySessionOptions::default()
                .with_limits(
                    r.limits.key_requests,
                    r.limits.cached_keys,
                    r.limits.key_waiters,
                )
                .with_formats(
                    r.key_formats
                        .iter()
                        .map(|f| KeyFormatSupport::new(&f.format, f.versions.clone()))
                        .collect(),
                ),
        )
        .map_err(|_| error("KEY_INVALID", "options"))?;
        let resources = ResourceOptions::default()
            .with_sample_limit(r.limits.samples)
            .with_limits(
                r.limits.resource_bytes,
                r.limits.waiting_bytes,
                r.limits.resources,
            )
            .with_encrypted_ranges(if r.encrypted_ranges == "complete-resources" {
                EncryptedRangePolicy::CompleteResources
            } else {
                EncryptedRangePolicy::Reject
            });
        let session = prepare_hls_timeline(inputs, keys, options.with_resources(resources))
            .await
            .map_err(failure)?;
        if r.mode == "bytes" || r.mode == "bytes-outputs" {
            // Collect atomically: no public output is acquired until every classic output succeeds.
            outputs.completed.lock().unwrap().clear();
            let (bytes, report) = session.into_mp4_outputs().await.map_err(failure)?;
            outputs.completed.lock().unwrap().clear();
            for (i, b) in bytes.into_iter().enumerate() {
                outputs
                    .host
                    .write(i.to_string(), b)
                    .await
                    .map_err(|_| error("OUTPUT_WRITE_FAILED", "write"))?;
            }
            return Ok(self::report(report));
        }
        #[cfg(not(target_arch = "wasm32"))]
        let result = if r.mode == "file" || r.mode == "file-outputs" {
            session
                .write_to_files(&mut outputs, FileOutputOptions::default())
                .await
        } else {
            session.write_to_outputs(&mut outputs).await
        };
        #[cfg(target_arch = "wasm32")]
        let result = session.write_to_outputs(&mut outputs).await;
        let close = outputs.drain().await;
        let report = result.map_err(failure)?;
        close.map_err(|_| error("OUTPUT_WRITE_FAILED", "close"))?;
        Ok(self::report(report))
    }
    .await;
    result.unwrap_or_else(|e| e)
}
