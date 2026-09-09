# Meridian

**Autonomous Solana spot-momentum and Meteora DLMM agent, powered by LLMs.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

Meridian supports `dlmm_lp`, `spot_momentum`, and opt-in `hybrid` mode. Spot discovery scans cross-DEX SOL pairs using Jupiter token feeds and DEX Screener; execution uses validated Jupiter routes. Hybrid scans both strategies and alternates between spot and LP with at most one combined position. Automatic spot/hybrid entry selection and spot exits are deterministic, without an LLM in the transaction hot path.

---

## What it does

- **Screens opportunities** — scans SOL-quoted pools and applies mode-specific liquidity, organic activity, holder, concentration, momentum, and market-cap gates
- **Trades spot momentum** — optionally buys one freshly revalidated early-spike memecoin setup at a time, then applies mechanical stop, quick profit, tight trailing, and maximum-hold exits
- **Manages DLMM positions** — retains the original LP deploy, fee claim, range, yield, and close workflow when `tradingMode` is `dlmm_lp`
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Discord signals** — optional Discord listener watches LP Army channels for Solana token calls and queues them for screening
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and OOR alerts
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## How it works

Meridian runs a **ReAct agent loop** for candidate judgment, while the backend owns all execution limits and exit rules. The active schedule depends on `tradingMode`:

| Agent | Default interval | Role |
|---|---|---|
| **Spot / hybrid scanner** | Every 5 sec when idle | Independent entry gates; hybrid prioritizes eligible spot, otherwise independently eligible LP |
| **Spot Manager** | Account-change events + 1 sec fallback | Finalized tracked balance and bounded-fresh exit valuation; actual RPC/API and settlement latency vary |
| **DLMM Screening Agent** | Every 30 min | Pool screening — finds and deploys into the best LP candidate |
| **DLMM Management Agent** | Every 10 min | Position management — evaluates each open LP position and acts |

### Agent harness

Meridian's agent harness is the runtime wrapper around every autonomous cycle. It gives both **main** and **experimental** agents the same control loop: load live state, inject relevant memory, expose only role-appropriate tools, execute tool calls, and return a readable cycle report.

The harness also keeps a structured decision log in `decision-log.json` for deployments, closes, skips, and no-deploy outcomes. Each entry records the actor, pool or position, summary, reason, key risks, metrics, and rejected alternatives. Recent decisions are injected back into the system prompt and are available through `get_recent_decisions`, so the agent can answer "why did you deploy?", "why did you close?", or "why did you skip?" without guessing after the fact.

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter APIs — token audit, fallback price data, bounded minimum-output orders, and spot execution

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Jupiter API key (required for spot price fallback and order/execute requests)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm ci --ignore-scripts
npm run postinstall
```

The committed `.npmrc` also disables dependency lifecycle scripts by default.
Run the reviewed root postinstall explicitly as shown above; do not use a
plain `npm install` for production.

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard writes **both** files at the repo root:

| Goes in `.env` | Goes in `user-config.json` |
|---|---|
| `WALLET_PRIVATE_KEY`, `OPENROUTER_API_KEY`, `RPC_URL`, `HELIUS_API_KEY`, `JUPITER_API_KEY` | Trading mode, risk preset, deploy size, max positions |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | Strategy, screening filters, exit rules, trailing TP |
| `DRY_RUN`, `LIVE_TRADING_ENABLED` | Position sizing, cycle intervals, per-role LLM models, `solMode` |

`TELEGRAM_CHAT_ID` only needs to live in `.env` — setup also copies it to `user-config.json` when provided. Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key          # for wallet balance lookups
JUPITER_API_KEY=your_jupiter_key        # required for spot price + swap APIs
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional — for notifications + chat
TELEGRAM_CHAT_ID=                       # auto-filled on first message
DRY_RUN=true                            # leave true while reviewing behavior
LIVE_TRADING_ENABLED=false              # set true only together with DRY_RUN=false for mainnet
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

Optional encrypted `.env` flow:

```bash
cp .env .env.raw
printf "replace-with-a-long-local-key\n" > .envrypt
npm run env:encrypt
```

Meridian loads envrypt-style encrypted values automatically. Keep `.env.raw` and `.envrypt` local; both are gitignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

See [Config reference](#config-reference) below.

### 3. Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # starts the agent; execution still requires both live flags below
```

For mainnet execution, both flags must be explicit after you review `user-config.json`:

```env
DRY_RUN=false
LIVE_TRADING_ENABLED=true
```

Existing installs remain in `dlmm_lp` mode until `tradingMode` is explicitly changed. Its default limits are one position, 0.3 SOL maximum per position, and 0.5 SOL maximum deploy attempts per UTC day.

