//! Application-owned recovery storage. Mux checkpoints and file recovery belong to hls-transmux.
use crate::{JobCancelToken, transmux::RetryingSource};
use hls_transmux::{
    ByteRange, CancelToken, CheckpointDurability, Error, HlsInput, OutputFormat, Source,
    SourceLocation, TextResource, TransmuxOptions, TransmuxResumeState, TransmuxStage,
    transmux_hls_to_mp4_async,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    future::Future,
    io::{Read, Write},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
};

#[derive(Debug, thiserror::Error)]
pub enum ResumeError {
    #[error("RESUME_CONFLICT: recovery directory is in use")]
    Conflict,
    #[error("RESUME_INVALID: {0}")]
    Invalid(&'static str),
    #[error("RESUME_IO_FAILED: recovery storage operation failed")]
    Io(#[from] std::io::Error),
    #[error("ABORTED: download aborted")]
    Aborted,
    #[error("SEGMENT_FETCH_FAILED: media request failed")]
    Fetch,
    #[error("TRANSMUX_FAILED: media processing failed")]
    Mux,
}
type Result<T> = std::result::Result<T, ResumeError>;
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct State {
    version: u32,
    identity: String,
    output: PathBuf,
    manifest: Option<String>,
    checkpoint: Option<TransmuxResumeState>,
    // Saved before publishing: allows recovery after rename but before receipt update.
    publication: Option<Checksum>,
    published: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Checksum {
    length: u64,
    sha256: String,
}
fn checksum(path: &Path) -> std::io::Result<Checksum> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut length = 0;
    let mut bytes = [0; 65536];
    loop {
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
        length += n as u64;
    }
    Ok(Checksum {
        length,
        sha256: format!("{:x}", hash.finalize()),
    })
}
fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    Ok(())
}
fn atomic_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let parent = path.parent().unwrap();
    let mut temp = tempfile::Builder::new()
        .prefix(".resume-tmp-")
        .tempfile_in(parent)?;
    serde_json::to_writer(&mut temp, value)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    sync_directory(parent)
}
// Recovery directories can live on filesystems without hard-link support.
fn preserve_file(source: &Path, target: &Path) -> std::io::Result<()> {
    let parent = target.parent().unwrap();
    if fs::hard_link(source, target).is_err() {
        let mut temp = tempfile::Builder::new()
            .prefix(".resume-tmp-")
            .tempfile_in(parent)?;
        std::io::copy(&mut File::open(source)?, &mut temp)?;
        temp.flush()?;
        temp.as_file().sync_all()?;
        temp.persist(target).map_err(|e| e.error)?;
    }
    sync_directory(parent)
}
fn regular(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() => {
            Err(ResumeError::Invalid("managed file is not a regular file"))
        }
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug)]
pub struct ResumeTask {
    directory: PathBuf,
    _lock: File,
    state: Mutex<State>,
}
impl ResumeTask {
    pub fn open(directory: PathBuf, identity: &str, output: PathBuf) -> Result<Self> {
        if let Ok(meta) = fs::symlink_metadata(&directory) {
            if !meta.is_dir() {
                return Err(ResumeError::Invalid(
                    "recovery directory must be a real directory",
                ));
            }
            // Refuse foreign directories before creating any files in them.
            for entry in fs::read_dir(&directory)? {
                let name = entry?.file_name();
                let name = name.to_string_lossy();
                if !matches!(
                    name.as_ref(),
                    ".hls-resume-lock"
                        | "state.json"
                        | "cache"
                        | "output.mp4"
                        | "output.partial.mp4"
                        | "finalize.partial.mp4"
                ) && !name.starts_with(".resume-tmp-")
                    && !name.starts_with(".hls-transmux-finalize-")
                {
                    return Err(ResumeError::Invalid("directory contains unrelated files"));
                }
            }
        }
        fs::create_dir_all(&directory)?;
        let lock_path = directory.join(".hls-resume-lock");
        regular(&lock_path)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lock.try_lock().map_err(|e| match e {
            std::fs::TryLockError::WouldBlock => ResumeError::Conflict,
            std::fs::TryLockError::Error(e) => ResumeError::Io(e),
        })?;
        for name in [
            "state.json",
            "output.mp4",
            "output.partial.mp4",
            "finalize.partial.mp4",
        ] {
            regular(&directory.join(name))?;
        }
        let state_path = directory.join("state.json");
        let identity = digest(identity.as_bytes());
        let state = if state_path.exists() {
            let state: State = serde_json::from_slice(&fs::read(&state_path)?)
                .map_err(|_| ResumeError::Invalid("unreadable recovery metadata"))?;
            if state.version != 1 || state.identity != identity || state.output != output {
                return Err(ResumeError::Invalid("input or output identity changed"));
            }
            if state.published && state.publication.is_none() {
                return Err(ResumeError::Invalid("missing publication receipt"));
            }
            if let Some(checkpoint) = &state.checkpoint {
                if checkpoint.output_format != OutputFormat::StreamingMp4
                    || !checkpoint.write_mfra
                    || (checkpoint.stage == TransmuxStage::Completed && state.publication.is_none())
                {
                    return Err(ResumeError::Invalid("inconsistent checkpoint metadata"));
                }
                checkpoint
                    .validate()
                    .map_err(|_| ResumeError::Invalid("invalid checkpoint"))?;
            }
            state
        } else {
            if fs::read_dir(&directory)?.any(|e| {
                e.map(|e| e.file_name() != ".hls-resume-lock")
                    .unwrap_or(true)
            }) {
                return Err(ResumeError::Invalid("missing recovery metadata"));
            }
            let state = State {
                version: 1,
                identity,
                output,
                manifest: None,
                checkpoint: None,
                publication: None,
                published: false,
            };
            atomic_json(&state_path, &state)?;
            state
        };
        let cache = directory.join("cache");
        if let Ok(meta) = fs::symlink_metadata(&cache) {
            if !meta.is_dir() {
                return Err(ResumeError::Invalid("invalid cache directory"));
            }
        }
        fs::create_dir_all(cache)?;
        Ok(Self {
            directory,
            _lock: lock,
            state: Mutex::new(state),
        })
    }
    fn save(&self, state: &State) -> Result<()> {
        atomic_json(&self.directory.join("state.json"), state)?;
        Ok(())
    }
    pub fn needs_input(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.publication.is_none()
            && state
                .checkpoint
                .as_ref()
                .is_none_or(|s| s.stage == TransmuxStage::Downloading)
    }
    pub fn total_segments(&self) -> usize {
        self.state
            .lock()
            .unwrap()
            .checkpoint
            .as_ref()
            .map_or(0, |s| s.total_segments)
    }
    fn clean(&self) {
        // Keep the locked inode and a small completed receipt; never unlink a held lock.
        for parent in [self.directory.join("cache"), self.directory.clone()] {
            if let Ok(entries) = fs::read_dir(&parent) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    let owned = if parent == self.directory {
                        matches!(
                            name.as_ref(),
                            "output.mp4" | "output.partial.mp4" | "finalize.partial.mp4"
                        ) || name.starts_with(".resume-tmp-")
                            || name.starts_with(".hls-transmux-finalize-")
                    } else {
                        name.starts_with(".resume-tmp-")
                            || (name.len() == 69
                                && name.ends_with(".json")
                                && name[..64].bytes().all(|b| b.is_ascii_hexdigit()))
                            || (name.len() == 68
                                && name.ends_with(".bin")
                                && name[..64].bytes().all(|b| b.is_ascii_hexdigit()))
                    };
                    if owned {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
    fn staging_path(&self, state: &State) -> Result<PathBuf> {
        let key = serde_json::to_vec(&(
            self.directory.canonicalize()?,
            &state.identity,
            &state.output,
        ))
        .map_err(std::io::Error::from)?;
        Ok(state
            .output
            .parent()
            .unwrap()
            .join(format!(".hls-resume-output-{}.tmp", digest(&key))))
    }
    fn publish(&self, cancel: Option<&JobCancelToken>) -> Result<PathBuf> {
        let check_cancel = || -> Result<()> {
            if cancel.is_some_and(|token| token.is_cancelled()) {
                Err(ResumeError::Aborted)
            } else {
                Ok(())
            }
        };
        check_cancel()?;
        let local = self.directory.join("output.mp4");
        let mut state = self.state.lock().unwrap();
        if state.publication.is_none() {
            state.publication = Some(checksum(&local)?);
            self.save(&state)?;
        }
        let expected = state.publication.as_ref().unwrap();
        if checksum(&state.output).ok().as_ref() != Some(expected) {
            if state.published {
                return Err(ResumeError::Invalid(
                    "published output is missing or changed",
                ));
            }
            if checksum(&local).ok().as_ref() != Some(expected) {
                return Err(ResumeError::Invalid(
                    "completed output is missing or changed",
                ));
            }
            let parent = state.output.parent().unwrap();
            // Deterministic per-task staging makes interrupted cross-device copies
            // discoverable on retry, without scanning or deleting other tasks' files.
            let staging = self.staging_path(&state)?;
            regular(&staging)?;
            let file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .read(true)
                .write(true)
                .open(&staging)?;
            let mut temp = tempfile::NamedTempFile::from_parts(
                file,
                tempfile::TempPath::try_from_path(staging)?,
            );
            let mut input = File::open(&local)?;
            let mut buffer = [0; 65536];
            loop {
                check_cancel()?;
                let n = input.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                temp.write_all(&buffer[..n])?;
            }
            temp.flush()?;
            temp.as_file().sync_all()?;
            check_cancel()?;
            temp.persist(&state.output)
                .map_err(|e| ResumeError::Io(e.error))?;
            sync_directory(parent)?;
        }
        state.published = true;
        self.save(&state)?;
        let output = state.output.clone();
        if let Ok(staging) = self.staging_path(&state) {
            let _ = fs::remove_file(staging);
        }
        drop(state);
        self.clean();
        Ok(output)
    }
    pub async fn run(
        self: Arc<Self>,
        url: &str,
        headers: HashMap<String, String>,
        concurrency: usize,
        attempts: usize,
        cancel: Arc<JobCancelToken>,
        progress: Option<crate::download::ProgressCallback>,
    ) -> Result<PathBuf> {
        if cancel.is_cancelled() {
            return Err(ResumeError::Aborted);
        }
        let snapshot = self.state.lock().unwrap().clone();
        if snapshot.publication.is_some()
            || snapshot
                .checkpoint
                .as_ref()
                .is_some_and(|c| c.stage == TransmuxStage::Completed)
        {
            return self.publish(Some(&cancel));
        }
        if let Some(checkpoint) = &snapshot.checkpoint {
            let partial = self.directory.join("output.partial.mp4");
            let candidate = if !partial.exists() && checkpoint.stage == TransmuxStage::Finalizing {
                self.directory.join("finalize.partial.mp4")
            } else {
                partial
            };
            let metadata = fs::metadata(candidate).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    ResumeError::Invalid("committed partial output is missing")
                } else {
                    ResumeError::Io(e)
                }
            })?;
            if metadata.len() < checkpoint.bytes_written {
                return Err(ResumeError::Invalid(
                    "committed partial output is truncated",
                ));
            }
        }
        let mut header_map = reqwest::header::HeaderMap::new();
        let mut normalized: Vec<_> = headers
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
            .collect();
        normalized.sort();
        for (k, v) in &normalized {
            header_map.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes())
                    .map_err(|_| ResumeError::Invalid("invalid request header"))?,
                reqwest::header::HeaderValue::from_str(v)
                    .map_err(|_| ResumeError::Invalid("invalid request header"))?,
            );
        }
        let failure = Arc::new(Mutex::new(None));
        // Upstream removes its partial after successful finalization. Keep our own
        // hard link until the completion receipt is durable, including callback I/O failures.
        if snapshot
            .checkpoint
            .as_ref()
            .is_some_and(|c| c.stage == TransmuxStage::Finalizing)
            && !self.directory.join("output.partial.mp4").exists()
        {
            preserve_file(
                &self.directory.join("finalize.partial.mp4"),
                &self.directory.join("output.partial.mp4"),
            )?;
        }
        if snapshot
            .checkpoint
            .as_ref()
            .is_some_and(|c| c.stage == TransmuxStage::Finalizing)
            && !self.directory.join("finalize.partial.mp4").exists()
        {
            preserve_file(
                &self.directory.join("output.partial.mp4"),
                &self.directory.join("finalize.partial.mp4"),
            )?;
        }
        let source = Arc::new(CachedSource {
            task: self.clone(),
            inner: RetryingSource::new(concurrency, header_map, attempts, Some(cancel.clone())),
            headers: digest(&serde_json::to_vec(&normalized).unwrap()),
            failure: failure.clone(),
        });
        let task = self.clone();
        let failed = failure.clone();
        let token = cancel.clone();
        let callback = Arc::new(move |p: hls_transmux::TransmuxProgress| {
            if failed.lock().unwrap().is_some() {
                return;
            }
            let preparation = || -> Result<Option<Checksum>> {
                if p.stage == TransmuxStage::Finalizing {
                    let backup = task.directory.join("finalize.partial.mp4");
                    if !backup.exists() {
                        preserve_file(&task.directory.join("output.partial.mp4"), &backup)?;
                    }
                }
                if p.stage == TransmuxStage::Completed {
                    Ok(Some(checksum(&task.directory.join("output.mp4"))?))
                } else {
                    Ok(None)
                }
            };
            let publication = match preparation() {
                Ok(value) => value,
                Err(error) => {
                    *failed.lock().unwrap() = Some(error);
                    token.cancel();
                    return;
                }
            };
            let mut state = task.state.lock().unwrap();
            if publication.is_some() {
                state.publication = publication;
            }
            state.checkpoint = Some(p.resume);
            if let Err(error) = task.save(&state) {
                *failed.lock().unwrap() = Some(error);
                token.cancel();
                return;
            }
            if p.stage != TransmuxStage::Completed {
                if let Some(cb) = &progress {
                    cb(if p.stage == TransmuxStage::Finalizing {
                        crate::download::DownloadProgress::Merging {
                            completed: p.completed_segments,
                            total: p.total_segments,
                        }
                    } else {
                        crate::download::DownloadProgress::Downloading {
                            completed: p.completed_segments,
                            total: p.total_segments,
                        }
                    });
                }
            }
        });
        let location = SourceLocation::Url(
            url::Url::parse(if url.is_empty() {
                "https://offline.invalid/"
            } else {
                url
            })
            .map_err(|_| ResumeError::Invalid("invalid playlist URL"))?,
        );
        let result = transmux_hls_to_mp4_async(
            HlsInput::custom(source, location),
            self.directory.join("output.mp4"),
            TransmuxOptions {
                output_format: OutputFormat::StreamingMp4,
                checkpoint_durability: CheckpointDurability::SyncAll,
                resume: snapshot.checkpoint,
                cancel: Some(cancel.clone()),
                on_progress: Some(callback),
                ..Default::default()
            },
        )
        .await;
        if let Some(error) = failure.lock().unwrap().take() {
            return Err(error);
        }
        result.map_err(|e| match e {
            Error::Cancelled => ResumeError::Aborted,
            Error::Io(e) => ResumeError::Io(e),
            Error::Http(_) => ResumeError::Fetch,
            Error::InvalidInput(_) => ResumeError::Invalid("input or checkpoint validation failed"),
            _ => ResumeError::Mux,
        })?;
        self.publish(Some(&cancel))
    }
}
#[derive(Debug)]
struct CachedSource {
    task: Arc<ResumeTask>,
    inner: RetryingSource,
    headers: String,
    failure: Arc<Mutex<Option<ResumeError>>>,
}
impl CachedSource {
    fn fail(&self, error: ResumeError) -> Error {
        self.failure.lock().unwrap().get_or_insert(error);
        Error::InvalidInput("recovery storage failed".into())
    }
}
impl Source for CachedSource {
    fn read_text<'a>(
        &'a self,
        location: &'a SourceLocation,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<TextResource, Error>> + Send + 'a>> {
        Box::pin(async move {
            let text = self.inner.read_text(location).await?;
            let fingerprint = digest(format!("{:?}\n{}", text.location, text.content).as_bytes());
            let mut state = self.task.state.lock().unwrap();
            if state.manifest.as_ref().is_some_and(|v| v != &fingerprint) {
                return Err(self.fail(ResumeError::Invalid("media playlist changed")));
            }
            if state.manifest.is_none() {
                state.manifest = Some(fingerprint);
                self.task.save(&state).map_err(|e| self.fail(e))?;
            }
            Ok(text)
        })
    }
    fn read_bytes<'a>(
        &'a self,
        location: &'a SourceLocation,
        range: Option<&'a ByteRange>,
    ) -> Pin<Box<dyn Future<Output = std::result::Result<Vec<u8>, Error>> + Send + 'a>> {
        Box::pin(async move {
            let key = digest(format!("{:?}|{:?}|{}", location, range, self.headers).as_bytes());
            let data = self.task.directory.join("cache").join(format!("{key}.bin"));
            let meta = data.with_extension("json");
            regular(&data)
                .and_then(|_| regular(&meta))
                .map_err(|e| self.fail(e))?;
            if let (Ok(bytes), Ok(metadata)) = (fs::read(&data), fs::read(&meta)) {
                if let Ok(expected) = serde_json::from_slice::<Checksum>(&metadata) {
                    if expected.length == bytes.len() as u64 && expected.sha256 == digest(&bytes) {
                        return Ok(bytes);
                    }
                }
            }
            let bytes = self.inner.read_bytes(location, range).await?;
            let persist = || -> std::io::Result<()> {
                let mut temp = tempfile::Builder::new()
                    .prefix(".resume-tmp-")
                    .tempfile_in(data.parent().unwrap())?;
                temp.write_all(&bytes)?;
                temp.flush()?;
                temp.as_file().sync_all()?;
                temp.persist(&data).map_err(|e| e.error)?;
                atomic_json(
                    &meta,
                    &Checksum {
                        length: bytes.len() as u64,
                        sha256: digest(&bytes),
                    },
                )
            };
            persist().map_err(|e| self.fail(ResumeError::Io(e)))?;
            Ok(bytes)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusive_lock_releases_and_foreign_directories_are_untouched() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("job");
        let output = root.path().join("out.mp4");
        let task = ResumeTask::open(dir.clone(), "input", output.clone()).unwrap();
        assert!(matches!(
            ResumeTask::open(dir.clone(), "input", output.clone()),
            Err(ResumeError::Conflict)
        ));
        drop(task);
        assert!(ResumeTask::open(dir.clone(), "input", output.clone()).is_ok());
        assert!(matches!(
            ResumeTask::open(dir.clone(), "other", output.clone()),
            Err(ResumeError::Invalid(_))
        ));
        let foreign = root.path().join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("keep"), b"untouched").unwrap();
        assert!(matches!(
            ResumeTask::open(foreign.clone(), "input", output),
            Err(ResumeError::Invalid(_))
        ));
        assert_eq!(fs::read_dir(foreign).unwrap().count(), 1);
    }
    #[test]
    fn publish_recovers_before_and_after_target_commit_and_detects_tampering() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("job");
        let output = root.path().join("out.mp4");
        let task = ResumeTask::open(dir.clone(), "input", output.clone()).unwrap();
        fs::write(dir.join("output.mp4"), b"verified media").unwrap();
        {
            let mut state = task.state.lock().unwrap();
            state.publication = Some(checksum(&dir.join("output.mp4")).unwrap());
            task.save(&state).unwrap();
        }
        // Model a process exiting after output rename, before published=true.
        fs::rename(dir.join("output.mp4"), &output).unwrap();
        drop(task);
        let task = ResumeTask::open(dir.clone(), "input", output.clone()).unwrap();
        assert_eq!(task.publish(None).unwrap(), output);
        assert!(task.state.lock().unwrap().published);
        fs::write(&output, b"changed").unwrap();
        assert!(matches!(task.publish(None), Err(ResumeError::Invalid(_))));
    }
    #[test]
    fn retries_interrupted_staging_and_cleanup_failure_does_not_fail_publication() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("job");
        let output = root.path().join("out.mp4");
        let task = ResumeTask::open(dir.clone(), "input", output.clone()).unwrap();
        fs::write(dir.join("output.mp4"), b"complete output").unwrap();
        let staging = task.staging_path(&task.state.lock().unwrap()).unwrap();
        fs::write(&staging, b"interrupted copy").unwrap();
        // remove_file fails on this managed-name directory; cleanup remains best effort.
        let obstructed = dir.join("cache").join(format!("{}.bin", "a".repeat(64)));
        fs::create_dir(&obstructed).unwrap();
        assert_eq!(task.publish(None).unwrap(), output);
        assert_eq!(fs::read(&output).unwrap(), b"complete output");
        assert!(!staging.exists());
        assert!(obstructed.exists());
        assert_eq!(task.publish(None).unwrap(), output);
    }

    #[test]
    fn publication_failure_retains_local_output_and_receipt() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("job");
        let task =
            ResumeTask::open(dir.clone(), "input", root.path().join("missing/out.mp4")).unwrap();
        fs::write(dir.join("output.mp4"), b"media").unwrap();
        assert!(matches!(task.publish(None), Err(ResumeError::Io(_))));
        assert!(dir.join("output.mp4").exists());
        assert!(task.state.lock().unwrap().publication.is_some());
    }
    #[test]
    fn atomic_state_failure_preserves_previous_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let task = ResumeTask::open(
            root.path().join("job"),
            "input",
            root.path().join("out.mp4"),
        )
        .unwrap();
        let state_path = task.directory.join("state.json");
        let before = fs::read(&state_path).unwrap();
        // Rename-target obstruction models a persistence failure without relying on Unix permissions.
        fs::rename(&state_path, task.directory.join("saved")).unwrap();
        fs::create_dir(&state_path).unwrap();
        assert!(matches!(
            task.save(&task.state.lock().unwrap()),
            Err(ResumeError::Io(_))
        ));
        assert_eq!(fs::read(task.directory.join("saved")).unwrap(), before);
    }
    #[tokio::test]
    async fn offline_finalization_and_failed_publication_retry_need_no_source() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("job");
        let output = root.path().join("out.mp4");
        let task = Arc::new(ResumeTask::open(dir.clone(), "input", output.clone()).unwrap());
        let token = Arc::new(JobCancelToken::new());
        let stop = token.clone();
        let capture = task.clone();
        let input = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../../../test/fixtures/media/fmp4/media.m3u8");
        let result = transmux_hls_to_mp4_async(
            HlsInput::Path(input),
            dir.join("output.mp4"),
            TransmuxOptions {
                output_format: OutputFormat::StreamingMp4,
                cancel: Some(token),
                checkpoint_durability: CheckpointDurability::SyncAll,
                on_progress: Some(Arc::new(move |p| {
                    if p.stage == TransmuxStage::Finalizing {
                        let mut state = capture.state.lock().unwrap();
                        state.checkpoint = Some(p.resume);
                        capture.save(&state).unwrap();
                        stop.cancel();
                    }
                })),
                ..Default::default()
            },
        )
        .await;
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(!task.needs_input());
        // Block target replacement; native completion still has a durable checksum.
        fs::create_dir(&output).unwrap();
        let result = task
            .clone()
            .run(
                "",
                HashMap::new(),
                1,
                1,
                Arc::new(JobCancelToken::new()),
                None,
            )
            .await;
        assert!(matches!(result, Err(ResumeError::Io(_))), "{result:?}");
        assert!(!task.needs_input());
        fs::remove_dir(&output).unwrap();
        drop(task);
        let task = Arc::new(ResumeTask::open(dir.clone(), "input", output.clone()).unwrap());
        assert_eq!(
            task.run(
                "",
                HashMap::new(),
                1,
                1,
                Arc::new(JobCancelToken::new()),
                None
            )
            .await
            .unwrap(),
            output
        );
        assert!(output.exists());
        assert!(!dir.join("output.partial.mp4").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_managed_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("job");
        let task = ResumeTask::open(dir.clone(), "input", root.path().join("out.mp4")).unwrap();
        drop(task);
        fs::remove_file(dir.join("state.json")).unwrap();
        std::os::unix::fs::symlink(root.path().join("outside"), dir.join("state.json")).unwrap();
        assert!(matches!(
            ResumeTask::open(dir, "input", root.path().join("out.mp4")),
            Err(ResumeError::Invalid(_))
        ));
    }
}
