//! Multi-track wire v2. Legacy continuous sessions keep wire v1 and their report.
use super::continuous::failure;
use super::*;
use hls_transmux::capabilities::*;

#[derive(Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    language: Option<String>,
    name: Option<String>,
    default: Option<bool>,
}
impl Metadata {
    fn track(&self) -> TrackMetadata {
        TrackMetadata::new(
            self.language.as_deref().unwrap_or("und"),
            self.name.as_deref().unwrap_or(""),
        )
        .with_default(self.default.unwrap_or(false))
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Audio {
    id: String,
    metadata: Metadata,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subtitle {
    id: String,
    timeline_input_id: String,
    metadata: Metadata,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    embedded_audio: String,
    primary_audio: Metadata,
    audio_tracks: Vec<Audio>,
    subtitle_tracks: Vec<Subtitle>,
    playback_target: Option<String>,
}
impl Selection {
    pub fn create(
        &self,
        source: Arc<dyn Source>,
        keys: KeySession,
        options: ContinuousOptions,
    ) -> std::result::Result<MultiTrackSession, Value> {
        let embedded = match self.embedded_audio.as_str() {
            "keep" => EmbeddedAudio::Keep,
            "exclude" => EmbeddedAudio::Exclude,
            _ => return Err(error("MULTITRACK_FAILED", "InvalidOptions")),
        };
        let mut inputs = MultiTrackInputs::new(
            ContinuousInput::new(InputId::new("primary").unwrap(), source.clone()),
            embedded,
        )
        .with_primary_audio(self.primary_audio.track());
        for a in &self.audio_tracks {
            inputs = inputs.with_audio(
                ContinuousInput::new(
                    InputId::new(&a.id)
                        .map_err(|_| error("MULTITRACK_FAILED", "InvalidOptions"))?,
                    source.clone(),
                ),
                a.metadata.track(),
            );
        }
        for t in &self.subtitle_tracks {
            inputs = inputs.with_subtitle(SubtitleTrack::new(
                InputId::new(&t.id).map_err(|_| error("MULTITRACK_FAILED", "InvalidOptions"))?,
                InputId::new(&t.timeline_input_id)
                    .map_err(|_| error("MULTITRACK_FAILED", "InvalidOptions"))?,
                t.metadata.track(),
            ));
        }
        MultiTrackSession::new(inputs, keys, options).map_err(failure)
    }
    /// Query the player's container/layout gate. Actual codecs and encryption are
    /// validated by the session from media bytes, never guessed from URL suffixes.
    pub fn check_playback(
        &self,
        kind: &str,
        format: &str,
        capacity: Option<usize>,
        gaps: bool,
    ) -> std::result::Result<(), Value> {
        let playback = match self.playback_target.as_deref().unwrap_or("container") {
            "container" => MultiTrackPlayback::Container,
            "direct-browser" => MultiTrackPlayback::DirectBrowser,
            "avfoundation" => MultiTrackPlayback::AvFoundation,
            "vlc" => MultiTrackPlayback::Vlc,
            "iina" => MultiTrackPlayback::Iina,
            "ffmpeg" => MultiTrackPlayback::Ffmpeg,
            _ => return Err(error("UNSUPPORTED_OUTPUT", "UnknownPlaybackTarget")),
        };
        let output = if format == "fmp4" {
            KeyedOutput::FragmentedWriter
        } else if kind == "blob" {
            KeyedOutput::Mp4Bytes
        } else {
            KeyedOutput::NativeStreamingFile
        };
        let q = MultiTrackCapabilityQuery::new(
            InputId::new("primary").unwrap(),
            KeyedInputCapability::new(
                KeyedContainer::TransportStream,
                KeyedEncryption::Clear,
                vec![KeyedCodec::Avc, KeyedCodec::AacLc],
            ),
            output,
            EmbeddedAudio::Keep,
        )
        .with_host_waiter(true)
        .with_memory_capacity(capacity.unwrap_or(1))
        .with_subtitles(!self.subtitle_tracks.is_empty())
        .with_decode_gaps(gaps)
        .with_playback(playback);
        let decision = query_multitrack_capability(&q);
        if let Some(reason) = decision.playback_rejection() {
            return Err(error("UNSUPPORTED_OUTPUT", &format!("{reason:?}")));
        }
        Ok(())
    }
}

pub enum Session {
    Legacy(ContinuousSession),
    Multi(MultiTrackSession),
}
impl Session {
    pub fn handles(&self) -> (ContinuousHandle, Option<MultiTrackHandle>) {
        match self {
            Self::Legacy(s) => (s.handle(), None),
            Self::Multi(s) => {
                let h = s.handle();
                (h.control().clone(), Some(h))
            }
        }
    }
    pub async fn into_bytes(
        self,
        capacity: usize,
        format: OutputFormat,
    ) -> ContinuousResult<(Vec<u8>, Value)> {
        match self {
            Self::Legacy(s) => s
                .into_bytes(capacity, format)
                .await
                .map(|(b, r)| (b, json!(r))),
            Self::Multi(s) => s
                .into_bytes(capacity, format)
                .await
                .map(|(b, r)| (b, report(r))),
        }
    }
    pub async fn write_to_outputs<P: ContinuousWriterProvider>(
        self,
        provider: &mut P,
    ) -> ContinuousResult<Value> {
        match self {
            Self::Legacy(s) => s.write_to_outputs(provider).await.map(|r| json!(r)),
            Self::Multi(s) => s.write_to_outputs(provider).await.map(report),
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn write_to_files<P: ContinuousFileProvider>(
        self,
        provider: &mut P,
        options: FileOutputOptions,
    ) -> ContinuousResult<Value> {
        match self {
            Self::Legacy(s) => s.write_to_files(provider, options).await.map(|r| json!(r)),
            Self::Multi(s) => s.write_to_files(provider, options).await.map(report),
        }
    }
}
fn report(r: MultiTrackReport) -> Value {
    let mut value = json!(r.media());
    value["configurationId"] = json!(r.configuration_id());
    value["tracks"] = json!(r.tracks().iter().map(|t| json!({
        "id":t.id().get(), "outputIndex":t.output_index().to_string(), "inputId":t.input_id().as_str(),
        "kind":format!("{:?}",t.kind()).to_lowercase(), "codec":format!("{:?}",t.codec()),
        "metadata":{"language":t.metadata().language(),"name":t.metadata().name(),"default":t.metadata().is_default()},
        "timescale":t.timescale(),"duration":t.duration().to_string(),"sampleCount":t.sample_count().to_string()
    })).collect::<Vec<_>>());
    value["subtitleReports"] = json!(r.subtitle_reports().iter().map(|c| json!({
        "trackId":c.track_id().get(),"identifier":c.identifier(),"disposition":format!("{:?}",c.disposition()),
        "outputIndex":c.output_index().to_string(),"start":c.start(),"end":c.end()
    })).collect::<Vec<_>>());
    value["trackHistoryTruncated"] = json!(r.track_history_truncated());
    value["subtitleHistoryTruncated"] = json!(r.subtitle_history_truncated());
    value
}

pub async fn command(handle: &MultiTrackHandle, text: &str) -> Value {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return error("MULTITRACK_FAILED", "InvalidCommand"),
    };
    let action = v["action"].as_str().unwrap_or("");
    if !matches!(action, "cues" | "tryCues" | "initialCues" | "endSubtitles") {
        return super::continuous::command(handle.control(), text).await;
    }
    let result = async {
        let id = InputId::new(v["inputId"].as_str().unwrap_or("")).map_err(|_| error("SUBTITLE_INVALID", "UnknownInput"))?;
        let track = handle.subtitle_track_id(&id).ok_or_else(|| error("SUBTITLE_INVALID", "UnknownInput"))?;
        if action == "endSubtitles" {
            handle.end_subtitles(track).map_err(failure)?;
            return Ok(json!({}));
        }
        let cues: Vec<SubtitleCue> = serde_json::from_value(v["cues"].clone()).map_err(|_| error("SUBTITLE_INVALID", "InvalidCue"))?;
        let a = if matches!(action, "tryCues" | "initialCues") {
            match handle.accept_cues(track, &cues) {
                Ok(a) => a,
                Err(e) if e.kind() == ContinuousErrorKind::WouldBlock && action == "tryCues" => return Ok(json!({"wouldBlock":true})),
                Err(e) if e.kind() == ContinuousErrorKind::WouldBlock => return Err(error("RESOURCE_LIMIT_EXCEEDED", "InitialSubtitleBudget")),
                Err(e) => return Err(failure(e)),
            }
        } else { handle.accept_cues_when_ready(track, &cues).await.map_err(failure)? };
        Ok(json!({"accepted":a.accepted(),"rejectedLate":a.rejected_late(),"clipped":a.clipped(),"trackId":track.get()}))
    }.await;
    result.unwrap_or_else(|e| e)
}
