Synthetic media imported from hls-transmux 0.8.0 (MIT), commit 8d6c54f.

The cases are the upstream SDK timeline/sample compatibility corpus. File hashes and original paths are in manifest.json. Sample ciphertext was independently generated with Shaka Packager/OpenSSL; see the upstream sample-encryption fixture manifest for generator commands. No user media or production keys are included.

`supplemental.json` adds the remaining fMP4 codec/scheme combinations, negative CTS, and a real 4-second GOP split across 1-second TS resources. `sample-generator.json` preserves the independent sample fixture generation commands. Supplemental sample outputs are checked against clear decoded frame hashes; all supplemental outputs are decoded by FFmpeg and compared across native/WASM/Chrome.

The SDK long-GOP fixture was generated with FFmpeg/libx264:

```
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=30 -t 8 -an -c:v libx264 -pix_fmt yuv420p -g 120 -keyint_min 120 -sc_threshold 0 -bf 3 -f hls -hls_time 1 -hls_flags split_by_time -hls_list_size 0 -hls_segment_filename seg%d.ts input.m3u8
```
