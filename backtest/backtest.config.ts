// ══════════════════════════════════════════════════════════════
// backtest.config.ts — Backtest Environment Configuration
// Defines all simulation parameters. No .env dependency.
// Constructs a synthetic BotConfig for src/ module compatibility.
// ══════════════════════════════════════════════════════════════

process.env.ENABLE_SOUND = 'false';

import type { BotConfig, SymbolConstraints } from '../src/utils/types.js';

// ─── Backtest-Specific Configuration ────────────────────────

export interface BacktestConfig {
  /** Starting simulated account balance (USDT) */
  initialBalance: number;

  /** Percentage of balance to risk per trade */
  riskPerTradePct: number;

  /** Trading pairs to backtest */
  pairs: string[];

  /** Number of days of historical data to fetch/simulate */
  days: number;

  /** Maker fee rate (decimal, e.g., 0.001 = 0.1%) */
  makerFeeRate: number;

  /** Taker fee rate (decimal, e.g., 0.001 = 0.1%) */
  takerFeeRate: number;

  /** Slippage percentage on market (SL) executions (e.g., 0.05 = 0.05%) */
  slippagePct: number;

  /** Number of 15m candles before an unfilled limit order is cancelled */
  orderTtlBars: number;

  /** Number of candles required for indicator warmup (EMA200 needs ~210+) */
  warmupCandles: number;

  /** If true, ambiguous bars (TP+SL both hit) are resolved as SL first */
  pessimisticExecution: boolean;

  // ─── R:R and Risk Parameters (mirror live config) ─────────

  /** Take Profit 1 risk-reward ratio */
  tp1RR: number;

  /** Take Profit 2 risk-reward ratio */
  tp2RR: number;

  /** Minimum acceptable risk-reward ratio */
  minRRRatio: number;

  /** Maximum daily loss percentage before circuit breaker trips */
  maxDailyLossPct: number;

  /** Consecutive stop-losses before circuit breaker trips */
  maxConsecutiveLosses: number;

  /** Circuit breaker cooldown in simulated hours */
  circuitBreakerCooldownHours: number;

  // ─── Timeframes ───────────────────────────────────────────

  /** Higher timeframe for trend filtering */
  htfTimeframe: string;

  /** Lower timeframe for entry signals */
  ltfTimeframe: string;
}

// ─── Default Configuration ──────────────────────────────────

export const backtestConfig: BacktestConfig = {
  initialBalance: 5000,
  riskPerTradePct: 1,

  // ─── Pairs — match your .env TRADING_PAIRS ───────────────
  pairs: ['BTC/USDT', 'ETH/USDT'],

  days: 90,

  // ─── Fees — match .env (Futures rates) ───────────────────
  // .env: MAKER_FEE_PCT=0.02, TAKER_FEE_PCT=0.05
  makerFeeRate: 0.0002,   // 0.02% Futures maker (Binance Live)
  takerFeeRate: 0.0005,   // 0.05% Futures taker (Binance Live)

  slippagePct: 0.03,      // Realistic slippage estimate
  orderTtlBars: 16,       // 16 × 15m = 240 minutes (4 hours = 1 HTF candle) TTL
  warmupCandles: 250,
  pessimisticExecution: true,

  // ─── R:R — SMC optimized ────────────────────────────
  tp1RR: 1.5,             // Quick liquidity grab / derisk
  tp2RR: 3,               // Runner
  minRRRatio: 1.5,        // Accept high probability trades

  // ─── Risk limits — match .env ────────────────────────────
  maxDailyLossPct: 3,
  maxConsecutiveLosses: 3,
  circuitBreakerCooldownHours: 4,

  // ─── Timeframes — match .env (HTF_TIMEFRAME=1h, LTF_TIMEFRAME=5m) ───
  htfTimeframe: '4h',
  ltfTimeframe: '15m',
};

// ─── Synthetic BotConfig Builder ────────────────────────────
// Constructs a valid BotConfig that src/ modules expect,
// without requiring .env or API credentials.

export function buildBotConfig(cfg: BacktestConfig): BotConfig {
  return {
    apiKey: 'BACKTEST_NO_API',
    apiSecret: 'BACKTEST_NO_SECRET',
    network: 'demo',
    marketType: 'futures',
    leverage: 5,            // matches .env FUTURES_LEVERAGE=5

    tradingPairs: cfg.pairs,

    riskPerTradePct: cfg.riskPerTradePct,
    maxDailyLossPct: cfg.maxDailyLossPct,
    maxConsecutiveLosses: cfg.maxConsecutiveLosses,
    circuitBreakerCooldownHours: cfg.circuitBreakerCooldownHours,

    minRRRatio: cfg.minRRRatio,
    tp1RR: cfg.tp1RR,
    tp2RR: cfg.tp2RR,

    htfTimeframe: cfg.htfTimeframe,
    ltfTimeframe: cfg.ltfTimeframe,

    // Fees — match .env exactly (decimal % values)
    makerFeePct: cfg.makerFeeRate * 100,   // 0.0002 → 0.02
    takerFeePct: cfg.takerFeeRate * 100,   // 0.0005 → 0.05
    slippageTicks: 2,

    dryRun: true,
  };
}

// ─── Default Symbol Constraints ─────────────────────────────
// Provides reasonable defaults for backtesting when exchange
// metadata is not available. These match typical Binance Futures values.

export function getDefaultConstraints(symbol: string): SymbolConstraints {
  const isBTC = symbol.includes('BTC');

  return {
    symbol,
    minQty: isBTC ? 0.001 : 0.01,
    maxQty: isBTC ? 1000 : 100000,
    stepSize: isBTC ? 0.001 : 0.01,
    minNotional: 5,
    tickSize: isBTC ? 0.01 : 0.01,
    minPrice: 0.01,
    maxPrice: 1000000,
  };
}

// ─── Data File Path Helper ──────────────────────────────────

export function getDataFilePath(symbol: string, timeframe: string): string {
  const sanitized = symbol.replace('/', '');
  return `backtest/data/${sanitized}_${timeframe}.json`;
}