In `spot_momentum` mode, the default entry is exactly 0.5 SOL with one open position, a 0.1 SOL gas reserve, no daily turnover ceiling, and a 0.05 SOL realized-loss circuit breaker. This requires at least 0.6 SOL in the execution wallet. The LLM cannot change these execution limits. Spot mode has no timed re-entry cooldown, but every new entry must pass a completely fresh backend preflight.

### Hybrid and cross-DEX spot

The example configuration opts into `"tradingMode": "hybrid"` with `dryRun: true`; an existing `user-config.json` is **not** changed automatically. Review it before enabling live execution. The example has no daily SOL-turnover cap (`maxDailyDeploySol` and `spotMaxDailyBuySol` are `null`); daily loss controls remain active.

- Spot discovery combines Jupiter `toptrending/5m` and `toptraded/5m`, deduplicates by mint, and batch-resolves up to 30 eligible mints via DEX Screener. Raydium, PumpSwap, Orca and other SOL-quoted pairs can qualify. Coverage is bounded, not every token/pair. Pool identity, token audit, authorities, token program, momentum and executable round-trip cost are rechecked at entry.
- **LP execution still supports Meteora DLMM only.** A Raydium/Orca spot market is not an LP adapter. An unsafe spot token is not automatically a safe LP fallback; hybrid LP requires its own full preflight, clean authorities/program, native simulation, and 1.5% SDK price slippage tolerance. LP fees do not guarantee net profit and impermanent loss remains possible.
- Shared principal cap: **0.5 SOL**, with **0.1 SOL reserve** plus separate cost funding. Default spot needs **0.605 SOL** in hybrid (0.5 principal + 0.1 reserve + 0.005 maximum fee buffer). With only 0.5 SOL total, this fixed-size spot entry is skipped; LP can size down after reserving another 0.06 SOL for bounded fees/recoverable rent. Neither strategy may consume the other's budget or overlap exposure.
- `hybrid-entry-lock.json` is created atomically before admission across processes. Existing/opening/closing positions, unknown LP snapshots, and pending close settlements block entry. Uncertain submissions keep the lock across restarts; **there is no timed unlock**. Before manual recovery, stop all bot/CLI entry processes, verify the recorded strategy plus local state, signatures, finalized accounts/balances and outstanding settlements, then reconcile the lock/state. Never delete a lock just to force another trade. Ordinary pre-submission rejection releases admission.
- `hybrid-risk-budget.json` tracks cumulative negative SOL balance changes while the wallet is flat. Profits/deposits do not erase already recorded losses; external wallet transfers can distort attribution. Existing same-day spot realized losses and conservative LP cost-basis loss estimates seed/check the limit. The shared 0.05 SOL daily loss admission cap is **not** a guaranteed maximum market loss or audited trade PnL.
- Spot valuation uses a fresh Jupiter sell quote for the tracked amount, including quoted transaction fees. Concurrent requests share one in-flight read; completed exit quotes are never reused for a later event. Profit exits demand a fresh executable net-output floor; a displayed quote is not a filled trade. Provider timeouts/429s fail closed without stale fallback; indicator snapshots are deduplicated and valid for at most 5 seconds. Account notifications are not guaranteed millisecond execution.
- Discovery is separate from executable pricing: token/pair discovery snapshots last at most 10 seconds and LP candidate snapshots at most 30 seconds, including during account-event bursts. Entry execution revalidates the selected pool and quote. GET admission shares each provider's response headers across modules; Jupiter discovery preserves two remaining slots for exits and price reads. A sliding-window reset admits one probe, not a refilled bucket. See [Jupiter rate limits](https://developers.jup.ag/docs/portal/rate-limits).
- Failed close conversions remain pending with persisted exponential retry intervals of 30 seconds to 15 minutes, checked by the settlement loop. Pending settlements block entry before discovery. A single atomic token unit can instead be recorded as `settled_dust_remaining` only after finalized close signatures, finalized position-account absence, two matching finalized balances, and a price no older than 60 seconds valuing it at no more than $0.000001. The token, value timestamp and proof stay in state and `/status`; it is never reported as converted to SOL.

`/status` and `/positions` show **both** spot and LP (failed reads show `unknown`). `/screen` is read-only and labels candidate strategy/venue; `/deploy <n>` reruns the selected strategy's preflight. Use `/close spot` for spot, `/close <n>` for LP, or `/closeall` for both. CLI equivalents include `trading-status`, `spot-status`, `spot-candidates --limit 5`, `spot-open --pool <pair> --dry-run`, and `spot-close --dry-run`.

