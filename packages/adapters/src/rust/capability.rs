use super::*;
use hls_engine::capabilities::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    id: String,
    container: String,
    encryption: String,
    codecs: Vec<String>,
    scheme: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Query {
    inputs: Vec<Input>,
    output: String,
    mode: Option<String>,
    range: Option<String>,
    embedded_audio: Option<String>,
    playback_target: Option<String>,
    subtitles: Option<bool>,
    decode_gaps: Option<bool>,
    max_bytes: Option<usize>,
    resume: Option<bool>,
    experimental_gcm: Option<bool>,
}
fn input(v: &Input) -> KeyedInputCapability {
    KeyedInputCapability::new(
        match v.container.as_str() {
            "ts" => KeyedContainer::TransportStream,
            "fmp4" => KeyedContainer::FragmentedMp4,
            "packed-aac" => KeyedContainer::PackedAac,
            _ => KeyedContainer::Other,
        },
        match v.encryption.as_str() {
            "clear" => KeyedEncryption::Clear,
            "AES-128" => KeyedEncryption::Aes128,
            "clear-and-aes128" => KeyedEncryption::ClearAndAes128,
            "SAMPLE-AES" => KeyedEncryption::SampleAes,
            "SAMPLE-AES-CTR" => KeyedEncryption::SampleAesCtr,
            "AES-256-GCM" => KeyedEncryption::Aes256Gcm,
            _ => KeyedEncryption::Other,
        },
        v.codecs
            .iter()
            .map(|c| match c.as_str() {
                "avc" => KeyedCodec::Avc,
                "hevc" => KeyedCodec::Hevc,
                "aac-lc" => KeyedCodec::AacLc,
                _ => KeyedCodec::Other,
            })
            .collect(),
    )
    .with_scheme(match v.scheme.as_deref().unwrap_or("none") {
        "none" => KeyedProtectionScheme::None,
        "cenc" => KeyedProtectionScheme::Cenc,
        "cbcs" => KeyedProtectionScheme::Cbcs,
        _ => KeyedProtectionScheme::Other,
    })
}
pub fn query(text: &str) -> String {
    let run = || -> std::result::Result<Value, Value> {
        let q: Query = serde_json::from_str(text)
            .map_err(|_| error("UNSUPPORTED_OUTPUT", "InvalidCapabilityQuery"))?;
        let first = q
            .inputs
            .first()
            .ok_or_else(|| error("UNSUPPORTED_OUTPUT", "MissingInput"))?;
        let id = |s: &str| InputId::new(s).map_err(|_| error("UNSUPPORTED_OUTPUT", "InvalidInput"));
        let output = match q.output.as_str() {
            "blob" => KeyedOutput::Mp4Bytes,
            "writable" => KeyedOutput::FragmentedWriter,
            "file-mp4" => KeyedOutput::NativeStreamingFile,
            "file-fmp4" => KeyedOutput::FragmentedFile,
            _ => return Err(error("UNSUPPORTED_OUTPUT", "InvalidOutput")),
        };
        let mut query = CapabilityQuery::new(
            id(&first.id)?,
            input(first),
            output,
            match q.embedded_audio.as_deref().unwrap_or("keep") {
                "keep" => EmbeddedAudio::Keep,
                "exclude" => EmbeddedAudio::Exclude,
                _ => return Err(error("UNSUPPORTED_OUTPUT", "InvalidSelection")),
            },
        )
        .with_source_mode(match q.mode.as_deref().unwrap_or("vod") {
            "vod" => KeyedSourceMode::FiniteVod,
            "live" => KeyedSourceMode::Live,
            "event" => KeyedSourceMode::Event,
            _ => KeyedSourceMode::RewrittenSnapshot,
        })
        .with_range(match q.range.as_deref().unwrap_or("whole-resources") {
            "whole-resources" => KeyedRange::WholeResources,
            "clear-byte-ranges" => KeyedRange::ClearByteRanges,
            "complete-encrypted-resources" => KeyedRange::CompleteEncryptedResources,
            "presentation" => KeyedRange::PresentationRange,
            "iframe" => KeyedRange::IFrameRanges,
            _ => KeyedRange::ArbitraryEncryptedRanges,
        })
        .with_playback(match q.playback_target.as_deref().unwrap_or("container") {
            "container" => MultiTrackPlayback::Container,
            "direct-browser" => MultiTrackPlayback::DirectBrowser,
            "avfoundation" => MultiTrackPlayback::AvFoundation,
            "vlc" => MultiTrackPlayback::Vlc,
            "iina" => MultiTrackPlayback::Iina,
            "ffmpeg" => MultiTrackPlayback::Ffmpeg,
            _ => return Err(error("UNSUPPORTED_OUTPUT", "UnknownPlaybackTarget")),
        })
        .with_host_waiter(true)
        .with_subtitles(q.subtitles.unwrap_or(false))
        .with_decode_gaps(q.decode_gaps.unwrap_or(false))
        .with_resume(q.resume.unwrap_or(false))
        .with_experimental_gcm(q.experimental_gcm.unwrap_or(false));
        if let Some(n) = q.max_bytes {
            query = query.with_memory_capacity(n);
        }
        for a in q.inputs.iter().skip(1) {
            query = query.with_audio(id(&a.id)?, input(a));
        }
        let d = query_capability(&query);
        let reject = |r: &MultiTrackCapabilityRejection| json!({"inputId":r.input_id().map(|i|i.as_str()),"dimension":format!("{:?}",r.dimension())});
        Ok(
            json!({"supported":d.supported(),"containerSupported":d.container_supported(),"playbackSupported":d.playback_supported(),
          "rejections":d.rejections().iter().map(reject).collect::<Vec<_>>(),"containerRejections":d.container_rejections().iter().map(reject).collect::<Vec<_>>(),
          "playbackRejection":d.playback_rejection().map(|r|format!("{r:?}")),"requirements":d.requirements().iter().map(|r|format!("{r:?}")).collect::<Vec<_>>()}),
        )
    };
    run().unwrap_or_else(|e| e).to_string()
}
