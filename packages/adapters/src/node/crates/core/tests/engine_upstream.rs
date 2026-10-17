//! Contract checks against the registry Engine API; no legacy execution helpers.
use hls_engine::{crypto::key::*, playlist::*, *};
use std::sync::{Arc, Mutex};
struct Clock;
impl KeyClock for Clock {
    fn now(&self) -> u64 {
        0
    }
}
struct NoKeys;
impl KeyProvider for NoKeys {
    fn resolve(&self, _: KeyRequest) -> KeyFuture<KeyResolution> {
        Box::pin(async { KeyResolution::Unavailable })
    }
}
fn session(checkpoint: Option<EngineCheckpoint>) -> EngineSession {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../../../test/fixtures/media/ts");
    let input = InputId::new("primary").unwrap();
    let source = MemorySource::new()
        .segment(
            "https://fixture.test/segment-00.ts",
            std::fs::read(root.join("segment-00.ts")).unwrap(),
        )
        .segment(
            "https://fixture.test/segment-01.ts",
            std::fs::read(root.join("segment-01.ts")).unwrap(),
        );
    let keys = KeySession::new(
        "test",
        "test",
        Arc::new(NoKeys),
        Arc::new(Clock),
        KeySessionOptions::default(),
    )
    .unwrap();
    let inputs = EngineInputs::new(
        EngineInput::new(input.clone(), Arc::new(source)),
        EmbeddedAudio::Keep,
    );
    let terminal = checkpoint
        .as_ref()
        .is_some_and(|c| c.is_completed() || c.is_finalizing());
    let engine = match checkpoint {
        Some(c) => EngineSession::restore(inputs, keys, EngineOptions::default(), c),
        None => EngineSession::new(inputs, keys, EngineOptions::default()),
    }
    .unwrap();
    if !terminal {
        let snapshot = parse_playlist_snapshot(
            &TextResource {
                location: SourceLocation::Url(
                    url::Url::parse("https://fixture.test/media.m3u8").unwrap(),
                ),
                content: std::fs::read_to_string(root.join("media.m3u8")).unwrap(),
            },
            PlaylistContext::new(input.clone(), 0),
        )
        .unwrap();
        engine.handle().accept_snapshot(&input, &snapshot).unwrap();
        engine.handle().end_input(&input).unwrap();
    }
    engine
}
#[tokio::test]
async fn finite_eof_and_bounded_collection() {
    let (bytes, report) = session(None)
        .into_bytes(8 * 1024 * 1024, OutputFormat::FragmentedMp4)
        .await
        .unwrap();
    assert!(bytes.windows(4).any(|w| w == b"moof"));
    assert_eq!(report.media().inputs()[0].committed(), 2);
    assert_eq!(
        session(None)
            .into_bytes(32, OutputFormat::FragmentedMp4)
            .await
            .unwrap_err()
            .kind(),
        EngineErrorKind::BudgetExceeded
    );
}
#[tokio::test]
async fn durable_checkpoint_roundtrip_and_offline_terminal_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("output.mp4");
    let saved = Arc::new(Mutex::new(None));
    let capture = saved.clone();
    let result = session(None)
        .write_recoverable_to_file(
            &path,
            RecoveryOptions::new(Arc::new(move |c| {
                *capture.lock().unwrap() = Some(c);
                Ok(())
            }))
            .with_durability(CheckpointDurability::SyncAll),
        )
        .await
        .unwrap();
    assert_eq!(result.media().inputs()[0].committed(), 2);
    let cp = saved.lock().unwrap().take().unwrap();
    assert!(cp.is_completed());
    let value = serde_json::to_value(&cp).unwrap();
    assert_eq!(value["schema_version"], 2);
    let cp: EngineCheckpoint = serde_json::from_value(value).unwrap();
    let before = std::fs::read(&path).unwrap();
    session(Some(cp.clone()))
        .write_recoverable_to_file(&path, RecoveryOptions::new(Arc::new(|_| Ok(()))))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::write(&path, b"unrelated").unwrap();
    let error = session(Some(cp))
        .write_recoverable_to_file(&path, RecoveryOptions::new(Arc::new(|_| Ok(()))))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), EngineErrorKind::ResumeCorruption);
    assert_eq!(std::fs::read(&path).unwrap(), b"unrelated");
}

/// Release gate: compare decoded samples from the same EngineSession's file and
/// borrowed-writer outputs. Do not regenerate a golden to conceal media changes.
#[tokio::test]
async fn classic_file_preserves_decode_gaps() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../../../test/fixtures/timeline");
    let cases: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(root.join("supplemental.json")).unwrap()).unwrap();
    let c = cases.iter().find(|c| c["name"] == "negative-cts").unwrap();
    let make = || {
        let input = InputId::new("primary").unwrap();
        let mut source = MemorySource::new();
        for (url, file) in c["files"].as_object().unwrap() {
            source = source.segment(
                url,
                std::fs::read(root.join(file.as_str().unwrap())).unwrap(),
            );
        }
        let keys = KeySession::new(
            "test",
            "test",
            Arc::new(NoKeys),
            Arc::new(Clock),
            KeySessionOptions::default(),
        )
        .unwrap();
        let mut options = EngineOptions::default();
        if !c["selection"]["range"].is_null() {
            options = options
                .with_range(serde_json::from_value(c["selection"]["range"].clone()).unwrap());
        }
        let engine = EngineSession::new(
            EngineInputs::new(
                EngineInput::new(input.clone(), Arc::new(source)),
                EmbeddedAudio::Keep,
            ),
            keys,
            options,
        )
        .unwrap();
        let snapshot = parse_playlist_snapshot(
            &TextResource {
                location: SourceLocation::Url(
                    url::Url::parse(c["request"]["primary"]["url"].as_str().unwrap()).unwrap(),
                ),
                content: c["request"]["primary"]["text"].as_str().unwrap().into(),
            },
            PlaylistContext::new(input.clone(), 0),
        )
        .unwrap();
        engine.handle().accept_snapshot(&input, &snapshot).unwrap();
        engine.handle().end_input(&input).unwrap();
        engine
    };
    let dir = tempfile::tempdir().unwrap();
    let classic = dir.path().join("classic.mp4");
    let fragmented = dir.path().join("fragmented.mp4");
    make()
        .write_to_file(
            &classic,
            FileOutputOptions::default().with_format(OutputFormat::Mp4),
        )
        .await
        .unwrap();
    let (bytes, _) = make()
        .into_bytes(8 * 1024 * 1024, OutputFormat::FragmentedMp4)
        .await
        .unwrap();
    std::fs::write(&fragmented, bytes).unwrap();
    let hashes = |path: &std::path::Path| {
        let output = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(path)
            .args(["-map", "0:a:0", "-f", "framemd5", "-"])
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter(|s| !s.starts_with('#') && !s.is_empty())
            .map(|s| s.rsplit(',').next().unwrap().trim().to_string())
            .collect::<Vec<_>>()
    };
    let classic_hashes = hashes(&classic);
    let fragmented_hashes = hashes(&fragmented);
    assert_eq!(
        classic_hashes.len(),
        fragmented_hashes.len(),
        "hls-engine registry classic finalization changed decoded audio frame count"
    );
    assert_eq!(
        classic_hashes, fragmented_hashes,
        "hls-engine registry classic finalization changed decoded audio payloads"
    );
}
