use std::cell::RefCell;
use std::collections::HashMap;

use muxide::api::{AacProfile, AudioCodec, MuxerBuilder, VideoCodec};
use muxide::codec::h264::{extract_avc_config, is_h264_keyframe};
use mpeg2ts_reader::demultiplex::{self, DemuxContext, FilterRequest};
use mpeg2ts_reader::pes::{
    self, ElementaryStreamConsumer, PesContents, PesHeader, PtsDts, Timestamp,
};
use mpeg2ts_reader::psi::pat::PAT_PID;
use mpeg2ts_reader::{packet_filter_switch, StreamType};

use crate::download::{download_segments_to_dir, DownloadProgress, ProgressCallback};
use crate::hls::Segment;
use crate::HlsError;

const TS_CLOCK_HZ: f64 = 90_000.0;

#[derive(Clone, Debug)]
struct VideoSample {
    pts: f64,
    dts: Option<f64>,
    data: Vec<u8>,
    is_keyframe: bool,
}

#[derive(Clone, Debug)]
struct AudioSample {
    pts: f64,
    data: Vec<u8>,
}

#[derive(Default)]
struct AudioPesBuffer {
    next_pts: Option<f64>,
    data: Vec<u8>,
}

impl AudioPesBuffer {
    fn append_packet(&mut self, header: PesHeader<'_>) {
        let (pts, _) = timestamps_from_header(&header);
        if self.data.is_empty() {
            self.next_pts = pts;
        }
        append_payload_from_header(&mut self.data, header);
    }

    fn append(&mut self, chunk: &[u8]) {
        self.data.extend_from_slice(chunk);
    }

    fn drain_complete_frames(&mut self) -> Vec<AudioSample> {
        let mut samples = Vec::new();
        let mut pts = self.next_pts.unwrap_or(0.0);
        let mut offset = 0usize;

        while offset + 7 <= self.data.len() {
            if self.data[offset] != 0xFF || (self.data[offset + 1] & 0xF0) != 0xF0 {
                offset += 1;
                continue;
            }
            let Some(frame_len) = adts_frame_length(&self.data[offset..]) else {
                break;
            };
            if offset + frame_len > self.data.len() {
                break;
            }
            let frame = self.data[offset..offset + frame_len].to_vec();
            let step = adts_frame_duration_secs(&frame);
            samples.push(AudioSample { pts, data: frame });
            pts += step;
            offset += frame_len;
        }

        if offset > 0 {
            self.data.drain(0..offset);
        }
        self.next_pts = Some(pts);
        samples
    }
}

#[derive(Default)]
struct DemuxOutput {
    video: Vec<VideoSample>,
    audio: Vec<AudioSample>,
}

struct VideoConsumer;
struct AudioConsumer;

#[derive(Default)]
struct VideoPesBuffer {
    pts: Option<f64>,
    dts: Option<f64>,
    data: Vec<u8>,
}

impl VideoPesBuffer {
    fn begin(&mut self, header: PesHeader<'_>) {
        self.data.clear();
        let (pts, dts) = timestamps_from_header(&header);
        self.pts = pts;
        self.dts = dts;
        append_payload_from_header(&mut self.data, header);
    }

    fn push(&mut self, data: &[u8]) {
        self.data.extend_from_slice(data);
    }
}

impl ElementaryStreamConsumer<TsDemuxContext> for VideoConsumer {
    fn start_stream(&mut self, _ctx: &mut TsDemuxContext) {}

    fn begin_packet(&mut self, ctx: &mut TsDemuxContext, header: PesHeader<'_>) {
        ctx.video_buf.borrow_mut().begin(header);
    }

    fn continue_packet(&mut self, ctx: &mut TsDemuxContext, data: &[u8]) {
        ctx.video_buf.borrow_mut().push(data);
    }

    fn end_packet(&mut self, ctx: &mut TsDemuxContext) {
        let mut buf = ctx.video_buf.borrow_mut();
        if buf.data.is_empty() {
            return;
        }
        let data = ensure_annex_b(&buf.data);
        let pts = buf.pts.unwrap_or(0.0);
        let dts = buf.dts;
        let is_keyframe = is_h264_keyframe(&data);
        ctx.output.borrow_mut().video.push(VideoSample {
            pts,
            dts,
            data,
            is_keyframe,
        });
        buf.data.clear();
    }

    fn continuity_error(&mut self, _ctx: &mut TsDemuxContext) {}
}

impl ElementaryStreamConsumer<TsDemuxContext> for AudioConsumer {
    fn start_stream(&mut self, _ctx: &mut TsDemuxContext) {}

