//! Continuous bridge: bounded ordered events and independently callable controls.
use super::multitrack::{Selection, Session};
use super::timeline::{OutputFuture, OutputHost};
use super::*;
use std::{
    collections::VecDeque,
    task::{Context, Poll},
};
use tokio::io::AsyncWrite;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budgets {
    queued_descriptors: Option<usize>,
    queued_metadata_bytes: Option<usize>,
    history_entries: Option<usize>,
    samples: Option<usize>,
    sample_bytes: Option<usize>,
    probe_segments: Option<usize>,
    max_skew: Option<MediaTime>,
    input_timeout_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Anchor {
    input_id: String,
    generation: String,
    epoch: String,
    source: MediaTime,
    presentation: MediaTime,
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Timeline {
    range: Option<PresentationRange>,
    gap_policy: Option<String>,
    change_policy: Option<String>,
    tail_duration: Option<MediaTime>,
    #[serde(default)]
    anchors: Vec<Anchor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    bridge_version: u32,
    #[serde(flatten)]
    keyed: super::Request,
    recording: Options,
    multitrack: Option<Selection>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    vod: bool,
    output_type: String,
    format: String,
    max_bytes: Option<usize>,
    duration_limit: Option<MediaTime>,
    missing_segments: Option<String>,
    #[serde(default)]
    limits: Budgets,
    #[serde(default)]
    timeline: Timeline,
}
pub fn failure(e: ContinuousError) -> Value {
    let code = if let Some(e) = e.sample_error() {
        timeline::sample_code(e)
    } else if let Some(e) = e.resource_error() {
        timeline::resource_code(e)
    } else {
        match e.kind() {
            ContinuousErrorKind::Cancelled => "ABORTED",
            ContinuousErrorKind::Output => "OUTPUT_WRITE_FAILED",
            ContinuousErrorKind::BudgetExceeded | ContinuousErrorKind::QueueLimit => {
                "RESOURCE_LIMIT_EXCEEDED"
            }
            ContinuousErrorKind::InputRewrite => "RESOURCE_CHANGED",
            ContinuousErrorKind::Media => "MEDIA_INVALID",
            ContinuousErrorKind::InvalidSubtitle | ContinuousErrorKind::MissingSubtitleMapping => {
                "SUBTITLE_INVALID"
            }
            ContinuousErrorKind::UnsupportedSubtitleProfile => "UNSUPPORTED_RENDITION",
            _ => "RECORDING_FAILED",
        }
    };
    json!({"error":{"code":code,"reason":format!("{:?}",e.kind()),"phase":"recording",
        "inputId":e.slot().map(|s|s.input_id().as_str()),"epoch":e.slot().map(|s|s.epoch().to_string()),
        "originalSequence":e.slot().map(|s|s.sequence().to_string()),"completedRecordingOutputs":e.completed_outputs()}})
}
fn invalid() -> Value {
    error("RECORDING_FAILED", "InvalidOptions")
}
fn uint(s: &str) -> std::result::Result<u64, Value> {
    let n = s.parse::<u64>().map_err(|_| invalid())?;
    if n.to_string() != s {
        return Err(invalid());
    }
    Ok(n)
}
fn event(e: ContinuousEvent) -> Value {
    match e {
        ContinuousEvent::State(s) => {
            json!({"type":"state","state":format!("{s:?}").to_lowercase()})
        }
        ContinuousEvent::Mapping(m) => json!({"type":"mapping","mapping":m}),
        ContinuousEvent::Gap {
            slot,
            presentation_start,
            duration,
        } => {
            json!({"type":"gap","slot":slot,"presentationStart":presentation_start,"duration":duration})
        }
        ContinuousEvent::Committed { input, bytes } => {
            json!({"type":"progress","input":input,"bytesWritten":bytes.to_string()})
        }
        ContinuousEvent::Output(output) => json!({"type":"output","output":output}),
        _ => Value::Null,
    }
}
struct Events {
    queue: VecDeque<Value>,
    overflow: bool,
    playback_error: Option<Value>,
}
#[derive(Clone)]
struct Outputs {
    host: Arc<dyn OutputHost>,
    events: Arc<Mutex<Events>>,
    limit: usize,
    notify: Arc<tokio::sync::Notify>,
    drain_lock: Arc<tokio::sync::Mutex<()>>,
}
impl Outputs {
    async fn drain(&self) -> std::io::Result<()> {
        let _guard = self.drain_lock.lock().await;
        loop {
            let next = {
                let mut e = self.events.lock().unwrap();
                if e.overflow || e.playback_error.is_some() {
                    return Err(std::io::Error::other("recording event budget exceeded"));
                }
                e.queue.pop_front()
            };
            let Some(e) = next else { return Ok(()) };
            self.host
                .control(json!({"action":"event","event":e}).to_string())
                .await?;
        }
    }
    async fn acquire_output(&self, request: ContinuousOutputRequest) -> ContinuousResult<String> {
        self.drain()
            .await
            .map_err(|e| ContinuousError::output(e.into()))?;
        let output = json!({"index":request.index().to_string(),"tracks":request.tracks().iter().map(|t|json!({"codec":format!("{:?}",t.codec),"timescale":t.timescale,"duration":t.duration.to_string(),"sampleCount":t.sample_count.to_string()})).collect::<Vec<_>>()});
        self.host
            .control(json!({"action":"acquire","output":output}).to_string())
            .await
            .map_err(|e| ContinuousError::output(e.into()))
    }
}
struct Writer {
    output: Outputs,
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
            let o = self.output.clone();
            let index = self.index.clone();
            let bytes = bytes.to_vec();
            let len = bytes.len();
            self.pending = Some(Box::pin(async move {
                o.drain().await?;
                o.host.write(index, bytes).await?;
                Ok(len)
            }));
        }
        let r = self.pending.as_mut().unwrap().as_mut().poll(cx);
        if r.is_ready() {
            self.pending = None;
        }
        r
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
impl ContinuousWriterProvider for Outputs {
    type Writer = Writer;
    fn acquire<'a>(
        &'a mut self,
        r: ContinuousOutputRequest,
    ) -> Pin<Box<dyn Future<Output = ContinuousResult<Writer>> + 'a>> {
        Box::pin(async move {
            let index = r.index().to_string();
            self.acquire_output(r).await?;
            Ok(Writer {
                output: self.clone(),
                index,
                pending: None,
            })
        })
    }
}
#[cfg(not(target_arch = "wasm32"))]
impl ContinuousFileProvider for Outputs {
    fn acquire<'a>(
        &'a mut self,
        r: ContinuousOutputRequest,
    ) -> Pin<Box<dyn Future<Output = ContinuousResult<std::path::PathBuf>> + 'a>> {
        Box::pin(async move { Ok(self.acquire_output(r).await?.into()) })
    }
}
struct Waiter {
    #[cfg(target_arch = "wasm32")]
    host: Arc<dyn OutputHost>,
}
impl ContinuousWait for Waiter {
    #[cfg(not(target_arch = "wasm32"))]
    fn wait(&self, d: std::time::Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(tokio::time::sleep(d))
    }
    #[cfg(target_arch = "wasm32")]
    fn wait(&self, d: std::time::Duration) -> Pin<Box<dyn Future<Output = ()> + '_>> {
        Box::pin(async move {
            let _ = self
                .host
                .control(json!({"action":"wait","ms":d.as_millis().to_string()}).to_string())
                .await;
        })
    }
}
pub struct Bridge {
    pub handle: ContinuousHandle,
    session: Mutex<Option<Session>>,
    multi: Option<MultiTrackHandle>,
    output: Outputs,
    kind: String,
    format: OutputFormat,
    capacity: usize,
    wake: Mutex<Option<std::task::Waker>>,
    hold: std::sync::atomic::AtomicBool,
}
impl Bridge {
    pub fn new(
        text: &str,
        host: Arc<dyn Host>,
        output: Arc<dyn OutputHost>,
    ) -> std::result::Result<Self, Value> {
        let r: Request = serde_json::from_str(text).map_err(|_| invalid())?;
        if r.bridge_version != if r.multitrack.is_some() { 2 } else { 1 } {
            return Err(error("BRIDGE_VERSION_MISMATCH", "wireVersion"));
        }
        let k = &r.keyed;
        let o = &r.recording;
        let b = &o.limits;
        let outputs = Outputs {
            host: output,
            events: Arc::new(Mutex::new(Events {
                queue: VecDeque::new(),
                overflow: false,
                playback_error: None,
            })),
            limit: b
                .history_entries
                .unwrap_or(128)
                .saturating_mul(4)
                .saturating_add(16),
            notify: Arc::new(tokio::sync::Notify::new()),
            drain_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let event_output = outputs.clone();
        let playback = r.multitrack.clone();
        let playback_kind = o.output_type.clone();
        let playback_format = o.format.clone();
        let playback_capacity = o.max_bytes;
        let playback_preserves_gaps = o.timeline.gap_policy.as_deref() != Some("collapse");
        let mut options = ContinuousOptions::default()
            .with_mode(if o.vod {
                ContinuousMode::Vod
            } else {
                ContinuousMode::Open
            })
            .with_limits(
                ContinuousLimits::default()
                    .with_queue(
                        b.queued_descriptors.unwrap_or(128),
                        b.queued_metadata_bytes.unwrap_or(4 * 1024 * 1024),
                    )
                    .with_history(b.history_entries.unwrap_or(128))
                    .with_samples(
                        b.samples.unwrap_or(65536),
                        b.sample_bytes.unwrap_or(64 * 1024 * 1024),
                    )
                    .with_probe_segments(b.probe_segments.unwrap_or(2))
                    .with_max_skew(b.max_skew.unwrap_or(MediaTime::new(30, 1).unwrap())),
            )
            .with_resources(
                ResourceOptions::default()
                    .with_sample_limit(k.limits.samples)
                    .with_limits(
                        k.limits.resource_bytes,
                        k.limits.waiting_bytes,
                        k.limits.resources,
                    )
                    .with_encrypted_ranges(if k.encrypted_ranges == "complete-resources" {
                        EncryptedRangePolicy::CompleteResources
                    } else {
                        EncryptedRangePolicy::Reject
                    }),
            )
            .with_missing_segments(match o.missing_segments.as_deref().unwrap_or("fail") {
                "fail" => MissingSegmentPolicy::Fail,
                "skip" => MissingSegmentPolicy::Skip,
                "split" => MissingSegmentPolicy::Split,
                _ => return Err(invalid()),
            })
            .with_gap_policy(
                match o.timeline.gap_policy.as_deref().unwrap_or("preserve") {
                    "preserve" => GapPolicy::Preserve,
                    "collapse" => GapPolicy::Collapse,
                    _ => return Err(invalid()),
                },
            )
            .with_change_policy(
                match o.timeline.change_policy.as_deref().unwrap_or("fail") {
                    "fail" => TimelineChangePolicy::Fail,
                    "split" => TimelineChangePolicy::Split,
                    _ => return Err(invalid()),
                },
            )
            .with_on_event(Arc::new(move |e| {
                if let Some(error) = playback
                    .as_ref()
                    .filter(|_| {
                        playback_preserves_gaps && matches!(&e, ContinuousEvent::Gap { .. })
                    })
                    .and_then(|selection| {
                        selection
                            .check_playback(
                                &playback_kind,
                                &playback_format,
                                playback_capacity,
                                true,
                            )
                            .err()
                    })
                {
                    event_output.events.lock().unwrap().playback_error = Some(error);
                }
                let value = event(e);
                if value.is_null() {
                    return;
                }
                let mut q = event_output.events.lock().unwrap();
                if q.queue.len() >= event_output.limit {
                    q.overflow = true;
                } else {
                    q.queue.push_back(value);
                }
                event_output.notify.notify_one();
            }));
        if let Some(t) = o.duration_limit {
            options = options.with_duration_limit(t);
        }
        if let Some(t) = o.timeline.range {
            options = options.with_range(t);
        }
        if let Some(t) = o.timeline.tail_duration {
            options = options.with_tail_policy(TailDurationPolicy::Explicit(t));
        }
        for a in &o.timeline.anchors {
            options = options.with_anchor(ContinuousAnchor::new(
                InputId::new(&a.input_id).map_err(|_| invalid())?,
                uint(&a.generation)?,
                uint(&a.epoch)?,
                a.source,
                a.presentation,
            ));
        }
        options = options.with_waiter(
            Arc::new(Waiter {
                #[cfg(target_arch = "wasm32")]
                host: outputs.host.clone(),
            }),
            std::time::Duration::from_millis(b.input_timeout_ms.unwrap_or(30000)),
        );
        let source = Arc::new(SourceHost {
            host: host.clone(),
            cap: k.limits.resource_bytes,
            ids: Mutex::new(Vec::new()),
            next: Arc::new(AtomicU32::new(1)),
        });
        let mut inputs = ContinuousInputs::new(ContinuousInput::new(
            InputId::new("primary").unwrap(),
            source.clone(),
        ));
        if k.audio.is_some() {
            inputs = inputs.with_audio(ContinuousInput::new(
                InputId::new("audio").unwrap(),
                source.clone(),
            ));
        }
        let keys = KeySession::new(
            k.operation_id.clone(),
            k.scope.clone(),
            Arc::new(Provider(host.clone())),
            Arc::new(Clock(host)),
            KeySessionOptions::default()
                .with_limits(
                    k.limits.key_requests,
                    k.limits.cached_keys,
                    k.limits.key_waiters,
                )
                .with_formats(
                    k.key_formats
                        .iter()
                        .map(|f| KeyFormatSupport::new(&f.format, f.versions.clone()))
                        .collect(),
                ),
        )
        .map_err(|_| error("KEY_INVALID", "options"))?;
        let session = if let Some(selection) = &r.multitrack {
            selection.check_playback(&o.output_type, &o.format, o.max_bytes, false)?;
            Session::Multi(selection.create(source.clone(), keys, options)?)
        } else {
            Session::Legacy(ContinuousSession::new(inputs, keys, options).map_err(failure)?)
        };
        let format = match o.format.as_str() {
            "mp4" => OutputFormat::Mp4,
            "fmp4" => OutputFormat::FragmentedMp4,
            _ => return Err(invalid()),
        };
        let (handle, multi) = session.handles();
        Ok(Self {
            handle,
            multi,
            session: Mutex::new(Some(session)),
            output: outputs,
            kind: o.output_type.clone(),
            format,
            capacity: o.max_bytes.unwrap_or(0),
            wake: Mutex::new(None),
            hold: std::sync::atomic::AtomicBool::new(false),
        })
    }
    pub async fn command(&self, text: &str) -> Value {
        let action = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v["action"].as_str().map(str::to_owned));
        if action.as_deref() == Some("pause") {
            self.hold.store(true, Ordering::SeqCst);
        }
        if matches!(action.as_deref(), Some("resume" | "stop" | "cancel")) {
            self.hold.store(false, Ordering::SeqCst);
        }
        let result = if let Some(multi) = &self.multi {
            super::multitrack::command(multi, text).await
        } else {
            command(&self.handle, text).await
        };
        if result.get("error").is_some() && action.as_deref() == Some("pause") {
            self.hold.store(false, Ordering::SeqCst);
        }
        if let Some(w) = self.wake.lock().unwrap().take() {
            w.wake();
        }
        result
    }
    pub async fn run(&self) -> Value {
        let session = self.session.lock().unwrap().take();
        let Some(session) = session else {
            return error("RECORDING_FAILED", "Closed");
        };
        let mut output = self.output.clone();
        let result = {
            let run = async {
                if self.kind == "blob" {
                    let (bytes, report) = session
                        .into_bytes(self.capacity, self.format)
                        .await
                        .map_err(failure)?;
                    output
                        .host
                        .write("0".into(), bytes)
                        .await
                        .map_err(|_| error("OUTPUT_WRITE_FAILED", "write"))?;
                    return Ok(report);
                }
                #[cfg(not(target_arch = "wasm32"))]
                if self.kind == "file" || self.kind == "files" {
                    return session
                        .write_to_files(
                            &mut output,
                            FileOutputOptions::default().with_format(self.format),
                        )
                        .await
                        .map_err(failure);
                }
                session.write_to_outputs(&mut output).await.map_err(failure)
            };
            let pump = async {
                loop {
                    self.output.notify.notified().await;
                    self.output.drain().await?;
                }
                #[allow(unreachable_code)]
                Ok::<(), std::io::Error>(())
            };
            tokio::pin!(run);
            // v0.9's paused boundary self-wakes its watch receiver. After its
            // acknowledgement, poll media again only when a control releases it.
            // Keep the independent event pump running while media is paused.
            let gated = std::future::poll_fn(|cx| {
                let mut wake = self.wake.lock().unwrap();
                *wake = Some(cx.waker().clone());
                if self.hold.load(Ordering::SeqCst)
                    && self.handle.state() == ContinuousState::Paused
                {
                    return Poll::Pending;
                }
                drop(wake);
                run.as_mut().poll(cx)
            });
            tokio::pin!(gated);
            tokio::select! {
                r=&mut gated=>r,
                _=pump=>{self.handle.cancel();Err(error("OUTPUT_WRITE_FAILED","event"))}
            }
        };
        if let Some(error) = self.output.events.lock().unwrap().playback_error.clone() {
            return error;
        }
        if self.output.events.lock().unwrap().overflow {
            return error("RESOURCE_LIMIT_EXCEEDED", "EventQueueLimit");
        }
        let close = self.output.drain().await;
        match result {
            Ok(report) if close.is_ok() => json!({"report":report,"totalSegments":0}),
            Ok(_) => error("OUTPUT_WRITE_FAILED", "close"),
            Err(e) => e,
        }
    }
}
pub async fn command(handle: &ContinuousHandle, text: &str) -> Value {
    let run = async {
        let v: Value = serde_json::from_str(text).map_err(|_| invalid())?;
        let id = || InputId::new(v["inputId"].as_str().unwrap_or("")).map_err(|_| invalid());
        match v["action"].as_str().unwrap_or("") {
            "stop" => handle.stop(),
            "cancel" => handle.cancel(),
            "pause" => {
                handle.pause().map_err(failure)?;
                handle.wait_paused().await.map_err(failure)?;
            }
            "resume" => handle.resume().map_err(failure)?,
            "end" => handle.end_input(&id()?).map_err(failure)?,
            "restart" => handle
                .restart(&id()?, uint(v["generation"].as_str().unwrap_or(""))?)
                .map_err(failure)?,
            "accept" => {
                let input = id()?;
                let snapshot = parse_playlist_snapshot(
                    &TextResource {
                        content: v["text"].as_str().unwrap_or("").into(),
                        location: SourceLocation::Url(
                            url::Url::parse(v["url"].as_str().unwrap_or(""))
                                .map_err(|_| invalid())?,
                        ),
                    },
                    PlaylistContext::new(
                        input.clone(),
                        uint(v["generation"].as_str().unwrap_or(""))?,
                    )
                    .with_revision(uint(v["revision"].as_str().unwrap_or(""))?),
                )
                .map_err(|_| error("MANIFEST_INVALID", "playlist"))?;
                handle
                    .accept_when_ready(&input, &snapshot)
                    .await
                    .map_err(failure)?;
            }
            _ => return Err(invalid()),
        };
        Ok(json!({}))
    }
    .await;
    run.unwrap_or_else(|e| e)
}
