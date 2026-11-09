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
fn input(v: &Input) -> InputCapability {
    InputCapability::new(
        match v.container.as_str() {
            "ts" => InputContainer::TransportStream,
            "fmp4" => InputContainer::FragmentedMp4,
            "packed-aac" => InputContainer::PackedAac,
            _ => InputContainer::Other,
        },
        match v.encryption.as_str() {
            "clear" => InputEncryption::Clear,
            "AES-128" => InputEncryption::Aes128,
            "clear-and-aes128" => InputEncryption::ClearAndAes128,
            "SAMPLE-AES" => InputEncryption::SampleAes,
            "SAMPLE-AES-CTR" => InputEncryption::SampleAesCtr,
            "AES-256-GCM" => InputEncryption::Aes256Gcm,
            _ => InputEncryption::Other,
        },
        v.codecs
            .iter()
            .map(|c| match c.as_str() {
                "avc" => InputCodec::Avc,
                "hevc" => InputCodec::Hevc,
                "aac-lc" => InputCodec::AacLc,
                _ => InputCodec::Other,
            })
            .collect(),
    )
    .with_scheme(match v.scheme.as_deref().unwrap_or("none") {
        "none" => InputProtectionScheme::None,
        "cenc" => InputProtectionScheme::Cenc,
        "cbcs" => InputProtectionScheme::Cbcs,
        _ => InputProtectionScheme::Other,
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
            "blob" => OutputTarget::Mp4Bytes,
            "writable" => OutputTarget::FragmentedWriter,
            "file-mp4" => OutputTarget::NativeStreamingFile,
            "file-fmp4" => OutputTarget::FragmentedFile,
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
            "vod" => SourceMode::FiniteVod,
            "live" => SourceMode::Live,
            "event" => SourceMode::Event,
            _ => SourceMode::RewrittenSnapshot,
        })
        .with_range(match q.range.as_deref().unwrap_or("whole-resources") {
            "whole-resources" => RangeCapability::WholeResources,
            "clear-byte-ranges" => RangeCapability::ClearByteRanges,
            "complete-encrypted-resources" => RangeCapability::CompleteEncryptedResources,
            "presentation" => RangeCapability::PresentationRange,
            "iframe" => RangeCapability::IFrameRanges,
            _ => RangeCapability::ArbitraryEncryptedRanges,
        })
        .with_playback(match q.playback_target.as_deref().unwrap_or("container") {
            "container" => PlaybackTarget::Container,
            "direct-browser" => PlaybackTarget::DirectBrowser,
            "avfoundation" => PlaybackTarget::AvFoundation,
            "vlc" => PlaybackTarget::Vlc,
            "iina" => PlaybackTarget::Iina,
            "ffmpeg" => PlaybackTarget::Ffmpeg,
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
        let reject = |r: &InputCapabilityRejection| json!({"inputId":r.input_id().map(|i|i.as_str()),"dimension":format!("{:?}",r.dimension())});
        Ok(
            json!({"supported":d.supported(),"containerSupported":d.container_supported(),"playbackSupported":d.playback_supported(),
          "rejections":d.rejections().iter().map(reject).collect::<Vec<_>>(),"containerRejections":d.container_rejections().iter().map(reject).collect::<Vec<_>>(),
          "playbackRejection":d.playback_rejection().map(|r|format!("{r:?}")),"requirements":d.requirements().iter().map(|r|format!("{r:?}")).collect::<Vec<_>>()}),
        )
    };
    run().unwrap_or_else(|e| e).to_string()
}
