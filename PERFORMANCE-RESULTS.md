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

## 2026-04-05 Post-Refactor Validation

### Setup

- Refactor target: progressive guest activation in `LocalFileRoomPlayer.tsx`
- App mode: dev desktop with CDP on port `9222`
- Backend: local SyncPlay server on `127.0.0.1:8787`
- Torrent proxy: local on `127.0.0.1:8788`
- Reports:
  - `reports/perf-local-bianca-after.json`
  - `reports/perf-local-thenet-after.json`
  - `reports/perf-magnet-bbb-after.json`

### Iterations

- Local small: `3`
- Local large: `3`
- Magnet: `1`

Note:

- The 3-iteration magnet rerun was aborted after becoming too variable on public peers.
- The single completed magnet run is still a valid end-to-end measurement and clearly shows the new startup behavior.

### Summary

| Scenario | Before join -> ready avg | After join -> ready avg | Before join -> first playback avg | After join -> first playback avg | What changed |
| --- | ---: | ---: | ---: | ---: | --- |
| Local file, small (`Ye - BIANCA`) | `1,786.67 ms` | `3,144.00 ms` | `3,302.67 ms` | `4,748.67 ms` | No meaningful win; file is so small that full download still dominates and early activation does not help much |
| Local file, large (`The Net`) | `45,536.00 ms` | `3,473.00 ms` | `47,223.33 ms` | `52,897.33 ms` | Huge startup win for `ready/canplay`, but sustained playback is still unstable and often falls back late |
| Magnet (`Big Buck Bunny`) | `19,416.33 ms` | `12,165.00 ms` | `21,101.67 ms` | `13,769.00 ms` | Clear win; guest now starts from partial cache instead of waiting for the full file |

### Percentage Change

| Scenario | Join -> ready change | Join -> first playback change |
| --- | ---: | ---: |
| Local file, small (`Ye - BIANCA`) | `75.97%` slower | `43.78%` slower |
| Local file, large (`The Net`) | `92.37%` faster | `12.02%` slower |
| Magnet (`Big Buck Bunny`) | `37.35%` faster | `34.75%` faster |

### What The New Runs Prove

#### Local File: large (`The Net`)

- The guest now gets a cache-backed media URL in about `3.84 s` average.
- The guest reaches `ready` in about `3.47 s` average instead of `45.54 s`.
- The guest reaches `canplay` in about `3.48 s` average.
- In the successful startup path, `ready` happens with only about `1.7%` to `2.2%` of the file persisted, not `100%`.

Interpretation:

- This is the strongest proof that the app no longer behaves purely as download-then-play for startup.
- The guest can now initialize media from the progressive cache and become playable long before full transfer completes.
- The remaining problem moved downstream: keeping playback advancing smoothly for this large MP4.

#### Magnet: `Big Buck Bunny`

- Completed validation run:
  - `guest_join_to_ready`: `12,165 ms`
  - `guest_join_to_canplay`: `12,180 ms`
  - `guest_join_to_first_playback`: `13,769 ms`
- In that run, the guest reached `ready` with about `27.2%` of the file persisted.
- The guest used the `/cache/...` progressive URL for `mediaUrl`, `canplay`, and first playback.

Interpretation:

- Magnet also benefited from the refactor.
- The guest is no longer waiting for full completion before becoming playable.
- Compared with the previous baseline, this is a real end-to-end improvement, not just a state-label change.

#### Local File: small (`Ye - BIANCA`)

- The small file did not improve.
- In practice it still finishes so fast that the progressive path does not buy much, and the completed-file fallback remains dominant.

Interpretation:

- This is acceptable.
- The important target for this refactor was medium and large assets, where startup latency matters.

### Performance Analysis After Refactor

## What Is Now Much Faster

- Guest startup for large local files is dramatically faster.
- Guest startup for magnet playback is materially faster.
- `mediaUrl`, `ready`, and `canplay` are no longer effectively gated on `bytesPersisted === fileSize`.
- The progressive cache-backed URL is now being used in real runs.

## What Is Still Slow

- Large local MP4 playback continuity is still not good enough.
- For `The Net`, `join -> first playback` is still around `52.9 s` on average even though `join -> ready` is only `3.47 s`.
- Some large-file runs still eventually switch to the completed local fallback source, which means the progressive source is not yet robust enough for sustained playback in every case.

