//! Contract tests against the released upstream crate; no patched mux code.
use hls_core::JobCancelToken;
use hls_transmux::*;
use std::sync::{Arc, Mutex};

fn input(kind: &str) -> HlsInput {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../../../../../test/fixtures/media/{kind}/media.m3u8"
    ));
    HlsInput::Path(root)
}

#[tokio::test]
async fn checkpoint_cancel_tail_recovery_and_offline_finalize() {
    for kind in ["ts", "fmp4", "byterange"] {
        for stop_stage in [TransmuxStage::Downloading, TransmuxStage::Finalizing] {
            let dir = tempfile::tempdir().unwrap();
            let output = dir.path().join("result.mp4");
            let partial = dir.path().join("result.partial.mp4");
            let token = Arc::new(JobCancelToken::new());
            let saved = Arc::new(Mutex::new(None));
            let capture = saved.clone();
            let cancel = token.clone();
            let result = transmux_hls_to_mp4_async(
                input(kind),
                &output,
                TransmuxOptions {
                    output_format: OutputFormat::StreamingMp4,
                    checkpoint_durability: CheckpointDurability::SyncAll,
                    cancel: Some(token),
                    on_progress: Some(Arc::new(move |p| {
                        if p.stage == stop_stage {
                            *capture.lock().unwrap() = Some(p.resume);
                            cancel.cancel();
                        }
                    })),
                    ..Default::default()
                },
            )
            .await;
            assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
            let state: TransmuxResumeState = serde_json::from_slice(
                &serde_json::to_vec(&saved.lock().unwrap().clone().unwrap()).unwrap(),
            )
            .unwrap();
            assert!(partial.exists());
            if stop_stage == TransmuxStage::Downloading {
                // Reject truncated committed data without mutating the evidence.
                let prefix = std::fs::read(&partial).unwrap();
                let truncated = &prefix[..state.bytes_written as usize - 1];
                std::fs::write(&partial, truncated).unwrap();
                assert!(
                    transmux_hls_to_mp4_async(
                        input(kind),
                        &output,
                        TransmuxOptions {
                            output_format: OutputFormat::StreamingMp4,
                            resume: Some(state.clone()),
                            ..Default::default()
                        }
                    )
                    .await
                    .is_err()
                );
                assert_eq!(std::fs::read(&partial).unwrap(), truncated);
                std::fs::write(&partial, prefix).unwrap();
                use std::io::Write;
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&partial)
                    .unwrap()
                    .write_all(b"uncommitted tail")
                    .unwrap();
            }
            let source = if stop_stage == TransmuxStage::Finalizing {
                HlsInput::Path(dir.path().join("does-not-exist.m3u8"))
            } else {
                input(kind)
            };
            let report = transmux_hls_to_mp4_async(
                source,
                &output,
                TransmuxOptions {
                    output_format: OutputFormat::StreamingMp4,
                    checkpoint_durability: CheckpointDurability::SyncAll,
                    resume: Some(state),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(report.segment_count, 2);
            assert!(output.metadata().unwrap().len() > 0);
        }
    }
}
