use std::io::Write;

use crate::HlsError;

pub fn extract_poster(bytes: &[u8]) -> Result<Option<Vec<u8>>, HlsError> {
    let mut file = tempfile::Builder::new().suffix(".ts").tempfile()?;
    file.write_all(bytes)?;
    file.flush()?;
    match extract_first_frame(file.path()) {
        Ok(Some(jpeg)) if jpeg.is_empty() => Ok(None),
        Err(HlsError::Ffmpeg(
            ffmpeg_next::Error::InvalidData | ffmpeg_next::Error::DecoderNotFound,
        )) => Ok(None),
        result => result,
    }
}

fn extract_first_frame(input_path: &std::path::Path) -> Result<Option<Vec<u8>>, HlsError> {
    let mut options = ffmpeg_next::Dictionary::new();
    options.set("protocol_whitelist", "file");
    options.set("format_whitelist", "mpegts,mov,aac,mp3,matroska,webm");
    let mut ictx = ffmpeg_next::format::input_with_dictionary(input_path, options)?;

    let video_stream_index = ictx
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .map(|s| s.index());

    let Some(stream_idx) = video_stream_index else {
        return Ok(None);
    };

    let stream = ictx.stream(stream_idx).unwrap();
    let codec_params = stream.parameters();
    let decoder_ctx = ffmpeg_next::codec::context::Context::from_parameters(codec_params)?;
    let mut decoder = decoder_ctx.decoder().video()?;

    let mut scaler = ffmpeg_next::software::scaling::Context::get(
        decoder.format(),
        decoder.width(),
        decoder.height(),
        ffmpeg_next::format::Pixel::RGB24,
        decoder.width(),
        decoder.height(),
        ffmpeg_next::software::scaling::Flags::BILINEAR,
    )?;

    for (stream, packet) in ictx.packets() {
        if stream.index() != stream_idx {
            continue;
        }
        decoder.send_packet(&packet)?;

        let mut frame = ffmpeg_next::frame::Video::empty();
        if decoder.receive_frame(&mut frame).is_ok() {
            let mut rgb_frame = ffmpeg_next::frame::Video::empty();
            scaler.run(&frame, &mut rgb_frame)?;
            return Ok(Some(encode_rgb_to_jpeg(
                rgb_frame.data(0),
                rgb_frame.width(),
                rgb_frame.height(),
            )));
        }
    }

    Ok(None)
}

/// Encode raw RGB24 pixel data into a minimal JPEG using FFmpeg's MJPEG encoder.
fn encode_rgb_to_jpeg(rgb_data: &[u8], width: u32, height: u32) -> Vec<u8> {
    let encoder = ffmpeg_next::encoder::find(ffmpeg_next::codec::Id::MJPEG);
    let Some(encoder) = encoder else {
        return Vec::new();
    };

    let mut ctx = ffmpeg_next::codec::context::Context::new_with_codec(encoder)
        .encoder()
        .video()
        .unwrap_or_else(|_| panic!("Failed to open MJPEG encoder"));

    // MJPEG expects YUVJ420P, so we need to convert from RGB24
    ctx.set_width(width);
    ctx.set_height(height);
    ctx.set_format(ffmpeg_next::format::Pixel::YUVJ420P);
    ctx.set_time_base(ffmpeg_next::Rational::new(1, 25));

    let Ok(mut encoder_ctx) = ctx.open() else {
        return Vec::new();
    };

    // Convert RGB24 -> YUVJ420P
    let Ok(mut scaler) = ffmpeg_next::software::scaling::Context::get(
        ffmpeg_next::format::Pixel::RGB24,
        width,
        height,
        ffmpeg_next::format::Pixel::YUVJ420P,
        width,
        height,
        ffmpeg_next::software::scaling::Flags::BILINEAR,
    ) else {
        return Vec::new();
    };

    let mut src_frame =
        ffmpeg_next::frame::Video::new(ffmpeg_next::format::Pixel::RGB24, width, height);
    src_frame.data_mut(0)[..rgb_data.len()].copy_from_slice(rgb_data);

    let mut yuv_frame = ffmpeg_next::frame::Video::empty();
    if scaler.run(&src_frame, &mut yuv_frame).is_err() {
        return Vec::new();
    }
    yuv_frame.set_pts(Some(0));

    if encoder_ctx.send_frame(&yuv_frame).is_err() {
        return Vec::new();
    }

    let mut pkt = ffmpeg_next::Packet::empty();
    if encoder_ctx.receive_packet(&mut pkt).is_ok() {
        return pkt.data().unwrap_or_default().to_vec();
    }

    Vec::new()
}