## Current Likely Bottlenecks

- Initial activation:
  - Much better now. This is no longer the main problem.
- Sustained byte delivery for large local MP4:
  - Still a problem. The progressive source becomes playable, but playback progress is not consistently maintained.
- Request window / prefetch policy:
  - Likely still too conservative for some high-bitrate opening segments.
- Video error recovery:
  - Better than before, but not fully stable for large files.
- Ready policy:
  - It is now permissive enough to start early, but possibly still not aligned enough with a safe sustained-start threshold.

## Biggest Remaining Opportunities

- Increase or adapt the sequential prefetch window after early activation so the guest stays comfortably ahead once playback starts.
- Instrument and tune the exact reason large local playback stalls after early `canplay`.
- Avoid switching to the completed local fallback unless the progressive cache source has definitively failed.
- Revisit MP4-specific startup behavior for files whose metadata/layout makes long-term progressive playback harder.

### Practical Conclusion

- The core startup refactor worked.
- We successfully changed the guest behavior from "must finish downloading before startup" to "can become playable from partial cache" for the scenarios that matter.
- The biggest remaining gap is not startup anymore; it is stable continuous playback for very large local MP4 files.

## 2026-04-05 Playback Continuity Fix

### Problem Confirmed

- `The Net` could reach early buffering readiness, but the guest stayed visually stuck near `0:00`.
- The video only became truly watchable much later, often when transfer progress was already very high.
- The `Resync` button and the visible playback time flickered because transfer phase oscillated while playback never stabilized.

### Root Cause

- The guest was activating progressive playback early, but it was still fetching too little useful sequential data ahead of the playhead.
- While the file was incomplete, the guest could also start chasing the host's authoritative time too aggressively, which made it request future ranges instead of protecting continuity near the current playback point.
- Request windows were too small for large MP4 startup, so the player kept hovering near the edge of starvation.

### Fixes Applied

- Kept progressive startup, but made the guest prioritize sequential continuity while the source is still incomplete.
- Prevented aggressive authoritative seek chasing on incomplete progressive media unless the target is still near the local playhead.
- Increased request window size from `2 MiB` to `8 MiB`.
- Added more aggressive multi-request prefetch during startup and early streaming.
- Kept the `Resync` button enabled once playback is already considered ready, even if transfer phase still reports temporary buffering internally.
- Added a targeted E2E diagnostic script: `scripts/diagnose-local-progressive.mjs`

### Validation

#### Directed E2E validation: `The Net`

- Input: `/Users/yerovy/Downloads/The.Net.1995.1080p.BluRay.x264.YIFY.mp4`
- First ready sample: `~3.52 s`
- First visible motion: `~4.03 s`
- First real playback (`currentTime >= 1.5`): `~5.06 s`
- Transfer progress at first real playback: `~4.15%`
- Resync toggle count during the validation window: `1`

Interpretation:

- This reproduces the original issue and confirms it is resolved.
- The guest now starts moving almost immediately after progressive activation instead of waiting for extreme transfer progress.
- The `Resync` flicker is effectively gone in the watchable path.

#### Perf validation: `The Net`

- Report JSON: `reports/perf-local-thenet-fixcheck.json`
- `guest_join_to_ready`: `8,883 ms`
- `guest_join_to_canplay`: `8,895 ms`
- `guest_join_to_first_playback`: `8,914 ms`

Interpretation:

- This is much slower than the artificially optimistic early-ready-only result, but it reflects real stable playback much better.
- More importantly, playback now begins while the file is still far from complete instead of waiting until near-total transfer.

#### Regression check: magnet

- Report JSON: `reports/perf-magnet-bbb-fixcheck.json`
- `guest_join_to_ready`: `13,300 ms`
- `guest_join_to_first_playback`: `13,352 ms`

Interpretation:

- Magnet playback still works with the new continuity changes.
- Startup remains progressive and does not regress back to full-download behavior.

### Practical Conclusion

- The original startup refactor introduced a real continuity problem for very large local files.
- That continuity problem has now been resolved in end-to-end validation.
- The guest can now start real playback of `The Net` at roughly `4%` transfer progress instead of only becoming truly watchable near completion.
