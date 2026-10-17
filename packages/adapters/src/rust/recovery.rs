//! SDK-owned schema-2 storage. The engine remains the authority for media replay.
use super::*;
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub directory: String,
    pub path: String,
    pub durability: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct State {
    schema: u32,
    identity: Value,
    request: Value,
    checkpoint: Option<EngineCheckpoint>,
    journal: Vec<Value>,
    #[serde(default)]
    outputs: Vec<Value>,
    #[serde(default)]
    output_history_truncated: bool,
}
pub struct Store {
    directory: PathBuf,
    pub path: PathBuf,
    _lock: File,
    state: Mutex<State>,
    limit: usize,
    history: usize,
    pub synced: bool,
    pub failure: Mutex<Option<Value>>,
    replay: Vec<Value>,
    committed: Mutex<std::collections::HashMap<String, (u64, u64, u64)>>,
}
fn io_error(_: impl std::fmt::Debug) -> Value {
    error("RESUME_IO_FAILED", "RecoveryStorage")
}
fn read(directory: &Path) -> std::result::Result<Option<State>, Value> {
    if directory.join("state.json").exists() {
        return Err(error("RESUME_INVALID", "LegacySchema"));
    }
    let path = directory.join("engine-state.json");
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::symlink_metadata(&path).map_err(io_error)?;
    if !meta.is_file() || meta.len() > 72 * 1024 * 1024 {
        return Err(error("RESUME_INVALID", "InvalidState"));
    }
    let mut data = Vec::new();
    File::open(path)
        .map_err(io_error)?
        .take(72 * 1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(io_error)?;
    let state: State =
        serde_json::from_slice(&data).map_err(|_| error("RESUME_INVALID", "ResumeCorruption"))?;
    if state.schema != 2 {
        return Err(error("RESUME_INVALID", "LegacySchema"));
    }
    // A nonterminal checkpoint must retain at least one admitted snapshot. Reject
    // missing replay before starting host polling, which could otherwise race the
    // engine failure and mask ReplayRequired with a Closed admission error.
    if state
        .checkpoint
        .as_ref()
        .is_some_and(|c| !c.is_finalizing() && !c.is_completed())
        && !state.journal.iter().any(|v| v["action"] == "accept")
    {
        return Err(error("RESUME_REPLAY_REQUIRED", "MissingSnapshotReplay"));
    }
    Ok(Some(state))
}
pub fn inspect(directory: &str) -> Value {
    match read(Path::new(directory)) {
        Ok(Some(s)) => {
            json!({"request":s.request,"journal":s.journal,"terminal":s.checkpoint.as_ref().is_some_and(|c|c.is_finalizing()||c.is_completed())})
        }
        Ok(None) => json!({}),
        Err(e) => e,
    }
}
impl Store {
    pub fn open(c: &Config, request: Value, limit: usize) -> std::result::Result<Arc<Self>, Value> {
        let directory = PathBuf::from(&c.directory);
        if let Ok(m) = fs::symlink_metadata(&directory) {
            if !m.is_dir() {
                return Err(error("RESUME_INVALID", "InvalidDirectory"));
            }
        }
        fs::create_dir_all(&directory).map_err(io_error)?;
        for e in fs::read_dir(&directory).map_err(io_error)? {
            let e = e.map_err(io_error)?;
            let n = e.file_name();
            let n = n.to_string_lossy();
            if !matches!(n.as_ref(), "engine-state.json" | "engine-lock")
                && !n.starts_with(".engine-state-")
            {
                return Err(error("RESUME_INVALID", "ForeignDirectory"));
            }
            if !e.file_type().map_err(io_error)?.is_file() {
                return Err(error("RESUME_INVALID", "InvalidState"));
            }
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("engine-lock"))
            .map_err(io_error)?;
        lock.try_lock()
            .map_err(|_| error("RESUME_CONFLICT", "DirectoryInUse"))?;
        let identity = request
            .get("identity")
            .cloned()
            .ok_or_else(|| error("RESUME_INVALID", "MissingIdentity"))?;
        let history = request["recording"]["limits"]["historyEntries"]
            .as_u64()
            .unwrap_or(128) as usize;
        let state = match read(&directory)? {
            Some(s) if s.identity != identity => {
                return Err(error("RESUME_CONFLICT", "ConfigurationChanged"));
            }
            Some(s) => s,
            None => State {
                schema: 2,
                identity,
                request,
                checkpoint: None,
                journal: vec![],
                outputs: vec![],
                output_history_truncated: false,
            },
        };
        let path = std::path::absolute(&c.path).map_err(io_error)?;
        let synced = match c.durability.as_deref().unwrap_or("sync-all") {
            "sync-all" => true,
            "flush" => false,
            _ => return Err(error("RESUME_INVALID", "InvalidDurability")),
        };
        let replay = state.journal.clone();
        let store = Arc::new(Self {
            directory,
            path,
            _lock: lock,
            state: Mutex::new(state),
            limit,
            history,
            synced,
            failure: Mutex::new(None),
            replay,
            committed: Mutex::new(std::collections::HashMap::new()),
        });
        store.persist(&store.state.lock().unwrap())?;
        Ok(store)
    }
    fn persist(&self, s: &State) -> std::result::Result<(), Value> {
        let mut f = tempfile::Builder::new()
            .prefix(".engine-state-")
            .tempfile_in(&self.directory)
            .map_err(io_error)?;
        serde_json::to_writer(&mut f, s).map_err(io_error)?;
        f.flush().map_err(io_error)?;
        if self.synced {
            f.as_file().sync_all().map_err(io_error)?;
        }
        f.persist(self.directory.join("engine-state.json"))
            .map_err(io_error)?;
        #[cfg(unix)]
        if self.synced {
            File::open(&self.directory)
                .and_then(|d| d.sync_all())
                .map_err(io_error)?;
        }
        Ok(())
    }
    pub fn checkpoint(&self) -> Option<EngineCheckpoint> {
        self.state.lock().unwrap().checkpoint.clone()
    }
    pub fn terminal(&self) -> bool {
        self.checkpoint()
            .is_some_and(|c| c.is_finalizing() || c.is_completed())
    }
    pub fn journal(&self) -> Vec<Value> {
        self.replay.clone()
    }
    // Admission and journal mutation share the checkpoint mutex. A checkpoint
    // can never contain admitted work whose replay record has not been installed.
    pub fn admit(&self, v: Value, apply: impl FnOnce() -> Value) -> Value {
        let mut state = self.state.lock().unwrap();
        let duplicate = state.journal.last() == Some(&v);
        let size = serde_json::to_vec(&state.journal)
            .map(|b| b.len())
            .unwrap_or(self.limit)
            + if duplicate {
                0
            } else {
                serde_json::to_vec(&v)
                    .map(|b| b.len())
                    .unwrap_or(self.limit)
            };
        if size > self.limit {
            return error("RESOURCE_LIMIT_EXCEEDED", "RecoveryReplayBudget");
        }
        let result = apply();
        if result.get("error").is_none() && result.get("wouldBlock").is_none() && !duplicate {
            state.journal.push(v);
        }
        result
    }
    pub fn note_output(&self, output: Value) {
        let mut state = self.state.lock().unwrap();
        if let Some(old) = state
            .outputs
            .iter_mut()
            .find(|o| o["index"] == output["index"])
        {
            *old = output;
        } else {
            if state.outputs.len() >= self.history {
                state.outputs.remove(0);
                state.output_history_truncated = true;
            }
            state.outputs.push(output);
        }
    }
    pub fn merge_outputs(&self, report: &mut Value) {
        let state = self.state.lock().unwrap();
        let mut outputs = state.outputs.clone();
        for output in report["outputs"].as_array().into_iter().flatten() {
            if let Some(old) = outputs.iter_mut().find(|o| o["index"] == output["index"]) {
                *old = output.clone();
            } else {
                outputs.push(output.clone());
            }
        }
        outputs.sort_by_key(|o| {
            o["index"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
        });
        if outputs.len() > self.history {
            outputs.drain(..outputs.len() - self.history);
        }
        report["outputs"] = json!(outputs);
        if state.output_history_truncated {
            report["history_truncated"] = json!(true);
        }
    }
    pub fn finish(&self, report: &mut Value) -> std::result::Result<(), Value> {
        self.merge_outputs(report);
        let mut state = self.state.lock().unwrap();
        state.outputs = report["outputs"].as_array().cloned().unwrap_or_default();
        if let Err(mut error) = self.persist(&state) {
            error["error"]["completedRecordingOutputs"] = report["outputs"].clone();
            return Err(error);
        }
        Ok(())
    }
    pub fn note_commit(&self, p: &EngineInputProgress) {
        if let Some(slot) = p.committed_slot() {
            self.committed.lock().unwrap().insert(
                slot.input_id().as_str().to_string(),
                (slot.generation(), slot.epoch(), slot.sequence()),
            );
        }
    }
    fn prune(&self, state: &mut State) {
        let committed = self.committed.lock().unwrap();
        let mut last = std::collections::HashMap::new();
        for (i, v) in state.journal.iter().enumerate() {
            if v["action"] == "accept" {
                last.insert(v["inputId"].as_str().unwrap_or("").to_string(), i);
            }
        }
        let mut index = 0;
        state.journal.retain(|v| {
            let i = index;
            index += 1;
            if v["action"] != "accept" {
                return true;
            }
            let id = v["inputId"].as_str().unwrap_or("");
            if last.get(id) == Some(&i) {
                return true;
            }
            let Some(watermark) = committed.get(id) else {
                return true;
            };
            let Ok(snapshot) = parse(
                &Snapshot {
                    url: v["url"].as_str().unwrap_or("").into(),
                    text: v["text"].as_str().unwrap_or("").into(),
                },
                id,
            ) else {
                return true;
            };
            let generation = v["generation"]
                .as_str()
                .and_then(|n| n.parse::<u64>().ok())
                .unwrap_or(u64::MAX);
            snapshot
                .segments()
                .last()
                .is_none_or(|s| (generation, s.slot().epoch(), s.slot().sequence()) >= *watermark)
        });
    }
    pub fn commit(&self, c: EngineCheckpoint) -> EngineResult<()> {
        let mut state = self.state.lock().unwrap();
        self.prune(&mut state);
        state.checkpoint = Some(c);
        if state
            .checkpoint
            .as_ref()
            .is_some_and(|c| c.is_finalizing() || c.is_completed())
        {
            state.journal.clear();
        }
        if let Err(e) = self.persist(&state) {
            *self.failure.lock().unwrap() = Some(e);
            return Err(EngineError::output(Error::invalid(
                "checkpoint persistence failed",
            )));
        }
        if let Some(checkpoint) = state.checkpoint.as_ref().filter(|c| c.is_completed()) {
            for i in 0..=checkpoint.output_index() {
                let path = if i == 0 {
                    self.path.clone()
                } else {
                    PathBuf::from(format!("{}.part-{i:06}.mp4", self.path.display()))
                };
                let partial = PathBuf::from(format!("{}.hls-partial", path.display()));
                // Completion was atomically persisted above. Cleanup is best effort;
                // a retained partial is harmless and never required for offline restore.
                let _ = fs::remove_file(partial);
                for track in state.request["multitrack"]["subtitleTracks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if let (Some(id), Some(path)) =
                        (track["id"].as_str(), track["sidecar"]["path"].as_str())
                    {
                        if let Ok(id) = InputId::new(id) {
                            let _ =
                                fs::remove_file(SubtitleDestination::new(id, path).partial_path(i));
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

pub fn try_command(handle: &EngineHandle, v: &Value) -> Value {
    let action = v["action"].as_str().unwrap_or("");
    let run = || -> std::result::Result<Value, Value> {
        let id = InputId::new(v["inputId"].as_str().unwrap_or(""))
            .map_err(|_| error("RESUME_INVALID", "UnknownInput"))?;
        let outcome = match action {
            "accept" => {
                let generation = v["generation"]
                    .as_str()
                    .and_then(|n| n.parse::<u64>().ok())
                    .ok_or_else(|| error("RESUME_INVALID", "InvalidGeneration"))?;
                let revision = v["revision"]
                    .as_str()
                    .and_then(|n| n.parse::<u64>().ok())
                    .ok_or_else(|| error("RESUME_INVALID", "InvalidRevision"))?;
                let snapshot = parse_playlist_snapshot(
                    &TextResource {
                        content: v["text"].as_str().unwrap_or("").into(),
                        location: SourceLocation::Url(
                            url::Url::parse(v["url"].as_str().unwrap_or(""))
                                .map_err(|_| error("RESUME_INVALID", "InvalidLocation"))?,
                        ),
                    },
                    PlaylistContext::new(id.clone(), generation).with_revision(revision),
                )
                .map_err(|_| error("MANIFEST_INVALID", "playlist"))?;
                handle.accept_snapshot(&id, &snapshot).map(|_| json!({}))
            }
            "end" => handle.end_input(&id).map(|_| json!({})),
            "restart" => handle
                .restart(
                    &id,
                    v["generation"]
                        .as_str()
                        .and_then(|n| n.parse().ok())
                        .ok_or_else(|| error("RESUME_INVALID", "InvalidGeneration"))?,
                )
                .map(|_| json!({})),
            "cues" | "initialCues" | "tryCues" | "endSubtitles" => {
                let track = handle
                    .subtitle_track_id(&id)
                    .ok_or_else(|| error("SUBTITLE_INVALID", "UnknownInput"))?;
                if action == "endSubtitles" {
                    handle.end_subtitles(track).map(|_| json!({}))
                } else {
                    let cues: Vec<SubtitleCue> = serde_json::from_value(v["cues"].clone())
                        .map_err(|_| error("SUBTITLE_INVALID", "InvalidCue"))?;
                    handle.accept_cues(track,&cues).map(|a|json!({"accepted":a.accepted(),"rejectedLate":a.rejected_late(),"clipped":a.clipped(),"trackId":track.get()}))
                }
            }
            _ => return Err(error("RESUME_INVALID", "InvalidReplayCommand")),
        };
        match outcome {
            Ok(v) => Ok(v),
            Err(e) if e.kind() == EngineErrorKind::WouldBlock => Ok(json!({"wouldBlock":true})),
            Err(e) => Err(super::continuous::failure(e)),
        }
    };
    run().unwrap_or_else(|e| e)
}
