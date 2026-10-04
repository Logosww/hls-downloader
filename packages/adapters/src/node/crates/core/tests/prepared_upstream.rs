use hls_transmux::*;
use std::{
    path::PathBuf,
    pin::Pin,
    task::{Context, Poll},
};
fn media(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../../../test/fixtures/media")
        .join(name)
}
fn inputs() -> HlsInputs {
    HlsInputs::new(HlsInput::Path(media("ts/media.m3u8")))
        .with_audio(HlsInput::Path(media("audio-ts/media.m3u8")))
}
#[tokio::test]
async fn prepared_outputs_share_timeline_and_selected_tracks() {
    let prepared = prepare_hls(inputs(), PrepareOptions::default())
        .await
        .unwrap();
    let mapping = prepared.info().timeline().clone();
    assert_eq!(prepared.info().tracks().len(), 2);
    let (bytes, batch) = prepared.into_mp4_bytes().await.unwrap();
    assert!(bytes.windows(4).any(|w| w == b"moov"));
    let mut writer = Vec::new();
    let stream = prepare_hls(inputs(), PrepareOptions::default().with_write_mfra(false))
        .await
        .unwrap()
        .write_to(&mut writer)
        .await
        .unwrap();
    assert_eq!(batch.timeline(), &mapping);
    assert_eq!(stream.timeline(), &mapping);
    assert_eq!(batch.media().segment_count, 6);
    assert!(!writer.windows(4).any(|w| w == b"mfra"));
    let dir = tempfile::tempdir().unwrap();
    let file = prepare_hls(inputs(), PrepareOptions::default())
        .await
        .unwrap()
        .write_to_file(dir.path().join("out.mp4"), FileOutputOptions::default())
        .await
        .unwrap();
    assert_eq!(file.timeline(), &mapping);
}
struct BrokenWriter;
impl tokio::io::AsyncWrite for BrokenWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Poll::Ready(Err(std::io::Error::other("broken sink")))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
#[tokio::test]
async fn writer_failure_has_structured_phase_without_input_role() {
    let e = prepare_hls(inputs(), PrepareOptions::default())
        .await
        .unwrap()
        .write_to(&mut BrokenWriter)
        .await
        .unwrap_err();
    assert_eq!(e.phase(), SessionPhase::Writing);
    assert_eq!(e.role(), None);
    assert!(matches!(e.error(), Error::Io(_)));
}
#[tokio::test]
async fn cancelled_prepare_never_reads_inputs() {
    let token = std::sync::Arc::new(hls_core::JobCancelToken::new());
    token.cancel();
    let result = prepare_hls(inputs(), PrepareOptions::default().with_cancel(token)).await;
    assert!(matches!(result.err().unwrap().error(), Error::Cancelled));
}

#[derive(Debug)]
struct CountingSource(std::sync::atomic::AtomicUsize);
impl Source for CountingSource {
    fn read_text<'a>(
        &'a self,
        location: &'a SourceLocation,
    ) -> Pin<Box<dyn std::future::Future<Output = hls_transmux::Result<TextResource>> + Send + 'a>>
    {
        Box::pin(async move {
            let SourceLocation::File(path) = location else {
                panic!("file input expected")
            };
            Ok(TextResource {
                content: std::fs::read_to_string(path)?,
                location: location.clone(),
            })
        })
    }
    fn read_bytes<'a>(
        &'a self,
        location: &'a SourceLocation,
        range: Option<&'a ByteRange>,
    ) -> Pin<Box<dyn std::future::Future<Output = hls_transmux::Result<Vec<u8>>> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let SourceLocation::File(path) = location else {
                panic!("file input expected")
            };
            let bytes = std::fs::read(path)?;
            Ok(if let Some(r) = range {
                bytes[r.offset as usize..(r.offset + r.length) as usize].to_vec()
            } else {
                bytes
            })
        })
    }
}
struct BlockedWriter(std::sync::Arc<tokio::sync::Notify>);
impl tokio::io::AsyncWrite for BlockedWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        self.0.notify_one();
        Poll::Pending
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
#[tokio::test]
async fn blocked_writer_stops_reads_and_remains_cancellable() {
    use std::sync::{Arc, atomic::Ordering};
    let source = Arc::new(CountingSource(Default::default()));
    let input = |path| HlsInput::custom(source.clone(), SourceLocation::File(media(path)));
    let token = Arc::new(hls_core::JobCancelToken::new());
    let prepared = prepare_hls(
        HlsInputs::new(input("ts/media.m3u8")).with_audio(input("audio-ts/media.m3u8")),
        PrepareOptions::default()
            .with_cancel(token.clone())
            .with_budget(ResourceBudget::default().with_max_in_flight_reads(1)),
    )
    .await
    .unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let mut writer = BlockedWriter(entered.clone());
    let task = tokio::spawn(async move { prepared.write_to(&mut writer).await });
    entered.notified().await;
    let reads = source.0.load(Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(source.0.load(Ordering::SeqCst), reads);
    token.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result.unwrap_err().error(), Error::Cancelled));
}

#[tokio::test]
async fn missing_audio_reports_input_role_and_playlist_phase() {
    let missing = media("audio-ts/missing.m3u8");
    let error = prepare_hls(
        HlsInputs::new(HlsInput::Path(media("ts/media.m3u8"))).with_audio(HlsInput::Path(missing)),
        PrepareOptions::default(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.role(), Some(InputRole::Audio));
    assert_eq!(error.phase(), SessionPhase::Playlist);
    assert!(error.resource().is_some());
}
