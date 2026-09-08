# Realtime and loss-recovery validation

Date: 2026-09-08. Worktree: `feat/realtime-loss-recovery`, based on `70fe3d6`, which committed the exact 15 modified files preserved at task start over `2cee501`. The baseline file contents are unchanged.

## Reproduced defects and changes

| Observed in code / regression | Change |
| --- | --- |
| Completed exit quotes were reused for up to 3 seconds after a new market event. | No completed exit-quote cache; overlapping requests still coalesce and HTTP 429 backoff remains bounded. |
| A Meteora spot pool mark could show +4% while the executable proceeds showed -3%. | All spot venues use tracked-size net exit quotes. Pool marks cannot mask an executable stop-loss. |
| Quote fetching waited for a finalized balance read first. | Bounded balance and quote reads begin concurrently; submission still independently checks finalized holdings. |
| Legacy cooldown settings could freeze entry after a loss streak. | Legacy global loss pause settings are ignored. Loss history still informs LP recovery sizing. The absolute daily-loss cap and pool/token-specific protections are separate and remain active. |
| Spot monitoring skipped the entire check while another workflow was busy. | The watchdog keeps observing risk and defers only submission, waking as soon as the lane is available. |
| LP checks and known-candidate entry waited for polling. | Pool/position account events trigger LP checks; watched pool account/log events trigger fresh screening. Lifecycle changes update subscriptions and queued events are coalesced. |
| A swap could change an AMM vault without changing the watched pool account. | Spot and entry monitors also subscribe to successful transaction logs mentioning each watched pool. |

## Synthetic latency measurement

Command: `node scripts/benchmark-realtime.js [baseline-directory]`. The baseline is the original working-tree snapshot, not pristine HEAD. Both runs use 12 bursts of 3 events and the same simulated 25 ms read, with no network or wallet.

| Metric | Before | After |
| --- | ---: | ---: |
| Event-to-refresh p50 | 473 ms | 2 ms |
| Event-to-refresh p95 / p99 | 476 ms | 2 ms |
| Refresh duration p95 | 26 ms | 26 ms |
| Events / refreshes including startup | 36 / 13 | 36 / 13 |

The measured improvement is removal of scheduler waiting. It excludes RPC, provider indexing, quote generation, simulation, transaction landing and finality. None of these measurements proves live profit or establishes the cause of every historical loss.

## Validation and rollout state

- Baseline: 235 tests passed. Updated suite: 247 tests passed, including syntax checks, mainnet/dry-run guards, settlement, entry economics, fresh quotes, loss recovery, monitoring races and subscription cleanup.
- Test commands use `DRY_RUN=true LIVE_TRADING_ENABLED=false ALLOW_SELF_UPDATE=false`. Transaction tests use injected fakes. No live trade, VPS change or message delivery was performed.
- Original checkout files were compared with the starting snapshot and remain unchanged.
- [`realtime-config.patch.json`](realtime-config.patch.json) contains only the reviewed runtime changes. Existing explicit debounce/refresh settings must be replaced with its zero values to enable the measured behavior. This file is not applied automatically.
- Before a production cutover, inspect actual deployed code, current losses, open exposure and pending settlement; preserve credentials and all position/budget state; verify the candidate in the deployment environment; merge the config patch; then verify subscriptions, fallback checks and p95 measurements after restart. Production rollout needs authorization.

## Remaining external latency

Only discovered pools can be subscribed. New pools still arrive via periodic discovery feeds, and discovery/indicator providers can publish delayed snapshots or impose rate limits. Events trigger fresh validation; they never bypass audit, slippage, simulation, balance, expiry or finality checks. The configured daily monetary-loss cap can still stop new entries independently of a loss streak.

Solana documents account-change notifications in [accountSubscribe](https://solana.com/docs/rpc/websocket/accountsubscribe), and one-address transaction-log filters in [logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe). Execution remains on the existing [Jupiter order/execute flow](https://developers.jup.ag/docs/swap/order-and-execute).