Provider contracts: [Jupiter Tokens V2](https://developers.jup.ag/docs/tokens/token-information), [DEX Screener API](https://docs.dexscreener.com/api/reference), [Jupiter order and execute](https://developers.jup.ag/docs/swap/order-and-execute). No configuration can guarantee profit, prevent every scam/MEV attack, or eliminate loss. Validate with dry-run before authorizing deployment or live trading.

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

### Run with PM2 (VPS / always-on)

PM2 is the recommended way to keep Telegram control online on a VPS. **Always start via the ecosystem file** so the working directory and script path stay pinned to the repo:

```bash
npm ci --ignore-scripts
npm run postinstall
npm run pm2:start    # uses ecosystem.config.cjs — do NOT use "pm2 start index.js"
pm2 save
```

After `.env`, `user-config.json`, or code changes:

```bash
npm run pm2:restart  # re-reads .env on each restart
npm run pm2:logs
```

To update an existing PM2 install:

```bash
git pull --ff-only
npm ci --ignore-scripts
npm run postinstall
npm run pm2:restart
pm2 save
```

If a previous PM2 run was started incorrectly, reset it once:

```bash
pm2 delete meridian
npm run pm2:start
pm2 save
```

**PM2 vs `npm start`**

| | `npm start` | PM2 |
|---|---|---|
| Terminal | Interactive REPL | Headless daemon |
| Cron / Telegram | Starts after REPL banner | Starts immediately on boot |
| First screening | On cron schedule | May run one cycle right at startup |
| Best for | Local dev / testing | VPS / 24-7 operation |

On startup, logs show `Repo: ... | cwd: ... | PM2 id: ...`. **Repo and cwd must match.** If they differ, delete the process and use `npm run pm2:start` again.

**Common PM2 issues**

| Symptom | Likely cause | Fix |
|---|---|---|
| Crash loop after `git pull` | Safe dependency install skipped | Run `npm ci --ignore-scripts`, `npm run postinstall`, then `npm run pm2:restart` |
| Missing wallet / API keys | Started with `pm2 start index.js` from wrong directory | `pm2 delete meridian && npm run pm2:start` |
| `.env` changes ignored | Old PM2 env snapshot | `npm run pm2:restart` (`.env` now overrides stale PM2 env) |
| Telegram `401 Unauthorized` | Invalid `TELEGRAM_BOT_TOKEN` (not chat ID) | Fix token in `.env`; if encrypted, ensure `.envrypt` exists |
| Telegram commands ignored | Missing/wrong `TELEGRAM_CHAT_ID` | Set in `.env` (or `telegramChatId` in `user-config.json`) |
| Duplicate polling / 409 errors | `nohup node index.js` or second PM2 instance running | Kill stray processes; run only one PM2 app |
| Encrypted env crash at boot | `# encrypted` lines without `.envrypt` key | Add `.envrypt` or use plain `.env` values |

Avoid `nohup node index.js` — it runs outside PM2 and can leave a duplicate Telegram poller fighting the managed process.

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/learn` | Study top LPers across all current candidate pools |
| `/learn <pool_address>` | Study top LPers for a specific pool |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Trigger threshold evolution from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything, request actions, analyze pools |

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, and deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates (pool metrics + token audit + smart money) |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Claude Code agents

Two specialized sub-agents run inside Claude Code:

**`screener`** — pool screening specialist. Invoke when you want to evaluate candidates, analyse token risk, or deploy a position. Has access to Jupiter token audit, smart-wallet checks, and all strategy logic.

**`manager`** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

To trigger an agent directly, just describe what you want:
```
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
npm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
node cli.js <command> [flags]
```

**Positions & PnL**

```bash
meridian positions
meridian pnl <position_address>
meridian wallet-positions --wallet <addr>
```

**Screening**

```bash
meridian candidates --limit 5
meridian pool-detail --pool <addr> [--timeframe 5m]
meridian active-bin --pool <addr>
meridian search-pools --query <name_or_symbol>
meridian study --pool <addr> [--limit 4]
```

**Token research**

```bash
meridian token-info --query <mint_or_symbol>
meridian token-holders --mint <addr> [--limit 20]
meridian token-narrative --mint <addr>
```

**Deploy & manage**

```bash
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr>
meridian close --position <addr> [--skip-swap] [--dry-run]
meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>] [--strategy spot]
meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]
```

**Agent cycles**

```bash
meridian screen [--dry-run] [--silent]   # one AI screening cycle
meridian manage [--dry-run] [--silent]   # one AI management cycle
meridian start [--dry-run]               # start autonomous agent with cron jobs
```

**Config**

```bash
meridian config get
meridian config set <key> <value>
```

**Learning & memory**

```bash
meridian lessons
meridian lessons add "your lesson text"
meridian performance [--limit 200]
meridian evolve
meridian pool-memory --pool <addr>
```

**Blacklist**

```bash
meridian blacklist list
meridian blacklist add --mint <addr> --reason "reason"
```

**Discord signals**

```bash
meridian discord-signals
meridian discord-signals clear
```

**Balance**

```bash
meridian balance
```

**Flags**

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Discord listener

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as signals for the screener agent.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token   # from browser DevTools → Network
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2            # comma-separated
DISCORD_MIN_FEES_SOL=5                           # minimum pool fees to pass pre-check
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Run

```bash
cd discord-listener
npm start
```

Or run it in a separate terminal alongside the main agent. Signals are written to `discord-signals.json` and picked up automatically by `/screen` and `node cli.js screen`.

### Signal pipeline

Each incoming token address passes through a pre-check pipeline before being queued:
1. **Dedup** — ignores addresses seen in the last 10 minutes
2. **Blacklist** — rejects blacklisted token mints
3. **Pool resolution** — resolves the address to a Meteora DLMM pool
4. **Rug check** — checks deployer against `deployer-blacklist.json`
5. **Fees check** — rejects pools below `DISCORD_MIN_FEES_SOL`

Signals that pass all checks are queued with status `pending`. The screener picks up pending signals and processes them as priority candidates before running the normal screening cycle.

### Deployer blacklist

Add known rug/farm deployer wallet addresses to `deployer-blacklist.json`:

```json
{
  "_note": "Known farm/rug deployers — add addresses to auto-reject their pools",
  "addresses": [
    "WaLLeTaDDressHere"
  ]
}
```

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add to `.env`:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your chat id>          # .env alone is enough; also saved to user-config by setup
TELEGRAM_ALLOWED_USER_IDS=<user id>    # required for group/supergroup control
```

