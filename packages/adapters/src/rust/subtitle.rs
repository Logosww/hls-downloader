//! Shared acknowledged WebVTT serialization and fresh resource-bound replay.
use super::continuous::failure;
use super::timeline::OutputHost;
use super::*;
use std::collections::BTreeMap;

fn timestamp(t: MediaTime) -> String {
    let ms = t.ticks() * 1000 / i128::from(t.timescale());
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}
fn chunks(batch: &SubtitleCommit) -> BTreeMap<(String, u64), String> {
    let mut out = BTreeMap::new();
    for f in batch.frontiers() {
        out.entry((f.input_id().as_str().to_owned(), f.output_index()))
            .or_insert_with(String::new);
    }
    for c in batch.cues() {
        let bytes = out
            .entry((c.input_id().as_str().to_owned(), c.output_index()))
            .or_insert_with(String::new);
        if !matches!(
            c.disposition(),
            SubtitleDisposition::Written | SubtitleDisposition::Clipped
        ) {
            continue;
        }
        // Millisecond timestamps use floor, identically on both runtimes. Drop
        // quantized empty portions rather than emitting invalid WebVTT intervals.
        if c.start().ticks() * 1000 / i128::from(c.start().timescale())
            >= c.end().ticks() * 1000 / i128::from(c.end().timescale())
        {
            continue;
        }
        if !c.cue().identifier().is_empty() {
            bytes.push_str(c.cue().identifier());
            bytes.push('\n');
        }
        bytes.push_str(&format!(
            "{} --> {}{}{}\n{}\n\n",
            timestamp(c.start()),
            timestamp(c.end()),
            if c.cue().settings().is_empty() {
                ""
            } else {
                " "
            },
            c.cue().settings(),
            c.cue().payload()
        ));
    }
    out
}
fn commit_value(batch: &SubtitleCommit) -> Value {
    json!({"cues":batch.cues().iter().map(|c|json!({"receipt":c.receipt().to_string(),"inputId":c.input_id().as_str(),"trackId":c.track_id().get(),"outputIndex":c.output_index().to_string(),"disposition":format!("{:?}",c.disposition()),"generation":c.cue().generation().to_string(),"epoch":c.cue().epoch().to_string(),"identifier":c.cue().identifier(),"payload":c.cue().payload(),"settings":c.cue().settings(),"start":c.start(),"end":c.end()})).collect::<Vec<_>>(),
    "frontiers":batch.frontiers().iter().map(|f|json!({"inputId":f.input_id().as_str(),"trackId":f.track_id().get(),"generation":f.generation().to_string(),"epoch":f.epoch().to_string(),"outputIndex":f.output_index().to_string(),"end":f.end()})).collect::<Vec<_>>()})
}
pub struct HostSink(pub Arc<dyn OutputHost>);
impl SubtitleSink for HostSink {
    fn commit<'a>(&'a self, batch: &'a SubtitleCommit) -> SubtitleSinkFuture<'a> {
        Box::pin(async move {
            let pieces: Vec<_> = chunks(batch).into_iter().map(|((input,index),text)|json!({"inputId":input,"outputIndex":index.to_string(),"text":text})).collect();
            self.0
                .control(
                    json!({"action":"subtitleCommit","chunks":pieces,"commit":commit_value(batch)})
                        .to_string(),
                )
                .await?;
            Ok(())
        })
    }
    fn finish(&self) -> SubtitleSinkFuture<'_> {
        Box::pin(async {
            self.0
                .control(json!({"action":"subtitleFinish"}).to_string())
                .await?;
            Ok(())
        })
    }
}