    fn begin_packet(&mut self, ctx: &mut TsDemuxContext, header: PesHeader<'_>) {
        ctx.audio_buf.borrow_mut().append_packet(header);
    }

    fn continue_packet(&mut self, ctx: &mut TsDemuxContext, data: &[u8]) {
        ctx.audio_buf.borrow_mut().append(data);
    }

    fn end_packet(&mut self, ctx: &mut TsDemuxContext) {
        let frames = ctx.audio_buf.borrow_mut().drain_complete_frames();
        ctx.output.borrow_mut().audio.extend(frames);
    }

    fn continuity_error(&mut self, _ctx: &mut TsDemuxContext) {}
}

packet_filter_switch! {
    TsFilterSwitch<TsDemuxContext> {
        Pat: demultiplex::PatPacketFilter<TsDemuxContext>,
        Pmt: demultiplex::PmtPacketFilter<TsDemuxContext>,
        Video: pes::PesPacketFilter<TsDemuxContext, VideoConsumer>,
        Audio: pes::PesPacketFilter<TsDemuxContext, AudioConsumer>,
        Null: demultiplex::NullPacketFilter<TsDemuxContext>,
    }
}

pub struct TsDemuxContext {
    changeset: demultiplex::FilterChangeset<TsFilterSwitch>,
    video_buf: RefCell<VideoPesBuffer>,
    audio_buf: RefCell<AudioPesBuffer>,
    output: RefCell<DemuxOutput>,
}

impl Default for TsDemuxContext {
    fn default() -> Self {
        Self {
            changeset: demultiplex::FilterChangeset::default(),
            video_buf: RefCell::new(VideoPesBuffer::default()),
            audio_buf: RefCell::new(AudioPesBuffer::default()),
            output: RefCell::new(DemuxOutput::default()),
        }
    }
}

impl TsDemuxContext {
    fn do_construct(&mut self, req: FilterRequest<'_, '_>) -> TsFilterSwitch {
        match req {
            FilterRequest::ByPid(pid) if pid == PAT_PID => {
                TsFilterSwitch::Pat(demultiplex::PatPacketFilter::default())
            }
            FilterRequest::Pmt { pid, program_number } => TsFilterSwitch::Pmt(
                demultiplex::PmtPacketFilter::new(pid, program_number),
            ),
            FilterRequest::ByStream { stream_type, .. }
                if stream_type == StreamType::H264 || stream_type == StreamType::H265 =>
            {
                TsFilterSwitch::Video(pes::PesPacketFilter::new(VideoConsumer))
            }
            FilterRequest::ByStream {
                stream_type: StreamType::ADTS,
                ..
            } => TsFilterSwitch::Audio(pes::PesPacketFilter::new(AudioConsumer)),
            FilterRequest::ByStream { .. }
            | FilterRequest::ByPid(_)
            | FilterRequest::Nit { .. } => {
                TsFilterSwitch::Null(demultiplex::NullPacketFilter::default())
            }
        }
    }
}

impl DemuxContext for TsDemuxContext {
    type F = TsFilterSwitch;

    fn filter_changeset(&mut self) -> &mut demultiplex::FilterChangeset<Self::F> {
        &mut self.changeset
    }

    fn construct(&mut self, req: FilterRequest<'_, '_>) -> Self::F {
        self.do_construct(req)
    }
}

fn append_payload_from_header(buf: &mut Vec<u8>, header: PesHeader<'_>) {
    match header.contents() {
        PesContents::Parsed(Some(parsed)) => buf.extend_from_slice(parsed.payload()),
        PesContents::Parsed(None) => {}
        PesContents::Payload(payload) => buf.extend_from_slice(payload),
    }
}

fn timestamps_from_header(header: &PesHeader<'_>) -> (Option<f64>, Option<f64>) {
    let PesContents::Parsed(Some(parsed)) = header.contents() else {
        return (None, None);
    };
    let Ok(ts) = parsed.pts_dts() else {
        return (None, None);
    };

    match ts {
        PtsDts::None | PtsDts::Invalid => (None, None),
        PtsDts::PtsOnly(Ok(pts)) => (Some(ts_to_secs(pts)), None),
        PtsDts::Both {
            pts: Ok(pts),
            dts: Ok(dts),
        } => (Some(ts_to_secs(pts)), Some(ts_to_secs(dts))),
        PtsDts::Both {
            pts: Ok(pts),
            dts: Err(_),
        } => (Some(ts_to_secs(pts)), None),
        PtsDts::Both {
            pts: Err(_),
            dts: Ok(dts),
        } => (Some(ts_to_secs(dts)), Some(ts_to_secs(dts))),
        _ => (None, None),
    }
}