Meridian does **not** auto-register the first chat for safety — you must set `TELEGRAM_CHAT_ID` explicitly. For groups, also set `TELEGRAM_ALLOWED_USER_IDS` or inbound commands are ignored.

`401 Unauthorized` in logs means a bad `TELEGRAM_BOT_TOKEN` (invalid, revoked, or encrypted without a working `.envrypt` key) — not a chat ID problem.

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Telegram commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/claimall` | Preview all positions with positive reported unclaimed fees; no transaction is sent |
| `/claimall confirm` | Claim each eligible position sequentially; stops at the first failure |
| `/set <n> <note>` | Set a note on a position |
| `/confirm` | Confirm one pending spot entry after a backend-backed recommendation |
| `/cancel` | Cancel the pending spot entry without sending a transaction |

You can also chat freely via Telegram using the same interface as the REPL. Only allowed user IDs can issue commands in groups.

In `spot_momentum` mode, a plain `ya`/`iya` is accepted only while a single-use confirmation is active. The confirmation expires after two minutes and is bound to the exact pool returned by the backend. Confirmation always reruns the complete entry preflight. Telegram reports `NO TRADE` when validation stops before submission, and reports transaction progress only when the execution result contains authoritative submission evidence.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Trading mode and spot momentum

| Field | Default | Description |
|---|---|---|
| `tradingMode` | `dlmm_lp` | `spot_momentum` for cross-DEX spot only; `hybrid` for alternating spot + DLMM LP. Existing installs never switch implicitly; the example opts into hybrid dry-run |
| `spotTradeAmountSol` | `0.5` | Exact SOL input for each accepted entry |
| `spotMaxTradeAmountSol` | `0.5` | Hard backend ceiling; must not be lower than the configured entry |
| `spotGasReserveSol` | `0.1` | SOL that must remain available beyond the entry capital |
| `spotMaxDailyBuySol` | `null` | Optional maximum buy turnover per UTC day; `null` disables the turnover cap while retaining accounting and the daily loss breaker |
| `spotMaxDailyLossSol` | `0.05` | Stops new entries after this realized daily loss |
| `spotDiscoveryMinLiquidityUsd` | `20000` | Broad discovery liquidity floor before RPC/token-audit work |
| `spotDiscoveryMinVolume5mUsd` | `500` | Broad discovery five-minute volume floor |
| `spotDiscoveryMinVolumeLiquidityRatio` | `0.025` | Broad discovery volume/liquidity floor |
| `spotDiscoveryMinOrganic` | `60` | Broad discovery organic-score floor |
| `spotDiscoveryMinHolders` | `200` | Broad discovery holder floor |
| `spotDiscoveryMinMarketCapUsd` | `75000` | Broad discovery minimum market cap |
| `spotDiscoveryMaxMarketCapUsd` | `50000000` | Broad discovery maximum market cap |
| `spotDiscoveryMinTokenAgeMinutes` | `20` | Broad discovery minimum token age |
| `spotDiscoveryMaxTokenAgeHours` | `2160` | Broad discovery maximum token age (90 days) |
| `spotMinLiquidityUsd` | `30000` | Fresh entry liquidity floor after discovery |
| `spotMinVolume5mUsd` | `2000` | Fresh entry five-minute volume floor |
| `spotMinVolumeLiquidityRatio` | `0.03` | Fresh entry volume/liquidity floor |
| `spotMinOrganic` | `65` | Fresh entry organic-score floor |
| `spotMinHolders` | `300` | Fresh entry holder floor |
| `spotMinMarketCapUsd` | `100000` | Fresh entry minimum market cap |
| `spotMaxMarketCapUsd` | `30000000` | Fresh entry maximum market cap |
| `spotMinTokenAgeMinutes` | `30` | Fresh entry minimum token age |
| `spotMaxTokenAgeHours` | `2160` | Fresh entry maximum token age (90 days) |
| `spotMinPriceChange5mPct` | `1.5` | Minimum five-minute price acceleration for an early spike |
| `spotMaxPriceChange5mPct` | `8` | Reject a five-minute candle above this level to avoid chasing a stretched spike |
| `spotMinVolumeChangePct` | `20` | Minimum short-window volume acceleration |
| `spotMinBuySellVolumeRatio` | `1.15` | Minimum fresh buy/sell-volume pressure |
| `spotMinSpikeScore` | `40` | Minimum composite strength from price acceleration, volume acceleration, and buyer pressure |
| `spotMaxTop10Pct` | `30` | Maximum top-10 holder concentration |
| `spotMaxBotHoldersPct` | `20` | Maximum bot-holder percentage |
| `spotRequireLegacyTokenProgram` | `false` | Set true to reject every Token-2022 mint |
| `spotAllowMetadataOnlyToken2022` | `true` | Permit Token-2022 only when every extension is metadata-only |
| `spotEntrySlippageBps` | `100` | Entry minimum-output tolerance; the order must also satisfy impact and fee caps |
| `spotExitSlippageBps` | `100` | Emergency-exit minimum-output tolerance, kept inside the gap between the early stop and intended maximum loss |
| `spotProfitExitSlippageBps` | `50` | Tighter tolerance for take-profit exits; stop-loss, max-hold, and manual exits keep the normal exit tolerance |
| `spotMaxEntryRoundTripLossPct` | `0.75` | Reject an entry when expected fresh buy-then-sell output, including Jupiter fees and estimated transaction costs, loses more than this |
| `spotMaxEntryWorstCaseLossPct` | `2.5` | Reject an entry when the two minimum-output bounds plus estimated transaction costs exceed the intended maximum loss |
| `spotMinRewardRiskRatio` | `1` | Require the executable profit floor to be at least this multiple of the early stop distance |
| `spotStopLossTriggerPct` | `-1.25` | Early mechanical stop trigger |
| `spotStopLossPct` | `-2.5` | Intended maximum-loss target; fast markets can still execute beyond it |
| `spotTakeProfitPct` | `2.5` | Indicative realtime PnL that immediately triggers a take-profit quote |
| `spotMinProfitExitPct` | `1.25` | Minimum executable net profit over measured entry cost after Jupiter's minimum output and transaction fees |
| `spotTrailingTriggerPct` | `2` | Enables trailing protection after this PnL |
| `spotTrailingDropPct` | `0.75` | Exit after this retracement from peak PnL |
| `spotMaxHoldMinutes` | `5` | Maximum time in one spike position |
| `spotMaxQuoteOutageSec` | `15` | Force repeated emergency close attempts when an executable quote remains unavailable this long |
| `spotExitConfirmTicks` | `1` | Consecutive matching exit decisions required before submission |
| `spotScanIntervalSec` | `5` | Candidate scan interval; overlapping scans remain blocked |
| `spotManagementPollIntervalSec` | `1` | Fallback position/PnL refresh interval when no WebSocket event arrives |
| `spotRealtimeEnabled` | `true` | Subscribe to the active pool account and trigger position management on each coalesced update |
| `spotRealtimeCommitment` | `processed` | Fast WebSocket signal commitment; execution still revalidates finalized balances and transaction results |
| `spotRealtimeEventDebounceMs` | `0` | No deliberate event delay; simultaneous updates and in-flight work still coalesce |
| `spotRealtimeMinRefreshMs` | `0` | No deliberate refresh floor; one refresh runs at a time |

Spot monitoring reacts to pool-account changes and successful transaction logs mentioning the pool. Logs cover AMMs whose swaps change vaults without changing the pool account. Events coalesce into one in-flight refresh and one pending refresh. Every venue, including Meteora spot, is valued using a new tracked-size Jupiter exit quote after transaction fees. Completed exit quotes are never reused; concurrent readers share only the in-flight request. Balance and quote reads begin together with bounded read deadlines. A persistent quote outage triggers emergency-close attempts after `spotMaxQuoteOutageSec`, and maximum holding time remains enforceable during provider failures. Submission still verifies the finalized token balance.

LP monitoring subscribes to both pool and position accounts (`pnlRealtimeEnabled: true`) and rechecks authoritative PnL on each event, with a one-second fallback by default. Known entry pools also trigger fresh screening on account/log events; completed discovery caches are bypassed for these triggers. Up to ten candidates per strategy are watched, expiring after sixty seconds. New-pool discovery still needs the provider's periodic feeds. Position lifecycle changes update subscriptions immediately. A stop-loss is observed even while another workflow is busy, then retried when the transaction lane is released. `/status` and `get_trading_status` expose per-monitor p95 event-to-refresh and refresh-duration measurements.

Before signing `TAKE_PROFIT` or `TRAILING_TAKE_PROFIT`, Jupiter's minimum SOL output minus transaction fees must exceed the measured entry cost by `spotMinProfitExitPct`. A rejected profit exit is retried on a fresh signal. Stop-loss, max-hold and manual exits can realize a loss. WebSocket delivery, provider freshness, RPC responses and transaction landing still take time; an event-driven scheduler cannot guarantee zero latency or a profitable outcome.

Existing installations can merge the reviewed keys in [`realtime-config.patch.json`](realtime-config.patch.json) into their existing `user-config.json` during an authorized rollout. Preserve all other settings, wallet credentials and runtime state. The patch is not loaded automatically. See [`REALTIME-VALIDATION.md`](REALTIME-VALIDATION.md) for measured scope and release checks.

Spot discovery is intentionally broader than the fresh entry gate, so more pools reach the expensive token and indicator checks without weakening the final decision. The final entry gate looks for an early spike rather than a late pump: 5-minute price acceleration must remain inside the configured band, volume and buyer pressure must be rising, and their composite spike score must pass. It also requires a SOL quote, disabled mint and freeze authorities, a fresh token audit, real 5-minute and 15-minute indicator evidence, positive buyers, bounded concentration, and a fresh round-trip quote. Both expected output and the two-leg minimum-output tail are checked after estimated transaction costs, and configuration rejects an unfavorable executable reward/risk ratio. A disabled or evidence-free indicator service fails closed. After all gates pass, the backend selects the lowest executable round-trip cost deterministically and revalidates immediately; the LLM is not in the automatic transaction hot path. Legacy SPL tokens are supported; Token-2022 mints are supported only with no extensions or the `MetadataPointer`/`TokenMetadata` extensions. Every behavioral or unknown extension—including transfer fees, hooks, permanent delegates, pausing, non-transferability, and mint-close authority—is rejected fail-closed. Jupiter orders are checked for the exact mint pair and amount, explicit minimum output, quote age, price impact, fees, expiry, local simulation, mainnet identity, and finalized outcome. These controls reduce avoidable execution risk; they cannot guarantee profit or prevent all memecoin losses.

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.15` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minVolumeActiveTvlRatio` | `0.02` | Minimum fresh volume divided by active TVL |
| `minOrganic` | `70` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `maxVolatility` | `12` | Maximum 30-minute volatility accepted; checked again immediately before deploy |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBotHoldersPct` | `30` | Maximum bot holder % (Jupiter audit) |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `requireTokenAudit` | `true` | Fail closed if fresh fees/top-10/bot-holder audit is unavailable |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Preferred base SOL per new position; if less is available, auto-deploy uses the remaining SOL after `gasReserve` |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use; set `1` to use all SOL after gas reserve |
| `maxPositions` | `1` | Maximum simultaneously open positions |
| `maxDeployAmount` | `0.3` | Maximum SOL cap per position; set `null` to disable this ceiling |
| `maxDailyDeploySol` | `0.5` | Maximum deploy attempts per UTC day; set `null` to disable this aggregate cap. Uncertain attempts remain counted when enabled. |
| `lossCircuitBreakerEnabled` | `true` | Keep realized-loss context and reduced recovery sizing active |
| `lossCircuitWindowPositions` | `5` | Closed positions included in the rolling-loss window |
| `maxConsecutiveLosses` | `3` | Consecutive realized losses that activate loss-aware recovery |
| `maxRollingLossPct` | `12` | Rolling loss magnitude that activates recovery sizing |
| `maxSingleLossPct` | `12` | Single-position loss magnitude that activates recovery sizing |
| `lossCircuitStreakCooldownHours` | `0` | Deprecated pause setting, always normalized to `0`; streaks only affect recovery sizing |
| `lossCircuitRollingCooldownHours` | `0` | Deprecated pause setting, always normalized to `0` |
| `lossCircuitSingleCooldownHours` | `0` | Deprecated pause setting, always normalized to `0` |
| `lossCircuitRecoverySizePct` | `0.5` | Fraction of normal size allowed after a loss trigger until a profitable close |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `stopLossPct` | `-15` | Intended maximum-loss target; the final on-chain outcome can still move during execution |
| `stopLossTriggerPct` | `-8` | Early stop-loss trigger, deliberately above `stopLossPct` to leave execution room |
| `stopLossConfirmTicks` | `1` | Authoritative PnL ticks required for stop loss; a fresh RPC recheck still occurs before submission |
| `stopLossCooldownHours` | `12` | Blocks re-entry to the same pool and token after a stop-loss that settles negative; set `0` only to disable it explicitly |
| `takeProfitPct` | `3` | Close when fees earned reach this % of capital |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | Activate trailing TP at this PnL % |
| `trailingDropPct` | `1.5` | Close when PnL drops this % from peak |
| `strategy` | `bid_ask` | LP strategy: `spot`, `bid_ask`, or `curve` |