/// Prepare before admission. Recovery journals retain bounded replay descriptors
/// and unbound cue bodies, never keys. Fresh resources bind the cues again during
/// restore, letting Engine validate the pending cue digest before truncation.
pub async fn prepare(
    handle: &EngineHandle,
    source: Arc<dyn Source>,
    host: &dyn OutputHost,
    command: &Value,
    recoverable: bool,
    count_limit: usize,
    byte_limit: usize,
) -> std::result::Result<(Vec<SubtitleCue>, Value), Value> {
    let input = InputId::new(command["inputId"].as_str().unwrap_or(""))
        .map_err(|_| error("SUBTITLE_INVALID", "UnknownInput"))?;
    let generation = command["generation"]
        .as_str()
        .unwrap_or("0")
        .parse()
        .map_err(|_| error("SUBTITLE_INVALID", "InvalidGeneration"))?;
    let snapshot = parse_playlist_snapshot(
        &TextResource {
            content: command["text"].as_str().unwrap_or("").into(),
            location: SourceLocation::Url(
                url::Url::parse(command["url"].as_str().unwrap_or(""))
                    .map_err(|_| error("MANIFEST_INVALID", "Location"))?,
            ),
        },
        PlaylistContext::new(input.clone(), generation).with_revision(
            command["revision"]
                .as_str()
                .unwrap_or("0")
                .parse()
                .map_err(|_| error("SUBTITLE_INVALID", "InvalidRevision"))?,
        ),
    )
    .map_err(|_| error("MANIFEST_INVALID", "SubtitlePlaylist"))?;
    let mut cues = Vec::new();
    let mut groups = Vec::new();
    let mut bytes = 0usize;
    for index in command["segments"]
        .as_array()
        .ok_or_else(|| error("SUBTITLE_INVALID", "MissingSegments"))?
    {
        let index = index
            .as_u64()
            .ok_or_else(|| error("SUBTITLE_INVALID", "InvalidIndex"))? as usize;
        let request = ResourceRequest::webvtt_media(&snapshot, index)
            .map_err(|e| error(super::timeline::resource_code(&e), "SubtitleResource"))?;
        let map = if snapshot.segments()[index].map().is_some() {
            Some(
                handle
                    .read_subtitle_resource(
                        source.clone(),
                        ResourceRequest::webvtt_map(&snapshot, index).map_err(|e| {
                            error(super::timeline::resource_code(&e), "SubtitleMap")
                        })?,
                    )
                    .await
                    .map_err(failure)?,
            )
        } else {
            None
        };
        let resource = handle
            .read_subtitle_resource(source.clone(), request)
            .await
            .map_err(failure)?;
        let mut group = if let Some(group) = command["groups"]
            .as_array()
            .and_then(|g| g.iter().find(|g| g["index"] == index))
        {
            group.clone()
        } else {
            let utf8 = |b: &[u8]| {
                String::from_utf8(b.to_vec()).map_err(|_| error("SUBTITLE_INVALID", "InvalidUtf8"))
            };
            let body = utf8(resource.bytes())?;
            let header = map.as_ref().map(|r| utf8(r.bytes())).transpose()?;
            let reply = host.control(json!({"action":"parseSubtitle","inputId":input.as_str(),"generation":generation.to_string(),"epoch":snapshot.segments()[index].slot().epoch().to_string(),"text":body,"header":header}).to_string()).await.map_err(|_|error("SUBTITLE_INVALID","ParseSubtitle"))?;
            serde_json::from_str(&reply).map_err(|_| error("SUBTITLE_INVALID", "InvalidCue"))?
        };
        let raw = group["cues"].clone();
        bytes = bytes.saturating_add(
            serde_json::to_vec(&group)
                .map_err(|_| error("SUBTITLE_INVALID", "InvalidCue"))?
                .len(),
        );
        let parsed: Vec<SubtitleCue> = serde_json::from_value(raw.clone())
            .map_err(|_| error("SUBTITLE_INVALID", "InvalidCue"))?;
        if cues.len() + parsed.len() > count_limit
            || bytes.saturating_add((cues.len() + parsed.len()).saturating_mul(256)) > byte_limit
        {
            return Err(error("RESOURCE_LIMIT_EXCEEDED", "SubtitleAdmissionBudget"));
        }
        group["index"] = json!(index);
        groups.push(group);
        for mut cue in parsed {
            if recoverable {
                if let Some(map) = &map {
                    cue = cue.with_resource(map).map_err(failure)?;
                }
                cue = cue.with_resource(&resource).map_err(failure)?;
            }
            cues.push(cue);
        }
    }
    let mut journal = command.clone();
    journal["groups"] = json!(groups);
    Ok((cues, journal))
}
pub fn admit(handle: &EngineHandle, command: &Value, cues: &[SubtitleCue]) -> Value {
    let run = || -> std::result::Result<Value, Value> {
        let input = InputId::new(command["inputId"].as_str().unwrap_or(""))
            .map_err(|_| error("SUBTITLE_INVALID", "UnknownInput"))?;
        let track = handle
            .subtitle_track_id(&input)
            .ok_or_else(|| error("SUBTITLE_INVALID", "UnknownInput"))?;
        match handle.accept_cues(track, cues) {
            Ok(a) => Ok(
                json!({"accepted":a.accepted(),"rejectedLate":a.rejected_late(),"clipped":a.clipped(),"trackId":track.get()}),
            ),
            Err(e) if e.kind() == EngineErrorKind::WouldBlock => Ok(json!({"wouldBlock":true})),
            Err(e) => Err(failure(e)),
        }
    };
    run().unwrap_or_else(|e| e)
}

