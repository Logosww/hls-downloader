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

/// 把 `m3u8_rs::parse_playlist_res` 的结果映射为 `ParseHlsResult`（纯函数，无网络/IO）。
/// - master：映射 variants 为 `Playlist`（含相对 URI 解析、`is_audio_only` 判定、`name` 推导）。
/// - media：映射 segments 为 `Segment{uri, duration}`（不提取 key/map/byterange，现状限制）。
/// - 空 variants / 空 segments 返回 `HlsError::Parse`。
///
/// 从 `parse_hls` 中抽出，使其可被 `#[cfg(test)]` 用 fixture 文本直接驱动。
fn map_parsed_playlist(parsed: m3u8_rs::Playlist, base: &str) -> Result<ParseHlsResult, HlsError> {
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
                        uri: resolve_uri(&v.uri, base),
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
                    uri: resolve_uri(&s.uri, base),
                    duration: s.duration as f64,
                })
                .collect();

            Ok(ParseHlsResult::Segments(segments))
        }
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

    map_parsed_playlist(parsed, &base)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://example.com/path/{{URL}}";

    /// 从仓库根目录的 test/fixtures/m3u8/ 加载 fixture 文本（编译期嵌入）。
    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../../../../test/fixtures/m3u8/",
                $name
            ))
        };
    }

    fn parse_and_map(content: &str, base: &str) -> Result<ParseHlsResult, HlsError> {
        let parsed = m3u8_rs::parse_playlist_res(content.as_bytes())
            .map_err(|e| HlsError::Parse(format!("{e:?}")))?;
        map_parsed_playlist(parsed, base)
    }

    // ── 单元工具函数 ──

    #[test]
    fn test_resolve_uri_absolute() {
        let uri = "https://cdn.example.com/seg0.ts";
        assert_eq!(resolve_uri(uri, BASE), uri);
    }

    #[test]
    fn test_resolve_uri_relative() {
        assert_eq!(resolve_uri("seg0.ts", BASE), "https://example.com/path/seg0.ts");
    }

    #[test]
    fn test_build_base_url() {
        let url = Url::parse("https://example.com/live/stream/manifest.m3u8").unwrap();
        assert_eq!(build_base_url(&url), "https://example.com/live/stream/{{URL}}");
    }

    // ── master playlist fixture 数据驱动 ──

    #[test]
    fn master_no_resolution_no_codecs() {
        let result = parse_and_map(fixture!("master.m3u8"), BASE).unwrap();
        let playlists = match result {
            ParseHlsResult::Playlist(p) => p,
            _ => panic!("expected Playlist"),
        };
        assert_eq!(playlists.len(), 5);
        let first = &playlists[0];
        assert_eq!(first.bandwidth, 300000);
        assert_eq!(first.name, "MAYBE_AUDIO:300000");
        assert!(first.resolution.is_none());
        assert!(first.codecs.is_none());
        assert!(!first.is_audio_only);
        assert_eq!(first.uri, "https://example.com/path/chunklist-b300000.m3u8");
    }

    #[test]
    fn master_with_multiple_codecs() {
        let result = parse_and_map(fixture!("master-with-multiple-codecs.m3u8"), BASE).unwrap();
        let playlists = match result {
            ParseHlsResult::Playlist(p) => p,
            _ => panic!("expected Playlist"),
        };
        assert_eq!(playlists.len(), 5);
        for p in &playlists {
            assert_eq!(p.codecs.as_deref(), Some("avc1.42c015,mp4a.40.2"));
            assert!(!p.is_audio_only);
        }
    }

    #[test]
    fn master_with_alternatives_audio_only() {
        let result = parse_and_map(fixture!("master-with-alternatives.m3u8"), BASE).unwrap();
        let playlists = match result {
            ParseHlsResult::Playlist(p) => p,
            _ => panic!("expected Playlist"),
        };
        assert_eq!(playlists.len(), 4);
        let audio = playlists.iter().find(|p| p.is_audio_only).unwrap();
        assert_eq!(audio.bandwidth, 65000);
        assert_eq!(audio.codecs.as_deref(), Some("mp4a.40.5"));
        assert_eq!(audio.name, "MAYBE_AUDIO:65000");
    }

    #[test]
    fn master_subtitles_resolution_name() {
        let result = parse_and_map(fixture!("master-subtitles.m3u8"), BASE).unwrap();
        let playlists = match result {
            ParseHlsResult::Playlist(p) => p,
            _ => panic!("expected Playlist"),
        };
        assert_eq!(playlists.len(), 2);
        let names: Vec<&str> = playlists.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"640x360"));
        assert!(names.contains(&"1280x720"));
    }

    #[test]
    fn master_with_stream_inf_name() {
        let result = parse_and_map(fixture!("master-with-stream-inf-name.m3u8"), BASE).unwrap();
        let playlists = match result {
            ParseHlsResult::Playlist(p) => p,
            _ => panic!("expected Playlist"),
        };
        assert_eq!(playlists.len(), 4);
        // Rust 端当前未使用 NAME 属性，name 由 RESOLUTION 推导
        assert_eq!(playlists[0].name, "896x504");
        assert_eq!(playlists[1].name, "512x288");
        // 最后一个无 RESOLUTION 且无 CODECS → MAYBE_AUDIO 名，非 audio-only
        assert_eq!(playlists[3].name, "MAYBE_AUDIO:128000");
        assert!(!playlists[3].is_audio_only);
    }

    #[test]
    fn master_with_offset_absolute_uri() {
        let result = parse_and_map(fixture!("master-with-offset.m3u8"), BASE).unwrap();
        let playlists = match result {
            ParseHlsResult::Playlist(p) => p,
            _ => panic!("expected Playlist"),
        };
        assert_eq!(playlists.len(), 7);
        // 绝对 URI 保持不变
        assert!(playlists[0].uri.starts_with("http://hls.tagesschau.de/"));
        // 最后一个是 audio-only（mp4a.40.2，无 RESOLUTION）
        let audio = playlists.last().unwrap();
        assert!(audio.is_audio_only);
        assert_eq!(audio.codecs.as_deref(), Some("mp4a.40.2"));
    }

    // ── media playlist fixture 数据驱动 ──

    #[test]
    fn media_playlist_segments() {
        let result = parse_and_map(fixture!("mediaplaylist.m3u8"), BASE).unwrap();
        let segments = match result {
            ParseHlsResult::Segments(s) => s,
            _ => panic!("expected Segments"),
        };
        assert_eq!(segments.len(), 15);
        let first = &segments[0];
        assert_eq!(first.uri, "https://example.com/path/20140311T113819-01-338559live.ts");
        assert!((first.duration - 2.002).abs() < 1e-6);
    }

    #[test]
    fn media_playlist_byterange() {
        let result = parse_and_map(fixture!("media-playlist-with-byterange.m3u8"), BASE).unwrap();
        let segments = match result {
            ParseHlsResult::Segments(s) => s,
            _ => panic!("expected Segments"),
        };
        assert_eq!(segments.len(), 3);
        // 3 个 segment 共用同一 URI
        for s in &segments {
            assert_eq!(s.uri, "https://example.com/path/video.ts");
        }
    }

    #[test]
    fn media_playlist_without_segments_errors() {
        let result = parse_and_map(fixture!("media-playlist-without-segments.m3u8"), BASE);
        assert!(matches!(result, Err(HlsError::Parse(ref msg)) if msg.contains("No playlists or segments")));
    }

    #[test]
    fn empty_master_errors() {
        // 构造一个空 master playlist
        let content = "#EXTM3U\n#EXT-X-VERSION:3\n";
        let result = parse_and_map(content, BASE);
        assert!(matches!(result, Err(HlsError::Parse(ref msg)) if msg.contains("No playlists or segments")));
    }
}
