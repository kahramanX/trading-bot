// ══════════════════════════════════════════════════════════════
// backtest.config.ts — Backtest Environment Configuration
// Defines all simulation parameters. No .env dependency.
// Constructs a synthetic BotConfig for src/ module compatibility.
// ══════════════════════════════════════════════════════════════

process.env.ENABLE_SOUND = 'false';

import fs from 'fs';
import path from 'path';
import type { BotConfig, SymbolConstraints } from '../src/utils/types.js';

// ─── Backtest-Specific Configuration ────────────────────────

export interface BacktestConfig {
  /** Starting simulated account balance (USDT) */
  initialBalance: number;

  /** Percentage of balance to risk per trade */
  riskPerTradePct: number;

  /** Trading pairs to backtest */
  pairs: string[];

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

  /** Minimum Stop Loss distance percentage */
  minSlPct: number;

  // ─── Timeframes ───────────────────────────────────────────

  /** Higher timeframe for trend filtering */
  htfTimeframe: string;

  /** Lower timeframe for entry signals */
  ltfTimeframe: string;

  // ─── Institutional Filters ────────────────────────────────

  /** ADX period for volatility filtering */
  adxPeriod: number;

  /** Minimum ADX value required to trade */
  adxThreshold: number;

  /** Allowed sessions (Killzones) */
  allowedSessions: {
    timezone: string;
    london: { start: string; end: string; };
    ny: { start: string; end: string; };
  };
}

// ─── Default Configuration ──────────────────────────────────

// Add pairs you want to skip here, e.g., ['XAU/USDT']
const EXCLUDED_PAIRS: string[] = ["XAG/USDT", "XPT/USDT"];

function getAvailablePairs(): string[] {
  try {
    const dataDir = path.resolve(process.cwd(), 'backtest/data');
    if (!fs.existsSync(dataDir)) return [];
    const dirs = fs.readdirSync(dataDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      .filter(name => name.includes('-'));
    if (dirs.length === 0) return [];
    return dirs
      .map(name => name.replace('-', '/'))
      .filter(pair => !EXCLUDED_PAIRS.includes(pair));
  } catch {
    return [];
  }
}

export const backtestConfig: BacktestConfig = {
  initialBalance: 1000,
  riskPerTradePct: 1,

  // ─── Pairs — dynamically loaded from backtest/data ───────────────
  pairs: getAvailablePairs(),

  // ─── Fees — match .env (Futures rates) ───────────────────
  // .env: MAKER_FEE_PCT=0.02, TAKER_FEE_PCT=0.05
  makerFeeRate: 0.0002,   // 0.02% Futures maker (Binance Live)
  takerFeeRate: 0.0005,   // 0.05% Futures taker (Binance Live)

  slippagePct: 0.03,      // Realistic slippage estimate
  orderTtlBars: 12,       // 12 bars TTL
  warmupCandles: 250,
  pessimisticExecution: true,

  // ─── R:R — SMC optimized ────────────────────────────
  tp1RR: 2,             // Quick liquidity grab / derisk
  tp2RR: 3,               // Runner
  minRRRatio: 2,        // Accept higher probability/reward trades

  // ─── Risk limits — match .env ────────────────────────────
  maxDailyLossPct: 3,
  maxConsecutiveLosses: 3,
  circuitBreakerCooldownHours: 4,
  minSlPct: 0.002,

  // ─── Timeframes ───────────────────────────────────────────
  htfTimeframe: '1h',
  ltfTimeframe: '5m',

  // ─── Institutional Filters ───
  adxPeriod: 14,
  adxThreshold: 20,
  allowedSessions: {
    timezone: 'Europe/Istanbul',
    london: { start: '10:00', end: '13:00' },
    ny: { start: '15:30', end: '19:00' },
  },
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
    leverage: 50,

    tradingPairs: cfg.pairs,

    riskPerTradePct: cfg.riskPerTradePct,
    maxDailyLossPct: cfg.maxDailyLossPct,
    maxConsecutiveLosses: cfg.maxConsecutiveLosses,
    circuitBreakerCooldownHours: cfg.circuitBreakerCooldownHours,
    minSlPct: cfg.minSlPct,

    minRRRatio: cfg.minRRRatio,
    tp1RR: cfg.tp1RR,
    tp2RR: cfg.tp2RR,

    htfTimeframe: cfg.htfTimeframe,
    ltfTimeframe: cfg.ltfTimeframe,

    // Fees — match .env exactly (decimal % values)
    makerFeePct: cfg.makerFeeRate * 100,   // 0.0002 → 0.02
    takerFeePct: cfg.takerFeeRate * 100,   // 0.0005 → 0.05
    slippageTicks: 2,

    adxPeriod: cfg.adxPeriod,
    adxThreshold: cfg.adxThreshold,
    allowedSessions: cfg.allowedSessions,

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
  const dashFormat = symbol.replace('/', '-');
  const noSlashFormat = symbol.replace('/', '');

  let p = `backtest/data/${dashFormat}_${timeframe}.json`;
  if (timeframe === '1m') p = `backtest/data/${dashFormat}_1m_combined.json`;

  if (fs.existsSync(path.resolve(process.cwd(), p))) {
    return p;
  }

  // Fallback to old format
  if (timeframe === '1m') {
    return `backtest/data/${noSlashFormat}_1m_combined.json`;
  }
  return `backtest/data/${noSlashFormat}_${timeframe}.json`;
}