`stopLossTriggerPct` must stay above `stopLossPct` (for example, `-8` and `-15`). This reduces execution overshoot, but a direct on-chain close cannot mathematically guarantee the final PnL during a sudden market move. The fast PnL watchdog keeps sampling while other workflows are busy and defers only transaction submission until the transaction lane is free. A negative settled stop-loss starts the pool/token cooldown so the bot does not immediately re-enter the same collapsing asset. When the LP relay is enabled and returns a valid zap-out order, Meridian uses the relay's configured minimum-output slippage bound before any local fallback.

Before every deploy, Meridian re-fetches pool fundamentals, token audit data, and 5-minute plus 15-minute momentum. Entry fails closed unless both timeframes show a rising price above bullish Supertrend with RSI in the configured `45–72` band. The loss response has no timed global pause, including when legacy nonzero cooldown settings are present: qualifying setups can be considered immediately, but backend sizing remains at 50% after a loss trigger until a profitable position closes. Neither the model nor a direct `deploy_position` call can bypass these checks.

For new LP pools, the opportunity poll remains a 45-second discovery backstop and may launch a full decision again after 90 seconds. Known watched pools can trigger screening immediately from on-chain events. This 90-second limit only prevents duplicate model/API work; it is not a loss cooldown.

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `openai/gpt-oss-20b:free` | LLM for management cycles |
| `screeningModel` | `openai/gpt-oss-20b:free` | LLM for screening cycles |
| `generalModel` | `openai/gpt-oss-20b:free` | LLM for REPL / chat |

