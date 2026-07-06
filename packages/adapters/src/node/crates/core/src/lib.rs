pub mod cancel;
pub mod download;
pub mod hls;
pub mod poster;
pub mod transmux;

pub use cancel::JobCancelToken;
pub use download::{
    download_and_merge, download_segments_to_dir, Aria2Options, DownloadProgress, MergeProgress,
    TranscodeOptions,
};
pub use transmux::{transmux_hls_to_stream, transmux_segments_to_mp4_file};
pub use hls::{parse_hls, ParseHlsResult, Playlist, Segment};
pub use poster::extract_poster;

use std::sync::Once;

static FFMPEG_INIT: Once = Once::new();

#[derive(Debug, thiserror::Error)]
pub enum HlsError {
    #[error("FFmpeg error: {0}")]
    Ffmpeg(#[from] ffmpeg_next::Error),
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("URL error: {0}")]
    Url(#[from] url::ParseError),
    #[error("Aria2: {0}")]
    Aria2(String),
}

pub fn init() -> Result<(), HlsError> {
    let mut result = Ok(());
    FFMPEG_INIT.call_once(|| {
        if let Err(e) = ffmpeg_next::init() {
            result = Err(HlsError::Ffmpeg(e));
        }
    });
    result
}
