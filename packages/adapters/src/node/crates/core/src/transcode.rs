//! Local-file transcoding through the linked FFmpeg libraries.
use crate::{HlsError, JobCancelToken};
use ff::{Dictionary, Packet, Rational, Rescale, codec, encoder, filter, format, media};
use ffmpeg_next as ff;
use hls_engine::CancelToken;
use std::path::Path;

fn check_drain_end(error: ff::Error) -> Result<(), HlsError> {
    match error {
        ff::Error::Eof
        | ff::Error::Other {
            errno: ff::error::EAGAIN,
        } => Ok(()),
        error => Err(error.into()),
    }
}
fn check_cancel(cancel: &JobCancelToken) -> Result<(), HlsError> {
    if cancel.is_cancelled() {
        return Err(HlsError::Parse("ABORTED: transcoding cancelled".into()));
    }
    Ok(())
}
fn option<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.as_chunks::<2>()
        .0
        .iter()
        .find(|pair| pair[0] == key)
        .map(|pair| pair[1].as_str())
}
fn bitrate(value: &str) -> Result<usize, HlsError> {
    let (number, factor) = match value.as_bytes().last() {
        Some(b'k' | b'K') => (&value[..value.len() - 1], 1000.0),
        Some(b'm' | b'M') => (&value[..value.len() - 1], 1_000_000.0),
        _ => (value, 1.0),
    };
    let rate = number
        .parse::<f64>()
        .map_err(|_| HlsError::Parse("Invalid bitrate".into()))?
        * factor;
    if !rate.is_finite() || rate <= 0.0 || rate > usize::MAX as f64 {
        return Err(HlsError::Parse("Invalid bitrate".into()));
    }
    Ok(rate as usize)
}
struct Transcoder {
    decoder: codec::decoder::Opened,
    encoder: codec::encoder::Encoder,
    filter: filter::Graph,
    output: usize,
    time_base: Rational,
    packet_durations: std::collections::HashMap<i64, i64>,
}
impl Transcoder {
    fn packets(
        &mut self,
        output: &mut format::context::Output,
        cancel: &JobCancelToken,
    ) -> Result<(), HlsError> {
        let mut packet = Packet::empty();
        loop {
            check_cancel(cancel)?;
            if let Err(error) = self.encoder.receive_packet(&mut packet) {
                check_drain_end(error)?;
                break;
            }
            // Encoders can reorder frames and omit packet durations. Preserve each
            // input frame's duration by presentation timestamp, including VFR input.
            if let Some(duration) = packet
                .pts()
                .and_then(|pts| self.packet_durations.remove(&pts))
                && packet.duration() == 0
            {
                packet.set_duration(duration);
            }
            packet.set_stream(self.output);
            packet.rescale_ts(
                self.time_base,
                output.stream(self.output).unwrap().time_base(),
            );
            packet.write_interleaved(output)?;
        }
        Ok(())
    }
    fn filtered(
        &mut self,
        output: &mut format::context::Output,
        cancel: &JobCancelToken,
    ) -> Result<(), HlsError> {
        let mut frame = unsafe { ff::Frame::empty() };
        loop {
            check_cancel(cancel)?;
            if let Err(error) = self.filter.get("out").unwrap().sink().frame(&mut frame) {
                check_drain_end(error)?;
                break;
            }
            self.encoder.send_frame(&frame)?;
            self.packets(output, cancel)?;
        }
        Ok(())
    }
    fn frames(
        &mut self,
        output: &mut format::context::Output,
        cancel: &JobCancelToken,
    ) -> Result<(), HlsError> {
        let mut frame = unsafe { ff::Frame::empty() };
        loop {
            check_cancel(cancel)?;
            if let Err(error) = self.decoder.receive_frame(&mut frame) {
                check_drain_end(error)?;
                break;
            }
            frame.set_pts(frame.timestamp());
            unsafe {
                (*frame.as_mut_ptr()).pict_type = ff::ffi::AVPictureType::AV_PICTURE_TYPE_NONE;
            }
            self.filter.get("in").unwrap().source().add(&frame)?;
            self.filtered(output, cancel)?;
        }
        Ok(())
    }
}
fn create_transcoder(
    stream: &format::stream::Stream,
    output: &mut format::context::Output,
    name: &str,
    args: &[String],
) -> Result<Transcoder, HlsError> {
    let codec = encoder::find_by_name(name)
        .ok_or_else(|| HlsError::Parse(format!("Encoder unavailable: {name}")))?;
    let context = codec::Context::from_parameters(stream.parameters())?;
    let global = output
        .format()
        .flags()
        .contains(format::Flags::GLOBAL_HEADER);
    let mut graph = filter::Graph::new();
    let (decoder, encoder, time_base) = if stream.parameters().medium() == media::Type::Video {
        let decoder = context.decoder().video()?;
        let mut enc = codec::Context::new_with_codec(codec).encoder().video()?;
        let pixel = codec
            .video()?
            .formats()
            .and_then(|mut formats| formats.next())
            .unwrap_or(decoder.format());
        enc.set_width(decoder.width());
        enc.set_height(decoder.height());
        enc.set_format(pixel);
        enc.set_aspect_ratio(decoder.aspect_ratio());
        enc.set_time_base(stream.time_base());
        enc.set_frame_rate(decoder.frame_rate());
        if global {
            enc.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        if let Some(rate) = option(args, "-b:v") {
            enc.set_bit_rate(bitrate(rate)?);
        }
        let mut options = Dictionary::new();
        if let Some(crf) = option(args, "-crf") {
            options.set("crf", crf);
        }
        if let Some(speed) = option(args, "-preset") {
            options.set("preset", speed);
        }
        let enc = enc.open_with(options)?;
        let aspect = decoder.aspect_ratio();
        let spec = format!(
            "video_size={}x{}:pix_fmt={}:time_base={}:pixel_aspect={}/{}",
            decoder.width(),
            decoder.height(),
            ff::ffi::AVPixelFormat::from(decoder.format()) as i32,
            stream.time_base(),
            aspect.numerator().max(1),
            aspect.denominator().max(1)
        );
        graph.add(
            &filter::find("buffer").ok_or(ff::Error::FilterNotFound)?,
            "in",
            &spec,
        )?;
        graph.add(
            &filter::find("buffersink").ok_or(ff::Error::FilterNotFound)?,
            "out",
            "",
        )?;
        graph.output("in", 0)?.input("out", 0)?.parse(&format!(
            "format=pix_fmts={}",
            pixel.descriptor().ok_or(ff::Error::InvalidData)?.name()
        ))?;
        (decoder.0, enc.0.0, stream.time_base())
    } else {
        let decoder = context.decoder().audio()?;
        let audio_codec = codec.audio()?;
        let rate = audio_codec
            .rates()
            .map(|rates| {
                rates
                    .min_by_key(|rate| (*rate - decoder.rate() as i32).abs())
                    .unwrap_or(decoder.rate() as i32)
            })
            .unwrap_or(decoder.rate() as i32);
        let mut layout = decoder.channel_layout();
        if layout.is_empty() {
            layout = ff::ChannelLayout::default(decoder.channels() as i32);
        }
        let mut enc = codec::Context::new_with_codec(codec).encoder().audio()?;
        enc.set_rate(rate);
        enc.set_channel_layout(layout);
        enc.set_format(
            audio_codec
                .formats()
                .and_then(|mut formats| formats.next())
                .unwrap_or(decoder.format()),
        );
        enc.set_time_base((1, rate));
        enc.set_bit_rate(
            option(args, "-b:a")
                .map(bitrate)
                .transpose()?
                .unwrap_or(128_000),
        );
        if global {
            enc.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        let enc = enc.open_as(codec)?;
        let spec = format!(
            "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
            stream.time_base(),
            decoder.rate(),
            decoder.format().name(),
            layout.bits()
        );
        graph.add(
            &filter::find("abuffer").ok_or(ff::Error::FilterNotFound)?,
            "in",
            &spec,
        )?;
        graph.add(
            &filter::find("abuffersink").ok_or(ff::Error::FilterNotFound)?,
            "out",
            "",
        )?;
        graph.output("in", 0)?.input("out", 0)?.parse(&format!(
            "aformat=sample_fmts={}:sample_rates={}:channel_layouts=0x{:x}",
            enc.format().name(),
            rate,
            layout.bits()
        ))?;
        graph.validate()?;
        if enc.frame_size() > 0 {
            graph
                .get("out")
                .unwrap()
                .sink()
                .set_frame_size(enc.frame_size());
        }
        (decoder.0, enc.0.0, Rational(1, rate))
    };
    graph.validate()?;
    let mut out = output.add_stream(codec)?;
    out.set_time_base(time_base);
    out.set_parameters(&encoder);
    Ok(Transcoder {
        decoder,
        encoder,
        filter: graph,
        output: out.index(),
        time_base,
        packet_durations: std::collections::HashMap::new(),
    })
}

pub fn transcode_file(
    input: &Path,
    output: &Path,
    args: &[String],
    cancel: &JobCancelToken,
) -> Result<(), HlsError> {
    crate::init()?;
    check_cancel(cancel)?;
    let mut input = format::input(input)?;
    let mut output = match option(args, "-f") {
        Some(name) => format::output_as(output, name)?,
        None => format::output(output)?,
    };
    let mut mapping = vec![None; input.nb_streams() as usize];
    let mut transcoders = std::collections::HashMap::new();
    let mut selected_video = false;
    let mut selected_audio = false;
    for stream in input.streams() {
        let key = match stream.parameters().medium() {
            media::Type::Video if !selected_video => {
                selected_video = true;
                "-c:v"
            }
            media::Type::Audio if !selected_audio => {
                selected_audio = true;
                "-c:a"
            }
            _ => continue,
        };
        let name = option(args, key).unwrap_or("copy");
        if name == "copy" {
            let mut out = output.add_stream(encoder::find(codec::Id::None))?;
            out.set_parameters(stream.parameters());
            out.set_time_base(stream.time_base());
            unsafe {
                (*out.parameters().as_mut_ptr()).codec_tag = 0;
            }
            mapping[stream.index()] = Some(out.index());
        } else {
            let transcoder = create_transcoder(&stream, &mut output, name, args)?;
            mapping[stream.index()] = Some(transcoder.output);
            transcoders.insert(stream.index(), transcoder);
        }
    }
    let start = unsafe { (*input.as_ptr()).start_time };
    output.write_header()?;
    loop {
        check_cancel(cancel)?;
        let mut packet = Packet::empty();
        match packet.read(&mut input) {
            Ok(()) => {}
            Err(ff::Error::Eof) => break,
            Err(error) => return Err(error.into()),
        }
        let index = packet.stream();
        let Some(out_index) = mapping[index] else {
            continue;
        };
        let time_base = input.stream(index).unwrap().time_base();
        if start != ff::ffi::AV_NOPTS_VALUE {
            let offset = start.rescale(ff::rescale::TIME_BASE, time_base);
            packet.set_pts(packet.pts().map(|value| value - offset));
            packet.set_dts(packet.dts().map(|value| value - offset));
        }
        if let Some(transcoder) = transcoders.get_mut(&index) {
            if input.stream(index).unwrap().parameters().medium() == media::Type::Video
                && packet.duration() > 0
                && let Some(pts) = packet.pts()
            {
                transcoder.packet_durations.insert(pts, packet.duration());
            }
            transcoder.decoder.send_packet(&packet)?;
            transcoder.frames(&mut output, cancel)?;
        } else {
            packet.rescale_ts(time_base, output.stream(out_index).unwrap().time_base());
            packet.set_stream(out_index);
            packet.set_position(-1);
            packet.write_interleaved(&mut output)?;
        }
    }
    for transcoder in transcoders.values_mut() {
        transcoder.decoder.send_eof()?;
        transcoder.frames(&mut output, cancel)?;
        transcoder.filter.get("in").unwrap().source().flush()?;
        transcoder.filtered(&mut output, cancel)?;
        transcoder.encoder.send_eof()?;
        transcoder.packets(&mut output, cancel)?;
    }
    check_cancel(cancel)?;
    output.write_trailer()?;
    Ok(())
}