> Override model at runtime: `node cli.js config set screeningModel anthropic/claude-opus-4-5`

### Jupiter swap fee (referral)

Every token swap the agent makes (auto-swap base→SOL after a close/claim) goes through **Jupiter Ultra**. Autonomous swaps are deliberately restricted to selling a position token back to SOL; the agent cannot spend SOL buying an arbitrary token from model-provided input. Referral fees are disabled by default.

**Settings** (env only — *not* in `user-config.json`):

| Env var | Default | Description |
|---|---|---|
| `JUPITER_REFERRAL_ACCOUNT` | empty | A **Jupiter referral account** (not just any wallet). Set only if you intentionally want to collect referral fees yourself. |
| `JUPITER_REFERRAL_FEE_BPS` | `0` | Fee in basis points. **Jupiter Ultra requires 50–255 bps**; `0` leaves referrals off. |

```bash
# .env — collect the referral fee on your own Jupiter referral account
JUPITER_REFERRAL_ACCOUNT=<your-jupiter-referral-account>
JUPITER_REFERRAL_FEE_BPS=50
```

To collect a referral intentionally, configure both values yourself. Invalid accounts or fees outside 50–255 bps are ignored and the swap proceeds without a referral.

---

## How it learns

### Lessons

After every closed position the agent runs `studyTopLPers` on candidate pools, analyzes on-chain behavior of top performers (hold duration, entry/exit timing, win rates), and saves concrete lessons. Lessons are injected into subsequent agent cycles as part of the system context.

