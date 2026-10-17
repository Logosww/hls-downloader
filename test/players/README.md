# M4 target-player acceptance — 2026-10-10

Measured on macOS 27.0.1 (26A434), arm64, using library output built against registry
`hls-engine = "=1.0.2"`. This record closes the local target-player sample matrix.
Subsequent [subtitle bridge acceptance](../subtitle-sidecar-validation.md) covers
AES-128 WebVTT, continuous Writable sidecars and Node joint recovery. The player
results below remain measurements of these specific samples; the subtitle bridge
does not broaden embedded playback capability. M5 has not started.

## Measured results

The ten files are classic MP4 and fMP4 variants of AVC + two AAC tracks, plain
wvtt, wvtt with positioning/vertical cues, the historical negative-CTS/AAC-gap
regression, and decrypted HEVC cbcs. They are produced by the actual Node library,
not by remuxing the final files with FFmpeg. FFmpeg independently decodes all A/V
streams. The six dual-audio files have separately verified 880 Hz English and
1760 Hz Japanese PCM, so selecting distinct labels cannot conceal duplicate audio.

| Target/version | Positive evidence | Measured limitation |
| --- | --- | --- |
| Chrome 155.0.8059.40, installed binary, headless | All 10 files ended with video frames: AVC 20, negative-CTS 60, HEVC 180 | No exposed file audio/text track selection; both multi-track MSE samples fail SourceBuffer append |
| Safari 27.0.1 (22625.1.29.11.28), actual desktop app | All 10 files ended; EN/JA audio selection states switch; both file wvtt tracks expose cues and settings | Both MSE samples end but expose zero subtitle tracks; background frame counts are not full-frame evidence |
| AVFoundation AVPlayer on macOS 27.0.1 | 14 plays ended; actual pixel buffers and selected EN/JA cue callbacks; positioning attributes retained | Sampled frame counts are polling observations, not exact decoder totals; screenshots contain video, not composited captions |
| IINA 1.4.4 (168), bundled mpv 0.38.0 | All 10 files reached EOF; audio selection/readback and rendered screenshots; an eleventh external-VTT case visibly shows “Hello sidecar” | Embedded wvtt tracks are absent in all four subtitle files |
| VLC 3.0.23 arm64, official app in temporary read-only DMG | All 10 files decoded/displayed frames and stopped after playback; both audio and wvtt track selections read back correctly | Simple captions appear, but settings samples do not establish faithful position/vertical layout; conservative subtitle gate remains |
| Shaka 5.2.13 in Chrome and Safari | External VTT track active, “Hello sidecar” cue active, playback ended; Chrome screenshot confirms rendering | `Mp4VttParser` on the mixed A/V/text mdat fails with error 3000 in both browsers |

Track selection, independently decoded content and actual audio-device output
are different evidence. These tests mute output/use VLC's dummy audio sink and
**do not claim speaker capture or seamless audible switching**. Safari's active
cue can transiently be empty during a rapid subtitle switch; loaded cue text and
settings are checked, with separate AVPlayer runs confirming each selected language.
This is a finite-output playback matrix, not live-player, arbitrary-CSS, all-codec,
all-platform or long-duration qualification. The library Live/EVENT/output/recovery
matrix remains documented in [Engine validation](../engine-1.0-validation.md).

## Retained evidence

- [Compact report](evidence/2026-10-10.json): fixture hashes, independent PCM results,
  per-file observations and SHA-256 hashes of full local reports.
- [VLC simple caption](evidence/vlc-plain.png), [VLC settings](evidence/vlc-settings.png),
  [IINA external VTT](evidence/iina-external.png),
  [Shaka external VTT in Chrome](evidence/shaka-external-chrome.png).
- Full reports, original library engine reports, ffprobe streams, generated media and
  all screenshots remain in ignored `test-results/players/`.

Expected negative observations are asserted separately. A SourceBuffer failure,
an absent IINA subtitle track or Shaka error 3000 is **not a playback pass** and
must not relax `queryCapability()` or `playbackTarget` restrictions.

## Reproduce

Run from the repository root with built Native/WASM bindings, FFmpeg/ffprobe,
Chrome, Safari and IINA available. All commands operate on dedicated test sessions;
do not connect these scripts to a user's existing VLC RC/mpv IPC session.

```sh
pnpm --filter @hls-downloader/test run test:players:fixtures
```

Use Shaka's npm distribution without adding a library runtime dependency:

```sh
mkdir -p /tmp/hls-player-tools/shaka
npm pack shaka-player@5.2.13 --pack-destination /tmp/hls-player-tools
tar -xzf /tmp/hls-player-tools/shaka-player-5.2.13.tgz -C /tmp/hls-player-tools/shaka --strip-components=1
HLS_PLAYER_SAFARI=1 pnpm --filter @hls-downloader/test run test:players:browser
```

`HLS_SHAKA_PATH` overrides the compiled Shaka path; `HLS_TEST_CHROMIUM_PATH`
overrides Chrome. `HLS_PLAYER_CHROME=0` runs Safari alone. Safari Remote Automation
was disabled on this machine: the runner opens a loopback page that posts its own
results, without changing that setting. Safari tabs can remain after the temporary
server closes; close only the “M4 player acceptance” test tabs.

```sh
swiftc -swift-version 5 test/players/avfoundation.swift -o /tmp/hls-player-tools/avfoundation
/tmp/hls-player-tools/avfoundation "$PWD/test-results/players"
```

The probe uses AVPlayer, video pixel-buffer output and legible-output delegates;
it is not just an AVAsset metadata inspection. Swift's existing synchronous asset
accessors produce deprecation warnings on current macOS.

Start a dedicated IINA window in one terminal, then run the driver in another:

```sh
/Applications/IINA.app/Contents/MacOS/iina-cli --no-stdin --separate-windows --mpv-volume=0 --mpv-resume-playback=no --mpv-input-ipc-server=/tmp/hls-player-iina.sock --mpv-log-file=/tmp/hls-iina-player.log "$PWD/test-results/players/avc-mp4.mp4"
python3 test/players/iina.py
```

For VLC, use an installed matching version or the official temporary app used here:

```sh
curl --fail --location https://download.videolan.org/pub/videolan/vlc/3.0.23/macosx/vlc-3.0.23-arm64.dmg --output /tmp/hls-player-tools/vlc.dmg
hdiutil attach /tmp/hls-player-tools/vlc.dmg -readonly -nobrowse -mountpoint /tmp/hls-player-tools/vlc-volume
```

Run the app in one terminal and the driver in another. The macOS interface is
required for actual video rendering; `-I dummy` does not provide valid evidence.
The driver waits for displayed frames before pausing, because an immediate pause
can occur before the first decoder/window is ready.

```sh
/tmp/hls-player-tools/vlc-volume/VLC.app/Contents/MacOS/VLC -I macosx --aout=dummy --extraintf=rc --rc-host=127.0.0.1:47282 --no-video-title-show --no-snapshot-preview --snapshot-path="$PWD/test-results/players/screenshots" --snapshot-prefix=vlc- "$PWD/test-results/players/avc-mp4.mp4"
python3 test/players/vlc.py
pnpm --filter @hls-downloader/test run test:players:verify
```

`verify.py` fails on missing reports, files, rendered frames, expected selections,
PCM mismatch or changed known limitations, then writes `test-results/players/acceptance.json`.
Review changed player behavior before updating the retained snapshot; never replace
an expected result with a capability response. Stop/close the dedicated player
sessions before detaching the VLC DMG. No app installation or default-player change
is needed.