fn ts_to_secs(ts: Timestamp) -> f64 {
    ts.value() as f64 / TS_CLOCK_HZ
}

fn ensure_annex_b(data: &[u8]) -> Vec<u8> {
    if data.starts_with(&[0, 0, 1]) || data.starts_with(&[0, 0, 0, 1]) {
        return data.to_vec();
    }
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&[0, 0, 0, 1]);
    out.extend_from_slice(data);
    out
}

fn parse_adts_config(data: &[u8]) -> Option<(u32, u16)> {
    if data.len() < 7 || data[0] != 0xFF || (data[1] & 0xF0) != 0xF0 {
        return None;
    }
    let sample_rates = [
        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ];
    let sr_index = ((data[2] & 0x3C) >> 2) as usize;
    let sample_rate = *sample_rates.get(sr_index)?;
    let channel_config = (((data[2] & 0x01) << 2) | ((data[3] & 0xC0) >> 6)) as u16;
    let channels = if channel_config == 0 { 2 } else { channel_config };
    Some((sample_rate, channels))
}

fn adts_frame_length(data: &[u8]) -> Option<usize> {
    if data.len() < 7 || data[0] != 0xFF || (data[1] & 0xF0) != 0xF0 {
        return None;
    }
    let len = ((usize::from(data[3] & 0x03) << 11)
        | (usize::from(data[4]) << 3)
        | (usize::from(data[5]) >> 5))
        .max(7);
    if len <= data.len() {
        Some(len)
    } else {
        None
    }
}

fn adts_samples_per_frame(data: &[u8]) -> u32 {
    if data.len() < 3 {
        return 1024;
    }
    // profile_object_type = 2-bit profile + 1
    let object_type = u32::from((data[2] >> 6) & 0x03) + 1;
    match object_type {
        5 | 29 => 2048,
        _ => 1024,
    }
}

fn adts_frame_duration_secs(data: &[u8]) -> f64 {
    let samples = adts_samples_per_frame(data) as f64;
    let rate = parse_adts_config(data)
        .map(|(r, _)| r as f64)
        .unwrap_or(48_000.0);
    samples / rate
}

#[cfg(test)]
/// Split a buffer that may contain multiple ADTS access units.
fn split_adts_frames(data: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset + 7 <= data.len() {
        if data[offset] != 0xFF || (data[offset + 1] & 0xF0) != 0xF0 {
            offset += 1;
            continue;
        }
        let Some(frame_len) = adts_frame_length(&data[offset..]) else {
            offset += 1;
            continue;
        };
        frames.push(data[offset..offset + frame_len].to_vec());
        offset += frame_len;
    }
    frames
}

fn parse_sps_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    let config = extract_avc_config(data)?;
    parse_sps_size(&config.sps)
}

fn parse_sps_size(sps: &[u8]) -> Option<(u32, u32)> {
    if sps.len() < 4 {
        return None;
    }
    let mut reader = BitReader::new(sps);
    reader.read_bits(8)?;
    reader.read_bits(8)?;
    reader.read_bits(8)?;
    reader.read_ue()?;
    if reader.read_bits(1)? == 1 {
        reader.read_ue()?;
        reader.read_ue()?;
        reader.read_bits(1)?;
        if reader.read_bits(1)? == 1 {
            let count = reader.read_ue()?;
            for _ in 0..count {
                reader.read_bits(8)?;
            }
        }
    }
    reader.read_ue()?;
    let pic_order_cnt_type = reader.read_ue()?;
    match pic_order_cnt_type {
        0 => {
            reader.read_ue()?;
        }
        1 => {
            reader.read_bits(1)?;
            reader.read_ue()?;
            let cycles = reader.read_ue()?;
            for _ in 0..cycles {
                reader.read_se()?;
            }
        }
        _ => {}
    }
    reader.read_ue()?;
    reader.read_bits(1)?;
    let width_mbs = reader.read_ue()?;
    let height_map = reader.read_ue()?;
    let frame_mbs_only = reader.read_bits(1)?;
    let height = if frame_mbs_only == 1 {
        (height_map + 1) * 16
    } else {
        (height_map + 1) * 32
    };
    Some(((width_mbs + 1) * 16, height))
}