Add a lesson manually:
```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Threshold evolution

After 5+ positions have been closed, run:
```bash
node cli.js evolve
```

This analyzes closed position performance (win rate, avg PnL, fee yields) and automatically adjusts screening thresholds in `user-config.json`. Changes take effect immediately.

---

## HiveMind

HiveMind is opt-in. Configure both a URL and API key if you want the agent to register, pull shared lessons/presets, and push learning events.

**What you get:**
- Shared lessons from other Meridian agents
- Strategy presets and crowd performance context
- Role-aware lessons injected into future screener/manager prompts when `hiveMindPullMode` is `auto`

**What you share:**
- Lessons from `lessons.json`
- Closed-position performance events: pool, pool name, base mint, strategy, close reason, PnL, fees, and hold time
- Agent heartbeat metadata: agent ID, version, timestamp, and basic capability flags
- **Private keys and wallet balances are never sent**

HiveMind failures are non-blocking. If Agent Meridian is unavailable, the agent logs a warning and keeps running.

### Setup

No manual HiveMind registration command is required after you configure a trusted endpoint. `agentId` is generated automatically on first enabled startup if it is missing.

Relevant config fields:

```json
{
  "agentId": "",
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

Leave either `hiveMindUrl` or `hiveMindApiKey` blank to keep HiveMind disabled. Set `hiveMindPullMode` to `manual` if you only want to pull shared lessons and presets on demand.

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env (repo-root paths)
repo-root.js        Stable absolute repo path — used by PM2, state files, and .env loading
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry (state.json)
spot-state.js       Atomic spot position state and trade history
spot-risk-budget.js Atomic daily spot turnover and realized-loss budget
spot-momentum.js    Pure candidate and mechanical exit policy
decision-log.js     Structured decision log for deploy, close, skip, and no-deploy rationale
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
risk-intelligence.js Realized-loss recovery sizing, fresh pool/token gates, AI risk brief
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram bot: polling + notifications
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
cli.js              Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper
  spot.js           Spot discovery, fresh preflight, open/close, and PnL snapshots
  screening.js      Pool discovery
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API

discord-listener/
  index.js          Selfbot Discord listener
  pre-checks.js     Signal pre-check pipeline

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.

### Docker deployment

The production Compose service exposes no ports and runs as a non-root Node user. Build contexts exclude `.env`, `user-config.json`, and all runtime state; provision those files directly on the host with mode `0600`, never through Git.

For a host-mounted deployment, create the `node_modules` symlink once before the first start:

```sh
ln -s /runtime/node_modules /opt/meridian/node_modules
docker compose up -d --build
```

The process verifies the Solana mainnet genesis hash before it starts cron cycles or Telegram long polling. It repeats that check immediately before every simulation, signing, relay submission, or Jupiter execution. A non-mainnet or unverifiable endpoint leaves the process fail-closed.

### Screening reliability and diagnostics

Hybrid screening has a 30-second **read-only** deadline, independent 20-second
spot/LP scanners, bounded HTTP bodies/RPC reads, and expiring in-flight market
requests. A timed-out or late market result cannot initiate an entry. Financial
execution is outside that timeout: uncertain submissions keep their durable
entry lock until reconciliation, never a timed unlock or blind retry.

LP candidates pass the same fresh pool, token audit, mint safety, and indicator
gate used immediately before execution. Screening checks successive batches of
three (up to 12 per scan), instead of stopping after the first rejected leaders.
Execution still revalidates every selected candidate. Entry sizing uses finalized
RPC SOL; an API error is unknown balance/exposure, not a verified zero.

Spot buyer activity uses `stats5m`, not `stats1h`. The public
[Jupiter token schema](https://developers.jup.ag/docs/tokens/token-information)
defines these as separate windows. Activity is mint-wide; pool price/volume is
venue-specific. Both use the five-minute window. Required 5m/15m indicators are
fetched concurrently and must remain fresh; their acceptance rules are unchanged.

`runtime-health.json` records scanner phase, completed scans, errors, and a
10-second process heartbeat. Docker checks that snapshot and the actual daemon
PID. Trading status includes scanner health; Telegram reports failure/recovery
transitions. Three failed scans or stale progress are unhealthy. An empty but
successful scan is healthy; an explicitly paused scanner is reported separately.
Partial provider failures are `degraded`; unresolved entry/settlement work is
`blocked`. Both show `ready: false` while preserving process liveness. `/status`
includes pending conversions, retry times, retained dust and provider resets.
Provider request counters are persisted with the heartbeat for external checks.
Scanner progress monitoring covers spot/hybrid modes; legacy LP mode currently
has process-heartbeat monitoring. Docker's restart policy alone does **not**
restart an unhealthy-but-running container. No transaction is unlocked by health
checks. For diagnosis:

```sh
docker compose exec -T meridian node scripts/healthcheck.js
docker compose logs --since 30m meridian
```

Look for `SCREENING_CYCLE` durations/stages and `hybrid_error` decisions. The
structured decision log retains the newest 2,000 records, including gate reasons
and rejection counts; it is a bounded recent history, not an all-time ledger.

### Offline profitability evaluation

These commands only read files: no wallet loading, network, trading, or automatic
risk adjustment. Closed-trade `pnlSol` is already measured net wallet PnL; fees are
not subtracted twice. Spot status includes the latest 100 recorded trades' summary.

```sh
npm run evaluate:spot
npm run evaluate:spot -- --state /absolute/path/to/spot-state.json
npm run evaluate:spot -- --replay /absolute/path/to/quotes.json
npm run evaluate:spot -- --replay test/fixtures/spot-replay.json
```

A replay file supplies measured entry cost (including entry fees), timestamped
tracked-size minimum exit outputs (already accounting for slippage), and explicit
exit fees:

```json
{
  "entryCostSol": 0.501,
  "openedAt": "2026-09-07T00:00:00Z",
  "quotes": [
    { "at": "2026-09-07T00:00:01Z", "minimumOutSol": 0.508, "exitFeeSol": 0.001 }
  ]
}
```

The evaluator reports net expectancy, average wins/losses and the historical
break-even win rate, or replays the mechanical exit rule. Replays are not proof
of transaction landing, latency, MEV protection, or future profits. The entry
round-trip quote gate remains a quoted spread/impact check, **not** a guarantee
of all-in profitability. Reserve, position size, profit floor, stop-loss and
daily-loss limits are unchanged by these reliability fixes. Validate strategy
changes with recorded quotes/paper runs before changing live risk settings.
