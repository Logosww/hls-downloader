use std::collections::HashMap;

use url::Url;

use crate::HlsError;

#[derive(Debug, Clone)]
pub struct Playlist {
    pub name: String,
    pub bandwidth: u64,
    pub uri: String,
    pub resolution: Option<(u32, u32)>,
    pub codecs: Option<String>,
    pub frame_rate: Option<f64>,
    pub is_audio_only: bool,
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub uri: String,
    pub duration: f64,
}

#[derive(Debug, Clone)]
pub enum ParseHlsResult {
    Playlist(Vec<Playlist>),
    Segments(Vec<Segment>),
}

fn resolve_uri(uri: &str, base: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return uri.to_string();
    }
    base.replace("{{URL}}", uri)
}

fn build_base_url(url: &Url) -> String {
    let mut path_segments: Vec<&str> = url.path().split('/').collect();
    path_segments.pop();
    path_segments.push("{{URL}}");
    let path = path_segments.join("/");
    format!("{}{}", url.origin().ascii_serialization(), path)
}

/// 判断 codecs 列表是否仅含音频（无视频 codec）。无 codecs 信息时返回 false。
fn is_audio_only_codecs(codecs: &Option<String>) -> bool {
    match codecs {
        Some(c) => {
            let parts: Vec<&str> = c.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            if parts.is_empty() {
                return false;
            }
            parts.iter().all(|p| {
                let p = p.to_lowercase();
                p.starts_with("mp4a")
                    || p.starts_with("ac-3")
                    || p.starts_with("ec-3")
                    || p.starts_with("opus")
                    || p.starts_with("flac")
                    || p.starts_with("alac")
                    || p.starts_with("dts")
            })
        }
        None => false,
    }
}

pub async fn parse_hls(
    hls_url: &str,
    headers: Option<&HashMap<String, String>>,
) -> Result<ParseHlsResult, HlsError> {
    let url = Url::parse(hls_url)?;

    let client = reqwest::Client::new();
    let mut req = client.get(url.as_str());
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let response = req.send().await?;
    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(HlsError::Parse(text));
    }
    let manifest_text = response.text().await?;

    let parsed = m3u8_rs::parse_playlist_res(manifest_text.as_bytes())
        .map_err(|e| HlsError::Parse(format!("{e:?}")))?;

    let base = build_base_url(&url);

    match parsed {
        m3u8_rs::Playlist::MasterPlaylist(master) => {
            if master.variants.is_empty() {
                return Err(HlsError::Parse(
                    "No playlists or segments found".to_string(),
                ));
            }

            let playlists: Vec<Playlist> = master
                .variants
                .iter()
                .map(|v| {
                    let name = if let Some(ref res) = v.resolution {
                        format!("{}x{}", res.width, res.height)
                    } else {
                        format!("MAYBE_AUDIO:{}", v.bandwidth)
                    };
                    let resolution = v
                        .resolution
                        .as_ref()
                        .map(|r| (r.width as u32, r.height as u32));
                    let frame_rate = v.frame_rate;
                    let is_audio_only =
                        v.resolution.is_none() && is_audio_only_codecs(&v.codecs);
                    Playlist {
                        name,
                        bandwidth: v.bandwidth,
                        uri: resolve_uri(&v.uri, &base),
                        resolution,
                        codecs: v.codecs.clone(),
                        frame_rate,
                        is_audio_only,
                    }
                })
                .collect();

            Ok(ParseHlsResult::Playlist(playlists))
        }
        m3u8_rs::Playlist::MediaPlaylist(media) => {
            if media.segments.is_empty() {
                return Err(HlsError::Parse(
                    "No playlists or segments found".to_string(),
                ));
            }

            let segments: Vec<Segment> = media
                .segments
                .iter()
                .map(|s| Segment {
                    uri: resolve_uri(&s.uri, &base),
                    duration: s.duration as f64,
                })
                .collect();

            Ok(ParseHlsResult::Segments(segments))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_uri_absolute() {
        let uri = "https://cdn.example.com/seg0.ts";
        let base = "https://example.com/path/{{URL}}";
        assert_eq!(resolve_uri(uri, base), uri);
    }

    #[test]
    fn test_resolve_uri_relative() {
        let uri = "seg0.ts";
        let base = "https://example.com/path/{{URL}}";
        assert_eq!(resolve_uri(uri, base), "https://example.com/path/seg0.ts");
    }

    #[test]
    fn test_build_base_url() {
        let url = Url::parse("https://example.com/live/stream/manifest.m3u8").unwrap();
        let base = build_base_url(&url);
        assert_eq!(base, "https://example.com/live/stream/{{URL}}");
    }
}
