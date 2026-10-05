# Generated media fixtures

These tiny H.264/AAC fixtures are generated from FFmpeg's `testsrc2` and `sine`
lavfi sources and are licensed under this repository's MIT license. They contain
no third-party audiovisual content.

Generation baseline: FFmpeg 9.0.1, 160x90 at 10 fps, 48 kHz mono AAC, two
seconds. The three directories use MPEG-TS segments, fragmented MP4 segments
with `EXT-X-MAP`, and a single-file `EXT-X-BYTERANGE` playlist respectively.

The common encoder arguments are:

```sh
-f lavfi -i testsrc2=size=160x90:rate=10
-f lavfi -i sine=frequency=440:sample_rate=48000 -t 2
-c:v libx264 -preset ultrafast -g 10 -sc_threshold 0 -pix_fmt yuv420p
-c:a aac -b:a 64k -f hls -hls_time 1 -hls_list_size 0
```

The `audio-ts` and `audio-fmp4` fixtures use an independent 880 Hz sine
wave (48 kHz AAC, 64 kbit/s, two seconds, HLS segment target 0.6 seconds).
They are generated with FFmpeg lavfi and covered by the same MIT license.
Their four segments deliberately differ from the two primary video segments.
Rendition tests decode the selected audio to distinguish it from embedded 440 Hz audio.

The `hevc-ts` and `hevc-fmp4` variants use the same sources and durations, with
`-c:v libx265 -preset ultrafast -x265-params log-level=error:keyint=10:min-keyint=10:scenecut=0:pools=1:frame-threads=1 -tag:v hvc1`.
`encrypted.ts` encrypts these clear fixtures independently with Node/OpenSSL
AES-128-CBC and PKCS#7 padding. Mixed-container external-audio tests shift TS
PES clocks by -1.4 seconds to place both independently generated inputs on the
same timeline; the SDK receives the resulting timestamps unchanged.

The offset regression passes `alignClocks: false` (the fourth positional argument
to `encryptedRoutes`) to preserve the original TS/fMP4 clock difference. It
requires container duration to match the final packet presentation end without
removing that difference. See hls-transmux issue #2 for the regression fixed in 0.6.2.