struct BitReader<'a> {
    data: &'a [u8],
    bit_pos: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, bit_pos: 0 }
    }

    fn read_bits(&mut self, n: u32) -> Option<u32> {
        let mut value = 0u32;
        for _ in 0..n {
            let byte_index = self.bit_pos / 8;
            let bit_index = 7 - (self.bit_pos % 8);
            let bit = (*self.data.get(byte_index)? >> bit_index) & 1;
            value = (value << 1) | u32::from(bit);
            self.bit_pos += 1;
        }
        Some(value)
    }

    fn read_ue(&mut self) -> Option<u32> {
        let mut zeros = 0u32;
        while self.read_bits(1)? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        if zeros == 0 {
            return Some(0);
        }
        let suffix = self.read_bits(zeros)?;
        Some((1 << zeros) - 1 + suffix)
    }

    fn read_se(&mut self) -> Option<i32> {
        let ue = self.read_ue()?;
        Some(if ue % 2 == 0 {
            -(ue as i32 / 2)
        } else {
            (ue as i32 + 1) / 2
        })
    }
}

fn normalize_video_timestamps(video: &mut [VideoSample]) {
    const MIN_STEP: f64 = 1.0 / 90_000.0;
    let mut last = -MIN_STEP;
    for sample in video.iter_mut() {
        if sample.pts <= last {
            sample.pts = last + MIN_STEP;
        }
        last = sample.pts;
        let dts = sample.dts.unwrap_or(sample.pts);
        sample.dts = Some(dts.max(last - MIN_STEP));
    }
}

fn normalize_audio_timestamps(audio: &mut [AudioSample]) {
    const MIN_STEP: f64 = 1.0 / 90_000.0;
    let mut last = -MIN_STEP;
    for sample in audio.iter_mut() {
        if sample.pts <= last {
            sample.pts = last + MIN_STEP;
        }
        last = sample.pts;
    }
}

fn demux_ts(ts_data: &[u8]) -> Result<(Vec<VideoSample>, Vec<AudioSample>), HlsError> {
    let mut ctx = TsDemuxContext::default();
    let mut demux = demultiplex::Demultiplex::new(&mut ctx);
    demux.push(&mut ctx, ts_data);
    // Flush trailing partial audio buffer only if it ends on a complete ADTS frame.
    ctx.output
        .borrow_mut()
        .audio
        .extend(ctx.audio_buf.borrow_mut().drain_complete_frames());
    let mut output = ctx.output.into_inner();

    normalize_video_timestamps(&mut output.video);
    normalize_audio_timestamps(&mut output.audio);

    if output.video.is_empty() {
        return Err(HlsError::Parse(
            "No H.264/H.265 video stream found in TS data".into(),
        ));
    }
    Ok((output.video, output.audio))
}

