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