#[cfg(not(target_arch = "wasm32"))]
pub mod files {
    use super::*;
    use std::{fs, io::Write};
    pub struct Files {
        pub destinations: Vec<SubtitleDestination>,
        pub host: HostSink,
    }
    impl SubtitleSink for Files {
        fn commit<'a>(&'a self, batch: &'a SubtitleCommit) -> SubtitleSinkFuture<'a> {
            Box::pin(async move {
                for ((input, index), text) in chunks(batch) {
                    let d = self
                        .destinations
                        .iter()
                        .find(|d| d.input_id().as_str() == input)
                        .ok_or_else(|| std::io::Error::other("subtitle destination missing"))?;
                    let mut f = fs::OpenOptions::new()
                        .append(true)
                        .open(d.partial_path(index))?;
                    if f.metadata()?.len() == 0 {
                        f.write_all(b"WEBVTT\n\n")?;
                    }
                    f.write_all(text.as_bytes())?;
                    f.flush()?;
                }
                self.host.commit(batch).await
            })
        }
        fn finish(&self) -> SubtitleSinkFuture<'_> {
            self.host.finish()
        }
    }
    impl RecoverableSubtitleSink for Files {
        fn destinations(&self) -> Vec<SubtitleDestination> {
            self.destinations.clone()
        }
        fn format_identity(&self) -> &str {
            "hls-downloader-webvtt-v1-floor-ms-portions"
        }
        fn publish(&self, index: u64) -> SubtitleSinkFuture<'_> {
            Box::pin(async move {
                for d in &self.destinations {
                    if !d.final_path(index).exists() {
                        fs::hard_link(d.partial_path(index), d.final_path(index))?;
                    }
                    #[cfg(unix)]
                    fs::File::open(d.final_path(index).parent().unwrap())?.sync_all()?;
                }
                Ok(())
            })
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub struct OrdinaryFiles {
    destinations: Vec<SubtitleDestination>,
    opened: Mutex<std::collections::BTreeSet<(String, u64)>>,
    host: HostSink,
}
#[cfg(not(target_arch = "wasm32"))]
impl OrdinaryFiles {
    pub fn new(
        selection: &super::multitrack::Selection,
        media: Option<&str>,
        host: Arc<dyn OutputHost>,
    ) -> std::result::Result<Self, Value> {
        let mut paths = Vec::<std::path::PathBuf>::new();
        let canonical = |path: &str| -> std::io::Result<std::path::PathBuf> {
            let path = std::path::absolute(path)?;
            Ok(std::fs::canonicalize(
                path.parent()
                    .ok_or_else(|| std::io::Error::other("missing parent"))?,
            )?
            .join(
                path.file_name()
                    .ok_or_else(|| std::io::Error::other("missing name"))?,
            ))
        };
        if let Some(media) = media {
            paths.push(
                canonical(media).map_err(|_| error("OUTPUT_WRITE_FAILED", "MediaDestination"))?,
            );
        }
        let mut destinations = Vec::new();
        for t in &selection.subtitle_tracks {
            if let Some(path) = t
                .sidecar
                .as_ref()
                .filter(|v| v["type"] == "file")
                .and_then(|v| v["path"].as_str())
            {
                let path = canonical(path)
                    .map_err(|_| error("OUTPUT_WRITE_FAILED", "SubtitleDestination"))?;
                let namespace = |p: &std::path::Path| p.to_string_lossy().into_owned();
                if paths.iter().any(|p| {
                    p == &path
                        || [".part-", ".hls-partial"].iter().any(|suffix| {
                            namespace(p).starts_with(&(namespace(&path) + suffix))
                                || namespace(&path).starts_with(&(namespace(p) + suffix))
                        })
                }) {
                    return Err(error(
                        "UNSUPPORTED_OUTPUT",
                        "OverlappingSubtitleDestination",
                    ));
                }
                paths.push(path.clone());
                destinations.push(SubtitleDestination::new(InputId::new(&t.id).unwrap(), path));
            }
        }
        Ok(Self {
            destinations,
            opened: Mutex::new(Default::default()),
            host: HostSink(host),
        })
    }
}
#[cfg(not(target_arch = "wasm32"))]
impl SubtitleSink for OrdinaryFiles {
    fn commit<'a>(&'a self, batch: &'a SubtitleCommit) -> SubtitleSinkFuture<'a> {
        Box::pin(async move {
            use std::io::Write;
            for ((input, index), text) in chunks(batch) {
                let Some(d) = self
                    .destinations
                    .iter()
                    .find(|d| d.input_id().as_str() == input)
                else {
                    continue;
                };
                let mut opened = self.opened.lock().unwrap();
                let key = (input, index);
                let mut f = if !opened.contains(&key) {
                    if std::fs::symlink_metadata(d.final_path(index)).is_ok() {
                        return Err(std::io::Error::other("subtitle destination exists"));
                    }
                    let mut f = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(d.partial_path(index))?;
                    opened.insert(key);
                    f.write_all(b"WEBVTT\n\n")?;
                    f
                } else {
                    std::fs::OpenOptions::new()
                        .append(true)
                        .open(d.partial_path(index))?
                };
                f.write_all(text.as_bytes())?;
                f.flush()?;
            }
            self.host.commit(batch).await
        })
    }
    fn finish(&self) -> SubtitleSinkFuture<'_> {
        Box::pin(async {
            self.host.finish().await?;
            for (input, index) in self.opened.lock().unwrap().iter() {
                let d = self
                    .destinations
                    .iter()
                    .find(|d| d.input_id().as_str() == input)
                    .unwrap();
                std::fs::hard_link(d.partial_path(*index), d.final_path(*index))?;
            }
            Ok(())
        })
    }
}
#[cfg(not(target_arch = "wasm32"))]
impl Drop for OrdinaryFiles {
    fn drop(&mut self) {
        for (input, index) in self.opened.get_mut().unwrap().iter() {
            if let Some(d) = self
                .destinations
                .iter()
                .find(|d| d.input_id().as_str() == input)
            {
                let _ = std::fs::remove_file(d.partial_path(*index));
            }
        }
    }
}