fn mux_to_mp4(video: &[VideoSample], audio: &[AudioSample]) -> Result<Vec<u8>, HlsError> {
    let keyframe = video
        .iter()
        .find(|s| s.is_keyframe)
        .or_else(|| video.first())
        .ok_or_else(|| HlsError::Parse("No video samples to mux".into()))?;

    let (width, height) = parse_sps_dimensions(&keyframe.data).unwrap_or((1280, 720));
    let fps = 30.0;

    let mut audio_rate = 48_000u32;
    let mut audio_channels = 2u16;
    if let Some(first_audio) = audio.first() {
        if let Some((rate, channels)) = parse_adts_config(&first_audio.data) {
            audio_rate = rate;
            audio_channels = channels;
        }
    }

    let mut out = Vec::new();
    let mut builder = MuxerBuilder::new(&mut out)
        .video(VideoCodec::H264, width, height, fps)
        .with_fast_start(true);
    if !audio.is_empty() {
        builder = builder.audio(AudioCodec::Aac(AacProfile::Lc), audio_rate, audio_channels);
    }
    let mut muxer = builder
        .build()
        .map_err(|e| HlsError::Parse(format!("Muxide init failed: {e}")))?;

    let mut video_sorted: Vec<&VideoSample> = video.iter().collect();
    video_sorted.sort_by(|a, b| {
        let da = a.dts.unwrap_or(a.pts);
        let db = b.dts.unwrap_or(b.pts);
        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut audio_sorted: Vec<&AudioSample> = audio.iter().collect();
    audio_sorted.sort_by(|a, b| a.pts.partial_cmp(&b.pts).unwrap_or(std::cmp::Ordering::Equal));

    let mut vi = 0usize;
    let mut ai = 0usize;

    // muxide requires at least one video frame before any audio sample.
    if let Some(first_video) = video_sorted.first() {
        write_video_sample(&mut muxer, first_video)?;
        vi = 1;
    }

    while vi < video_sorted.len() || ai < audio_sorted.len() {
        let write_audio = match (video_sorted.get(vi), audio_sorted.get(ai)) {
            (Some(v), Some(a)) => a.pts <= v.pts,
            (None, Some(_)) => true,
            _ => false,
        };

        if write_audio {
            let sample = audio_sorted[ai];
            muxer
                .write_audio(sample.pts, &sample.data)
                .map_err(|e| HlsError::Parse(format!("Audio mux failed: {e}")))?;
            ai += 1;
        } else {
            write_video_sample(&mut muxer, video_sorted[vi])?;
            vi += 1;
        }
    }

    muxer
        .finish()
        .map_err(|e| HlsError::Parse(format!("Muxide finish failed: {e}")))?;
    Ok(out)
}

fn write_video_sample<W: std::io::Write>(
    muxer: &mut muxide::api::Muxer<W>,
    sample: &VideoSample,
) -> Result<(), HlsError> {
    if let (Some(dts), pts) = (sample.dts, sample.pts) {
        if (dts - pts).abs() > f64::EPSILON {
            muxer
                .write_video_with_dts(pts, dts, &sample.data, sample.is_keyframe)
                .map_err(|e| HlsError::Parse(format!("Video mux failed: {e}")))?;
        } else {
            muxer
                .write_video(pts, &sample.data, sample.is_keyframe)
                .map_err(|e| HlsError::Parse(format!("Video mux failed: {e}")))?;
        }
    } else {
        muxer
            .write_video(sample.pts, &sample.data, sample.is_keyframe)
            .map_err(|e| HlsError::Parse(format!("Video mux failed: {e}")))?;
    }
    Ok(())
}

fn read_concat_ts(segment_paths: &[std::path::PathBuf]) -> Result<Vec<u8>, HlsError> {
    let mut data = Vec::new();
    for path in segment_paths {
        data.extend_from_slice(&std::fs::read(path)?);
    }
    Ok(data)
}

pub fn transmux_ts_to_mp4(ts_data: &[u8]) -> Result<Vec<u8>, HlsError> {
    let (video, audio) = demux_ts(ts_data)?;
    mux_to_mp4(&video, &audio)
}

/// Download HLS segments and transmux to MP4 (mpeg2ts-reader + muxide, no FFmpeg).
pub async fn transmux_segments_to_mp4_buffer(
    segments: &[Segment],
    headers: Option<&HashMap<String, String>>,
    concurrency: usize,
    max_retry: usize,
    on_progress: Option<ProgressCallback>,
) -> Result<Vec<u8>, HlsError> {
    if segments.is_empty() {
        return Err(HlsError::Parse("No segments to transmux".into()));
    }

    let work_dir = tempfile::tempdir()?;
    let work_path = work_dir.path();

    let segment_paths = download_segments_to_dir(
        work_path,
        segments,
        headers,
        concurrency,
        max_retry,
        false,
        None,
        Default::default(),
        on_progress.clone(),
    )
    .await?;

    let paths = segment_paths.clone();
    let merge_progress = on_progress.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let ts = read_concat_ts(&paths)?;
        let mp4 = transmux_ts_to_mp4(&ts)?;
        if let Some(cb) = merge_progress.as_ref() {
            cb(DownloadProgress::Merging {
                completed: paths.len(),
                total: paths.len(),
            });
        }
        Ok::<_, HlsError>(mp4)
    })
    .await
    .map_err(|e| HlsError::Parse(format!("Join error: {e}")))??;

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_adts_header_smoke() {
        let frame = [0xFF, 0xF1, 0x4C, 0x80, 0x00, 0x1F, 0xFC];
        let (rate, ch) = parse_adts_config(&frame).unwrap();
        assert_eq!(rate, 48_000);
        assert!(ch >= 1);
    }

    #[test]
    fn split_concatenated_adts_frames() {
        // Two 8-byte ADTS frames (frame_length=8 encoded in header bytes 3-5)
        let a = [0xFF, 0xF1, 0x4C, 0x00, 0x01, 0x00, 0xFC, 0xAA];
        let b = [0xFF, 0xF1, 0x4C, 0x00, 0x01, 0x00, 0xFC, 0xBB];
        let mut payload = Vec::new();
        payload.extend_from_slice(&a);
        payload.extend_from_slice(&b);
        let frames = split_adts_frames(&payload);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].len(), 8);
        assert_eq!(frames[1].len(), 8);
    }
}
