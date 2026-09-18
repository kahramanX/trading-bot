# Backtest Environment — Walkthrough

## What Was Built

A complete, isolated backtesting environment in `backtest/` with **zero modifications to `src/`**.

## Files Created

| File | Purpose |
|------|---------|
| [`backtest/tsconfig.json`](file:///Users/musti/Documents/PersonalGithub/trading-bot/backtest/tsconfig.json) | Separate TS config — resolves imports from both `src/` and `backtest/` |
| [`backtest/backtest.config.ts`](file:///Users/musti/Documents/PersonalGithub/trading-bot/backtest/backtest.config.ts) | All simulation parameters + synthetic `BotConfig` builder (no `.env` needed) |
| [`backtest/fetch_data.ts`](file:///Users/musti/Documents/PersonalGithub/trading-bot/backtest/fetch_data.ts) | CCXT Binance data fetcher with pagination, dedup, and JSON serialization |
| [`backtest/backtest_runner.ts`](file:///Users/musti/Documents/PersonalGithub/trading-bot/backtest/backtest_runner.ts) | ~1,100-line core simulation engine |
| `backtest/results/.gitkeep` | Ensures results dir exists in git |

## Files Modified (non-src)

| File | Change |
|------|--------|
| [`package.json`](file:///Users/musti/Documents/PersonalGithub/trading-bot/package.json) | Added `backtest:fetch` and `backtest:run` scripts |
| [`.gitignore`](file:///Users/musti/Documents/PersonalGithub/trading-bot/.gitignore) | Excluded `backtest/data/` and result files |

## How to Run

```bash
# Step 1 — Download historical data (run once, or when you want fresh data)
npm run backtest:fetch

# Step 2 — Run the simulation
npm run backtest:run
```

## Validation Results

- ✅ `npx tsc --noEmit --project backtest/tsconfig.json` → **0 errors**
- ✅ Runner banner renders + fails gracefully with "run fetch_data first" message
- ✅ `git diff --name-only src/` → **empty** (zero src/ modifications)

## Critical Logic Implemented

### Anti-Lookahead Bias
`sliceHTF()` only includes 4H candles where `candleCloseTime <= currentTimestamp`. The current 15m bar timestamp is used as the strict cutoff.

### Pessimistic Execution
When both TP and SL are reachable on the same bar (`candle.high > tp AND candle.low <= sl`), the SL is processed first. Controlled by `pessimisticExecution: true` in config.

### Realistic Fills (Strict Inequality)
- LONG limit fill: `candle.low < limitPrice` (not `<=`)
- SHORT limit fill: `candle.high > limitPrice` (not `>=`)
- TP fills use the same strict-past logic

### Fee & Slippage Model
| Event | Fee Type | Slippage |
|-------|----------|----------|
| Limit entry | Maker (0.1%) | None |
| Limit TP | Maker (0.1%) | None |
| Market SL | Taker (0.1%) | +0.05% on fill price |

### Break-Even Logic
On TP1 fill (50% closed at `tp1RR=2`): immediately sets `stopLoss = entryPrice`. The remaining 50% rides with a zero-risk stop.

### Ghost Order TTL
Unfilled limit orders are tracked with `barsSincePlaced`. After `orderTtlBars=8` bars (2 hours at 15m), the order is cancelled and capital is freed.

### In-Memory Circuit Breaker
Mirrors `src/risk/circuit_breaker.ts` logic but uses a plain object (`SimulatedCBState`) — no disk writes, no interference with live state. Supports simulated day boundaries and cooldown expiry.
