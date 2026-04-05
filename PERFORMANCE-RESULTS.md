# Performance Results

## 2026-04-05

### Setup

- Iterations per scenario: 3
- App mode: dev desktop with CDP on port `9222`
- Backend: local SyncPlay server on `127.0.0.1:8787`
- Torrent proxy: local on `127.0.0.1:8788`

### Inputs Used

#### Local File

- Small file: `/Users/yerovy/Downloads/ Ye - BIANCA [가사해석].mp4`
- Size: `11,219,373` bytes (`10.70 MiB`)
- Report JSON: `reports/perf-local-bianca.json`

- Large file: `/Users/yerovy/Downloads/The.Net.1995.1080p.BluRay.x264.YIFY.mp4`
- Size: `1,975,810,913` bytes (`1884.28 MiB`)
- Report JSON: `reports/perf-local-thenet.json`

#### Magnet Link

- Magnet: `magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=BigBuckBunny&tr=udp://tracker.openbittorrent.com:80`
- Selected file: `Big Buck Bunny.mp4`
- Size: `276,134,947` bytes (`263.34 MiB`)
- Report JSON: `reports/perf-magnet-bbb.json`

### Summary

| Scenario | Guest join -> ready avg | Guest join -> first playback avg | Extra source cost | Approx end-to-end throughput |
| --- | ---: | ---: | ---: | ---: |
| Local file, small (`Ye - BIANCA`) | `1,786.67 ms` | `3,302.67 ms` | n/a | `5.99 MiB/s` |
| Local file, large (`The Net`) | `45,536.00 ms` | `47,223.33 ms` | n/a | `41.38 MiB/s` |
| Magnet (`Big Buck Bunny`) | `19,416.33 ms` | `21,101.67 ms` | magnet resolve avg `1,788.33 ms` | `13.56 MiB/s` |

### Detailed Observations

#### Local File: small (`Ye - BIANCA`)

- `guest_join_to_ready`
  - min: `1,284 ms`
  - median: `1,530 ms`
  - avg: `1,786.67 ms`
  - max: `2,546 ms`
- `guest_join_to_first_playback`
  - min: `2,801 ms`
  - median: `3,046 ms`
  - avg: `3,302.67 ms`
  - max: `4,061 ms`

Interpretation:

- For a very small local file, the experience is already fairly quick.
- Even here, the guest still waits for the whole transfer to finish before reaching `ready`.

#### Local File: large (`The Net`)

- `guest_join_to_ready`
  - min: `44,670 ms`
  - median: `44,712 ms`
  - avg: `45,536.00 ms`
  - max: `47,226 ms`
- `guest_join_to_first_playback`
  - min: `46,195 ms`
  - median: `46,482 ms`
  - avg: `47,223.33 ms`
  - max: `48,993 ms`

Interpretation:

- This is the clearest sign of the current bottleneck.
- A nearly `1.88 GiB` local file takes about `45.5 s` before the guest reaches `ready`.
- The difference between `ready` and first playback is small, which means most of the wait is happening before playback is allowed.
- The guest is effectively behaving as if it must receive and persist the full file before start.

#### Magnet Link: `Big Buck Bunny`

- `host_magnet_resolve_time`
  - avg: `1,788.33 ms`
- `host_file_select_time`
  - avg: `1.67 ms`
- `guest_join_to_ready`
  - min: `16,736 ms`
  - median: `19,494 ms`
  - avg: `19,416.33 ms`
  - max: `22,019 ms`
- `guest_join_to_first_playback`
  - min: `18,259 ms`
  - median: `21,259 ms`
  - avg: `21,101.67 ms`
  - max: `23,787 ms`

Interpretation:

- Metadata resolution is not the main problem here. `~1.8 s` is noticeable but not dominant.
- The long wait is again mostly in getting the guest to `ready`, not in the last step from `ready` to actual playback.
- This suggests the dominant cost is still download plus full guest transfer/persist plus the current ready policy.

### Analysis

## What Looks Fast Enough

- WebSocket room creation and guest join are fast.
- Magnet metadata resolution is acceptable relative to the full playback wait.
- File selection after magnet resolution is effectively free.

## What Still Looks Slow

- The main bottleneck is not signaling.
- The main bottleneck is not magnet selection.
- The dominant bottleneck is the path from first buffering to guest `ready`.
- For large local files and magnet flows, that path is long enough that users will perceive the app as "downloading the entire movie before starting".

## Likely Bottlenecks By Area

- Signaling:
  - Probably not the current bottleneck. The room and peer setup complete quickly compared with total wait.
- ICE/TURN:
  - Could still contribute, but it is unlikely to explain waits of `19 s` to `45 s` by itself.
- Reading from origin:
  - Matters, especially for magnet, but the data suggests it is not the only limiter.
- Transfer host -> guest:
  - Definitely a major cost.
- Local guest writes:
  - Also likely a major cost because the guest persists data before playback becomes ready.
- Ready policy:
  - Very likely one of the biggest problems. The current behavior appears to delay playback until full transfer is effectively complete in these scenarios.

## Biggest Opportunity To Get Much Faster

- Start playback from partial contiguous ranges instead of waiting for full file completion.
- Promote `mediaUrl` earlier, using the cache-backed local URL as soon as enough contiguous bytes exist for playback.
- Make `ready` mean "enough contiguous data to safely start and stay ahead", not "the entire asset is present".
- Continue background range fetching while already playing.
- Separate source download speed from guest transfer speed in instrumentation so future runs can pinpoint whether the host source or the peer transfer is limiting.

## Practical Conclusion

- Small local files are acceptable today.
- Large local files are too slow because guest startup scales toward full-file transfer time.
- Magnet is faster than the huge local-file case here because the selected asset is much smaller, but it still waits much longer than a modern streaming-like experience should.
- If we want a noticeably better UX, the first big win is to stop gating guest playback on full-file completion.
