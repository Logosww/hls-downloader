# Browser-only vendored dependency

Source: crates.io hls-transmux 0.2.1 (MIT), preserved with its license metadata and tests.

Local change: do not accumulate or fix up per-fragment tfra entries when write_mfra is false.
The published 0.2.1 skips writing mfra but still accumulates its entries. This patch
bounds index memory on the new Browser writable path. Node continues to use the
registry release. Remove this copy when an upstream release includes the fix.