pub async fn read_text(handle: &EngineHandle, source: Arc<dyn Source>, v: &Value) -> Value {
    let run = async {
        let id = InputId::new(v["inputId"].as_str().unwrap_or(""))
            .map_err(|_| error("SUBTITLE_INVALID", "UnknownInput"))?;
        let snapshot = parse_playlist_snapshot(
            &TextResource {
                content: v["text"].as_str().unwrap_or("").into(),
                location: SourceLocation::Url(
                    url::Url::parse(v["url"].as_str().unwrap_or(""))
                        .map_err(|_| error("MANIFEST_INVALID", "Location"))?,
                ),
            },
            PlaylistContext::new(id, 0),
        )
        .map_err(|_| error("MANIFEST_INVALID", "SubtitlePlaylist"))?;
        let index = v["index"]
            .as_u64()
            .ok_or_else(|| error("SUBTITLE_INVALID", "InvalidIndex"))? as usize;
        let request = ResourceRequest::webvtt_media(&snapshot, index)
            .map_err(|e| error(super::timeline::resource_code(&e), "SubtitleResource"))?;
        let utf8 = |b: &[u8]| {
            String::from_utf8(b.to_vec()).map_err(|_| error("SUBTITLE_INVALID", "InvalidUtf8"))
        };
        let header = if snapshot.segments()[index].map().is_some() {
            let clear = handle
                .read_subtitle_resource(
                    source.clone(),
                    ResourceRequest::webvtt_map(&snapshot, index)
                        .map_err(|e| error(super::timeline::resource_code(&e), "SubtitleMap"))?,
                )
                .await
                .map_err(failure)?;
            Some(utf8(clear.bytes())?)
        } else {
            None
        };
        let clear = handle
            .read_subtitle_resource(source, request)
            .await
            .map_err(failure)?;
        Ok(json!({"text":utf8(clear.bytes())?,"header":header}))
    }
    .await;
    run.unwrap_or_else(|e| e)
}
