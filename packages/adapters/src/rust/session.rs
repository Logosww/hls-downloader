use hls_transmux::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Deserialize)]
pub struct Snapshot {
    pub url: String,
    pub text: String,
}
#[derive(Deserialize)]
pub struct Request {
    pub primary: Snapshot,
    pub audio: Option<Snapshot>,
    pub concurrency: usize,
    pub mode: String,
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub output: Option<String>,
}
pub fn timeline(value: &TimelineMapping) -> Value {
    json!({"origin": {"ticks": value.origin().ticks().to_string(), "timescale": value.origin().timescale()},
      "tracks": value.tracks().iter().map(|t| json!({
        "role": role(t.role()), "timescale": t.timescale(), "editOffset": t.edit_offset().to_string(),
        "wrapAnchor": t.wrap_anchor().map(|v| v.to_string())
      })).collect::<Vec<_>>()})
}
pub fn role(value: InputRole) -> &'static str {
    match value {
        InputRole::Primary => "primary",
        InputRole::Audio => "audio",
    }
}
pub fn phase(value: SessionPhase) -> &'static str {
    match value {
        SessionPhase::Preparing => "preparing",
        SessionPhase::Playlist => "playlist",
        SessionPhase::Initialization => "initialization",
        SessionPhase::Downloading => "downloading",
        SessionPhase::Processing => "processing",
        SessionPhase::Writing => "writing",
        SessionPhase::Finalizing => "finalizing",
        SessionPhase::Completed => "completed",
    }
}
pub fn failure(e: SessionError) -> Value {
    let code = match e.error() {
        Error::Cancelled => "ABORTED",
        Error::Http(_) if e.phase() == SessionPhase::Playlist => "MANIFEST_FETCH_FAILED",
        Error::Http(_) => "SEGMENT_FETCH_FAILED",
        Error::Io(_)
            if e.phase() == SessionPhase::Writing || e.phase() == SessionPhase::Finalizing =>
        {
            "OUTPUT_WRITE_FAILED"
        }
        Error::InvalidInput(_) if e.phase() == SessionPhase::Playlist => "MANIFEST_INVALID",
        Error::Unsupported(_) => "TRANSMUX_FAILED",
        _ => "TRANSMUX_FAILED",
    };
    json!({"error": {"code": code, "inputRole": e.role().map(role), "phase": phase(e.phase()), "segmentIndex": e.segment_index(), "url": e.resource()}})
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub total: usize,
    pub completed: usize,
}
pub fn progress(e: SessionEvent) -> String {
    serde_json::to_string(&Progress {
        phase: phase(e.phase()),
        total: e.total_segments(),
        completed: e.processed_segments(),
    })
    .unwrap()
}
