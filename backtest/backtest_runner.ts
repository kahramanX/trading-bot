// ══════════════════════════════════════════════════════════════
// backtest_runner.ts — Core Backtesting Simulation Engine v2
// Steps through 15m candles chronologically, feeds sliced data
// to src/ strategy+risk modules, simulates fills with realistic
// fees, slippage, pessimistic execution, and ghost order TTL.
//
// FIXES v2:
//  - LTF slice capped to last ltfLookback (default 200) candles
//    to match live bot window → fixes MSS/FVG detection
//  - HTF slice capped to last htfLookback (default 251) candles
//  - Strategy engine errors are counted and surfaced in summary
//  - Strategy engine logger output suppressed during backtest
//  - Each run saves timestamped output files (no overwrite)
//
// Run: npx tsx backtest/backtest_runner.ts
// ══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import type {
  Candle,
  TradeSignal,
  TradeDirection,
  BotConfig,
  SymbolConstraints,
} from '../src/utils/types.js';
import { runEntryEngine } from '../src/strategy/entry_engine.js';
import { CandleSynthesizer, timeframeToMs } from './candle_builder.js';
import { calculatePositionSize } from '../src/risk/position_sizer.js';
import { calculateTakeProfitLevels } from '../src/risk/take_profit.js';
import {
  backtestConfig,
  buildBotConfig,
  getDefaultConstraints,
  getDataFilePath,
} from './backtest.config.js';
import type { BacktestConfig } from './backtest.config.js';
import { parseBinanceCsvs } from './data_loader.js';

// ─── Terminal Color Codes ───────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
} as const;

// ─── Types ──────────────────────────────────────────────────

type TradeOutcome = 'FULL_TP' | 'TP1+BE' | 'STOP' | 'EXPIRED';

interface PendingOrder {
  id: string;
  symbol: string;
  signal: TradeSignal;
  direction: TradeDirection;
  limitPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  totalQuantity: number;
  tp1Quantity: number;
  tp2Quantity: number;
  placedAtBar: number;
  barsSincePlaced: number;
  placedTimestamp: number;
}

interface ActivePosition {
  id: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  totalQuantity: number;
  tp1Quantity: number;
  tp2Quantity: number;
  tp1Hit: boolean;
  breakEvenApplied: boolean;
  entryTimestamp: number;
  entryBar: number;
  entryFee: number;
  tp1RealizedPnL: number;
  tp1RealizedFees: number;
}

interface ClosedTrade {
  id: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  exitPrice: number;
  entryTimestamp: number;
  exitTimestamp: number;
  quantity: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  outcome: TradeOutcome;
  holdingBars: number;
  balanceAfter: number;
}

interface SimulatedCBState {
  consecutiveLosses: number;
  dailyPnL: number;
  dailyStartBalance: number;
  dailyDate: string;
  isTripped: boolean;
  resumeAtMs: number;
}

interface EquityPoint {
  timestamp: number;
  equity: number;
}

interface Diagnostics {
  barsAnalyzed: number;
  barsSkippedWarmup: number;
  barsSkippedHTFData: number;
  barsSkippedCB: number;
  barsSkippedHasPosition: number;
  signalEngineErrors: number;
  signalEngineErrorMessages: string[];
  signalsGenerated: number;
  signalsRejectedPositionSize: number;
  signalsRejectedTP: number;
  ordersPlaced: number;
  ordersExpired: number;
  ordersFilled: number;
  positionSizeErrors: number;
}

// ─── Utility Functions ──────────────────────────────────────

function fmtUSD(n: number): string {
  const sign = n >= 0 ? '' : '-';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}


function getDayString(ms: number): string {
  return new Date(ms).toISOString().split('T')[0]!;
}

// ─── Run ID for timestamped output ──────────────────────────

function makeRunId(): string {
  return new Date().toISOString()
    .replace('T', '_')
    .replace(/:/g, '-')
    .slice(0, 19); // e.g. 2026-09-18_21-35-00
}

// ─── Stdout Suppressor ───────────────────────────────────────
// Suppresses all stdout during strategy engine calls so that
// winston logger spam doesn't flood the terminal. Backtest's
// own console.log calls happen AFTER the engine returns.

function withSuppressedStdout<T>(fn: () => T): T {
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as NodeJS.WriteStream & { write: (s: unknown) => boolean }).write = () => true;
  try {
    return fn();
  } finally {
    process.stdout.write = origWrite;
  }
}

// ─── Data Loader ────────────────────────────────────────────

async function loadCandles(symbol: string, timeframe: string): Promise<Candle[]> {
  const filePath = path.resolve(process.cwd(), getDataFilePath(symbol, timeframe));
  if (!fs.existsSync(filePath)) {
    console.log(`  [Bypass Logic] Combined JSON not found for ${symbol}. Parsing CSVs...`);
    const candles = await parseBinanceCsvs(symbol);
    fs.writeFileSync(filePath, JSON.stringify(candles), 'utf-8');
    return candles;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const candles = JSON.parse(raw) as Candle[];
  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

// ═══════════════════════════════════════════════════════════════
// BacktestEngine — The Core Simulation
// ═══════════════════════════════════════════════════════════════

class BacktestEngine {
  private readonly cfg: BacktestConfig;
  private readonly botConfig: BotConfig;
  private balance: number;
  private peakBalance: number;
  private maxDrawdown: number;
  private maxDrawdownPct: number;

  private readonly pendingOrders: Map<string, PendingOrder> = new Map();
  private readonly activePositions: Map<string, ActivePosition> = new Map();
  private readonly closedTrades: ClosedTrade[] = [];
  private readonly equityCurve: EquityPoint[] = [];

  private cbState: SimulatedCBState;
  private orderIdCounter: number = 0;

  private readonly diagnostics: Diagnostics = {
    barsAnalyzed: 0,
    barsSkippedWarmup: 0,
    barsSkippedHTFData: 0,
    barsSkippedCB: 0,
    barsSkippedHasPosition: 0,
    signalEngineErrors: 0,
    signalEngineErrorMessages: [],
    signalsGenerated: 0,
    signalsRejectedPositionSize: 0,
    signalsRejectedTP: 0,
    ordersPlaced: 0,
    ordersExpired: 0,
    ordersFilled: 0,
    positionSizeErrors: 0,
  };

  // Per-symbol data
  private readonly data1m: Map<string, Candle[]> = new Map();
  private readonly htfBuffers: Map<string, Candle[]> = new Map();
  private readonly ltfBuffers: Map<string, Candle[]> = new Map();
  private readonly htfSynthesizers: Map<string, CandleSynthesizer> = new Map();
  private readonly ltfSynthesizers: Map<string, CandleSynthesizer> = new Map();

  // Rolling window sizes — mirror what the live bot fetches
  private readonly LTF_LOOKBACK = 200;  // ~50 hours of 15m candles
  private readonly HTF_LOOKBACK = 251;  // ~42 days of 4h candles

  constructor(cfg: BacktestConfig) {
    this.cfg = cfg;
    this.botConfig = buildBotConfig(cfg);
    this.balance = cfg.initialBalance;
    this.peakBalance = cfg.initialBalance;
    this.maxDrawdown = 0;
    this.maxDrawdownPct = 0;



    this.cbState = {
      consecutiveLosses: 0,
      dailyPnL: 0,
      dailyStartBalance: cfg.initialBalance,
      dailyDate: '',
      isTripped: false,
      resumeAtMs: 0,
    };
  }

  // ─── Load Data ────────────────────────────────────────────

  async loadData(): Promise<void> {
    for (const symbol of this.cfg.pairs) {
      const candles1m = await loadCandles(symbol, '1m');
      this.data1m.set(symbol, candles1m);
      this.htfBuffers.set(symbol, []);
      this.ltfBuffers.set(symbol, []);
      this.htfSynthesizers.set(symbol, new CandleSynthesizer(this.cfg.htfTimeframe));
      this.ltfSynthesizers.set(symbol, new CandleSynthesizer(this.cfg.ltfTimeframe));
      console.log(`  📂 ${symbol}: ${candles1m.length} 1m candles loaded`);
    }
  }

  // ─── Generate Order ID ───────────────────────────────────

  private nextOrderId(): string {
    return `BT-${++this.orderIdCounter}`;
  }

  // ─── Slices ────────────────────────────────────────────────
  private sliceHTF(symbol: string): Candle[] {
    return this.htfBuffers.get(symbol)!;
  }

  private sliceLTF(symbol: string): Candle[] {
    return this.ltfBuffers.get(symbol)!;
  }

  // ─── Circuit Breaker (In-Memory) ─────────────────────────

  private checkCircuitBreaker(currentTimestamp: number): boolean {
    // Check day rollover
    const today = getDayString(currentTimestamp);
    if (this.cbState.dailyDate !== today) {
      this.cbState = {
        consecutiveLosses: 0,
        dailyPnL: 0,
        dailyStartBalance: this.balance,
        dailyDate: today,
        isTripped: false,
        resumeAtMs: 0,
      };
    }

    // Check cooldown expiry
    if (this.cbState.isTripped) {
      if (currentTimestamp >= this.cbState.resumeAtMs) {
        this.cbState.isTripped = false;
        this.cbState.consecutiveLosses = 0;
        this.cbState.resumeAtMs = 0;
        this.logSystem(`🔓 Circuit breaker cooldown expired. Trading resumed.`);
      }
    }

    return this.cbState.isTripped;
  }

  private recordTradeInCB(pnl: number, isWin: boolean, currentTimestamp: number): void {
    this.cbState.dailyPnL += pnl;

    if (!isWin) {
      this.cbState.consecutiveLosses++;
    } else {
      this.cbState.consecutiveLosses = 0;
    }

    if (this.cbState.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      this.tripCB(`${this.cfg.maxConsecutiveLosses} consecutive stop-losses`, currentTimestamp);
      return;
    }

    const dailyLossPct = this.cbState.dailyStartBalance > 0
      ? (Math.abs(this.cbState.dailyPnL) / this.cbState.dailyStartBalance) * 100
      : 0;

    if (this.cbState.dailyPnL < 0 && dailyLossPct >= this.cfg.maxDailyLossPct) {
      this.tripCB(`Daily loss ${dailyLossPct.toFixed(2)}% >= ${this.cfg.maxDailyLossPct}%`, currentTimestamp);
    }
  }

  private tripCB(reason: string, currentTimestamp: number): void {
    this.cbState.isTripped = true;
    this.cbState.resumeAtMs = currentTimestamp + (this.cfg.circuitBreakerCooldownHours * 3_600_000);
    this.logSystem(`🚨 CIRCUIT BREAKER TRIPPED: ${reason}. Paused until ${fmtDate(this.cbState.resumeAtMs)}`);
  }

  // ─── Fee Calculation ─────────────────────────────────────

  private calcMakerFee(notionalValue: number): number {
    return notionalValue * this.cfg.makerFeeRate;
  }

  private calcTakerFee(notionalValue: number): number {
    return notionalValue * this.cfg.takerFeeRate;
  }

  private calcSlippage(price: number, quantity: number): number {
    return price * quantity * (this.cfg.slippagePct / 100);
  }

  // ─── Fill Price for SL (with slippage) ────────────────────

  private slFillPrice(slPrice: number, direction: TradeDirection): number {
    const slipMultiplier = this.cfg.slippagePct / 100;
    if (direction === 'LONG') {
      return slPrice * (1 - slipMultiplier);
    } else {
      return slPrice * (1 + slipMultiplier);
    }
  }

  // ─── Process Pending Orders ──────────────────────────────

  private processPendingOrders(symbol: string, candle: Candle, currentTimestamp: number): void {
    const toRemove: string[] = [];

    for (const [id, order] of this.pendingOrders) {
      if (order.symbol !== symbol) continue;

      // Session Killzone Expiry (Session End Sweep)
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: this.cfg.allowedSessions.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const currentHHMM = formatter.format(new Date(currentTimestamp));
      const inLondon = currentHHMM >= this.cfg.allowedSessions.london.start && currentHHMM <= this.cfg.allowedSessions.london.end;
      const inNY = currentHHMM >= this.cfg.allowedSessions.ny.start && currentHHMM <= this.cfg.allowedSessions.ny.end;

      if (!inLondon && !inNY) {
        toRemove.push(id);
        this.diagnostics.ordersExpired++;
        this.logSystem(
          `🚫 [${symbol}] SESSION CANCEL — limit ${order.direction} @ ${fmtUSD(order.limitPrice)} ` +
          `expired due to session end (${currentHHMM})`
        );
        continue;
      }

      // Ghost Order TTL — cancel if expired
      if (order.barsSincePlaced > this.cfg.orderTtlBars) {
        toRemove.push(id);
        this.diagnostics.ordersExpired++;
        this.logSystem(
          `🚫 [${symbol}] GHOST CANCEL — limit ${order.direction} @ ${fmtUSD(order.limitPrice)} ` +
          `expired after ${order.barsSincePlaced} bars`
        );
        continue;
      }

      // Check fill condition — STRICT inequality (no exact-touch fills)
      let filled = false;
      if (order.direction === 'LONG') {
        filled = candle.low < order.limitPrice;
      } else {
        filled = candle.high > order.limitPrice;
      }

      if (filled) {
        const entryNotional = order.limitPrice * order.totalQuantity;
        const entryFee = this.calcMakerFee(entryNotional);

        const position: ActivePosition = {
          id: order.id,
          symbol: order.symbol,
          direction: order.direction,
          entryPrice: order.limitPrice,
          stopLoss: order.stopLoss,
          takeProfit1: order.takeProfit1,
          takeProfit2: order.takeProfit2,
          totalQuantity: order.totalQuantity,
          tp1Quantity: order.tp1Quantity,
          tp2Quantity: order.tp2Quantity,
          tp1Hit: false,
          breakEvenApplied: false,
          entryTimestamp: candle.timestamp,
          entryBar: 0, // unused now, we calculate holding bars by timestamps if needed
          entryFee,
          tp1RealizedPnL: 0,
          tp1RealizedFees: 0,
        };

        this.activePositions.set(id, position);
        toRemove.push(id);
        this.diagnostics.ordersFilled++;

        this.logSystem(
          `📥 [${symbol}] ${order.direction} ENTRY FILLED @ ${fmtUSD(order.limitPrice)} ` +
          `| Qty: ${order.totalQuantity} | Fee: ${fmtUSD(entryFee)} ` +
          `| SL: ${fmtUSD(order.stopLoss)} | TP1: ${fmtUSD(order.takeProfit1)} | TP2: ${fmtUSD(order.takeProfit2)}`
        );
      }
    }

    for (const id of toRemove) {
      this.pendingOrders.delete(id);
    }
  }

  // ─── Process Active Positions ────────────────────────────

  private processActivePositions(symbol: string, candle: Candle, currentTimestamp: number): void {
    const toClose: string[] = [];

    for (const [id, pos] of this.activePositions) {
      if (pos.symbol !== symbol) continue;

      const tp1Reachable = !pos.tp1Hit && this.isTPReachable(candle, pos.takeProfit1, pos.direction);
      const tp2Reachable = pos.tp1Hit && this.isTPReachable(candle, pos.takeProfit2, pos.direction);
      const slReachable = this.isSLReachable(candle, pos.stopLoss, pos.direction);

      // ─── Pessimistic Execution ────────────────────────
      if (this.cfg.pessimisticExecution) {
        if (!pos.tp1Hit && tp1Reachable && slReachable) {
          this.closePositionSL(pos, candle, currentTimestamp);
          toClose.push(id);
          continue;
        }
        if (pos.tp1Hit && tp2Reachable && slReachable) {
          this.closePositionSL(pos, candle, currentTimestamp);
          toClose.push(id);
          continue;
        }
      }

      // SL hit only
      if (slReachable && !tp1Reachable && !tp2Reachable) {
        this.closePositionSL(pos, candle, currentTimestamp);
        toClose.push(id);
        continue;
      }

      // TP1 hit
      if (!pos.tp1Hit && tp1Reachable) {
        const exitNotional = pos.takeProfit1 * pos.tp1Quantity;
        const exitFee = this.calcMakerFee(exitNotional);

        let tp1PnL: number;
        if (pos.direction === 'LONG') {
          tp1PnL = (pos.takeProfit1 - pos.entryPrice) * pos.tp1Quantity;
        } else {
          tp1PnL = (pos.entryPrice - pos.takeProfit1) * pos.tp1Quantity;
        }

        const tp1EntryFee = pos.entryFee * (pos.tp1Quantity / pos.totalQuantity);
        const tp1NetPnL = tp1PnL - tp1EntryFee - exitFee;

        this.balance += tp1NetPnL;
        pos.tp1Hit = true;
        pos.breakEvenApplied = true;
        pos.stopLoss = pos.entryPrice;  // Break-Even
        pos.tp1RealizedPnL = tp1NetPnL;
        pos.tp1RealizedFees = tp1EntryFee + exitFee;

        this.updateDrawdown();

        this.logSystem(
          `🎯 [${symbol}] TP1 HIT @ ${fmtUSD(pos.takeProfit1)} — closed 50% ` +
          `| PnL: ${fmtUSD(tp1NetPnL)} | SL → Break-Even @ ${fmtUSD(pos.entryPrice)}`
        );

        // Check if TP2 also hits on this bar
        if (tp2Reachable && !slReachable) {
          this.closePositionTP2(pos, candle, currentTimestamp);
          toClose.push(id);
        }
        continue;
      }

      // TP2 hit (after TP1)
      if (pos.tp1Hit && tp2Reachable) {
        this.closePositionTP2(pos, candle, currentTimestamp);
        toClose.push(id);
        continue;
      }

      // SL hit (including break-even SL after TP1)
      if (slReachable) {
        this.closePositionSL(pos, candle, currentTimestamp);
        toClose.push(id);
        continue;
      }
    }

    for (const id of toClose) {
      this.activePositions.delete(id);
    }
  }

  // ─── TP/SL Reachability Checks ───────────────────────────

  private isTPReachable(candle: Candle, tpPrice: number, direction: TradeDirection): boolean {
    if (direction === 'LONG') return candle.high > tpPrice;
    else return candle.low < tpPrice;
  }

  private isSLReachable(candle: Candle, slPrice: number, direction: TradeDirection): boolean {
    if (direction === 'LONG') return candle.low <= slPrice;
    else return candle.high >= slPrice;
  }

  // ─── Close Position — Stop Loss ──────────────────────────

  private closePositionSL(pos: ActivePosition, candle: Candle, barIndex: number): void {
    const remainingQty = pos.tp1Hit ? pos.tp2Quantity : pos.totalQuantity;
    const fillPrice = this.slFillPrice(pos.stopLoss, pos.direction);
    const exitNotional = fillPrice * remainingQty;
    const exitFee = this.calcTakerFee(exitNotional);
    const slippage = this.calcSlippage(pos.stopLoss, remainingQty);

    let grossPnl: number;
    if (pos.direction === 'LONG') {
      grossPnl = (fillPrice - pos.entryPrice) * remainingQty;
    } else {
      grossPnl = (pos.entryPrice - fillPrice) * remainingQty;
    }

    const entryFeeShare = pos.entryFee * (remainingQty / pos.totalQuantity);
    const exitLegFee = entryFeeShare + exitFee;
    const exitLegNetPnl = grossPnl - exitLegFee;

    const totalNetPnl = exitLegNetPnl + (pos.tp1Hit ? pos.tp1RealizedPnL : 0);
    const totalFees = exitLegFee + (pos.tp1Hit ? pos.tp1RealizedFees : 0);
    const fullGrossPnl = grossPnl + (pos.tp1Hit ? (pos.tp1RealizedPnL + pos.tp1RealizedFees) : 0);

    this.balance += exitLegNetPnl;
    const holdingBars = 0; // Not perfectly accurate in 1m simulation without tracking ltf bars
    const outcome: TradeOutcome = pos.tp1Hit ? 'TP1+BE' : 'STOP';
    const isWin = totalNetPnl >= 0;

    this.closedTrades.push({
      id: pos.id,
      symbol: pos.symbol,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice: fillPrice,
      entryTimestamp: pos.entryTimestamp,
      exitTimestamp: candle.timestamp,
      quantity: pos.totalQuantity,
      grossPnl: fullGrossPnl,
      fees: totalFees,
      slippage,
      netPnl: totalNetPnl,
      outcome,
      holdingBars,
      balanceAfter: this.balance,
    });

    this.updateDrawdown();
    this.recordTradeInCB(totalNetPnl, isWin, candle.timestamp);

    const pnlPct = (totalNetPnl / Math.max(this.balance, 1)) * 100;
    this.logReceipt(
      candle.timestamp, pos.symbol, pos.direction,
      pos.entryPrice, fillPrice, outcome, totalNetPnl, pnlPct, this.balance
    );
  }

  // ─── Close Position — TP2 (Full Take Profit) ─────────────

  private closePositionTP2(
    pos: ActivePosition,
    candle: Candle,
    barIndex: number,
  ): void {
    const exitNotional = pos.takeProfit2 * pos.tp2Quantity;
    const exitFee = this.calcMakerFee(exitNotional);

    let tp2GrossPnl: number;
    if (pos.direction === 'LONG') {
      tp2GrossPnl = (pos.takeProfit2 - pos.entryPrice) * pos.tp2Quantity;
    } else {
      tp2GrossPnl = (pos.entryPrice - pos.takeProfit2) * pos.tp2Quantity;
    }

    const tp2EntryFee = pos.entryFee * (pos.tp2Quantity / pos.totalQuantity);
    const tp2NetPnl = tp2GrossPnl - tp2EntryFee - exitFee;

    this.balance += tp2NetPnl;
    const holdingBars = 0; // Not perfectly accurate in 1m simulation without tracking ltf bars
    const totalNetPnl = pos.tp1RealizedPnL + tp2NetPnl;

    let fullGrossPnl: number;
    if (pos.direction === 'LONG') {
      fullGrossPnl =
        (pos.takeProfit1 - pos.entryPrice) * pos.tp1Quantity +
        (pos.takeProfit2 - pos.entryPrice) * pos.tp2Quantity;
    } else {
      fullGrossPnl =
        (pos.entryPrice - pos.takeProfit1) * pos.tp1Quantity +
        (pos.entryPrice - pos.takeProfit2) * pos.tp2Quantity;
    }

    const totalFees = pos.entryFee +
      this.calcMakerFee(pos.takeProfit1 * pos.tp1Quantity) + exitFee;

    this.closedTrades.push({
      id: pos.id,
      symbol: pos.symbol,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice: pos.takeProfit2,
      entryTimestamp: pos.entryTimestamp,
      exitTimestamp: candle.timestamp,
      quantity: pos.totalQuantity,
      grossPnl: fullGrossPnl,
      fees: totalFees,
      slippage: 0,
      netPnl: totalNetPnl,
      outcome: 'FULL_TP',
      holdingBars,
      balanceAfter: this.balance,
    });

    this.updateDrawdown();
    this.recordTradeInCB(totalNetPnl, true, candle.timestamp);

    const pnlPct = (totalNetPnl / Math.max(this.balance, 1)) * 100;
    this.logReceipt(
      candle.timestamp, pos.symbol, pos.direction,
      pos.entryPrice, pos.takeProfit2, 'FULL_TP', totalNetPnl, pnlPct, this.balance
    );
  }

  // ─── Drawdown Tracking ───────────────────────────────────

  private updateDrawdown(): void {
    if (this.balance > this.peakBalance) this.peakBalance = this.balance;
    const drawdown = this.peakBalance - this.balance;
    const drawdownPct = this.peakBalance > 0 ? (drawdown / this.peakBalance) * 100 : 0;
    if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown;
    if (drawdownPct > this.maxDrawdownPct) this.maxDrawdownPct = drawdownPct;
  }

  // ─── Check Symbol Has Active Position or Pending Order ───

  private hasActiveOrPending(symbol: string): boolean {
    for (const [, pos] of this.activePositions) {
      if (pos.symbol === symbol) return true;
    }
    for (const [, ord] of this.pendingOrders) {
      if (ord.symbol === symbol) return true;
    }
    return false;
  }

  // ─── Logging ─────────────────────────────────────────────

  private logSystem(msg: string): void {
    console.log(`${C.gray}[BACKTEST]${C.reset} ${msg}`);
  }

  private logReceipt(
    timestamp: number, symbol: string, direction: TradeDirection,
    entry: number, exit: number, outcome: TradeOutcome,
    netPnl: number, pnlPct: number, balance: number,
  ): void {
    const dirColor = direction === 'LONG' ? C.green : C.red;
    const pnlColor = netPnl >= 0 ? C.green : C.red;
    const outcomeColor = outcome === 'STOP' ? C.red : C.green;
    const pnlSign = netPnl >= 0 ? '+' : '';

    const sep = `${C.dim}─`.repeat(72) + C.reset;
    console.log(sep);
    console.log(
      `${C.gray}[${fmtDate(timestamp)}]${C.reset} ` +
      `${C.cyan}${C.bright}[${symbol}]${C.reset} ` +
      `${dirColor}${C.bright}${direction}${C.reset} ` +
      `${C.dim}|${C.reset} ` +
      `Entry: ${C.bright}${fmtUSD(entry)}${C.reset} ` +
      `${C.dim}|${C.reset} ` +
      `Exit: ${C.bright}${fmtUSD(exit)}${C.reset} ` +
      `${C.dim}|${C.reset} ` +
      `Outcome: ${outcomeColor}${C.bright}${outcome}${C.reset} ` +
      `${C.dim}|${C.reset} ` +
      `Net PnL: ${pnlColor}${C.bright}${pnlSign}${fmtUSD(netPnl)} (${fmtPct(pnlPct)})${C.reset} ` +
      `${C.dim}|${C.reset} ` +
      `Balance: ${C.bright}${fmtUSD(balance)}${C.reset}`
    );
    console.log(sep);
  }

  // ═══════════════════════════════════════════════════════════
  // MAIN SIMULATION LOOP
  // ═══════════════════════════════════════════════════════════

  async run(): Promise<void> {
    this.printInitBanner();
    await this.loadData();

    // Build unified timeline from all 1m timestamps
    const allTimestamps = new Set<number>();
    for (const symbol of this.cfg.pairs) {
      const candles = this.data1m.get(symbol)!;
      for (const candle of candles) allTimestamps.add(candle.timestamp);
    }
    const sortedTimestamps = [...allTimestamps].sort((a, b) => a - b);

    // Warmup cutoff
    const ltfMs = timeframeToMs(this.cfg.ltfTimeframe);
    const htfMs = timeframeToMs(this.cfg.htfTimeframe);
    const warmupMs = Math.max(this.cfg.warmupCandles * htfMs, this.cfg.warmupCandles * ltfMs);
    const firstTimestamp = sortedTimestamps[0] || 0;
    const warmupCutoff = firstTimestamp + warmupMs;

    const totalBars = sortedTimestamps.length;
    let processedBars = 0;
    let lastProgressPct = 0;

    console.log(`\n  📊 Simulation: ${totalBars.toLocaleString()} 1m ticks | LTF window: last ${this.LTF_LOOKBACK} | HTF window: last ${this.HTF_LOOKBACK}\n`);

    for (let globalIdx = 0; globalIdx < sortedTimestamps.length; globalIdx++) {
      const currentTimestamp = sortedTimestamps[globalIdx]!;

      processedBars++;
      const progressPct = Math.floor((processedBars / totalBars) * 100);
      if (progressPct >= lastProgressPct + 5) {
        lastProgressPct = progressPct;
        const D = this.diagnostics;
        process.stdout.write(
          `  ⏳ ${progressPct}% | Signals: ${D.signalsGenerated} | Orders: ${D.ordersPlaced} | Filled: ${D.ordersFilled} | Errors: ${D.signalEngineErrors} | Balance: ${fmtUSD(this.balance)}\r`
        );
      }

      this.equityCurve.push({ timestamp: currentTimestamp, equity: this.balance });

      for (const symbol of this.cfg.pairs) {
        const all1m = this.data1m.get(symbol)!;
        const barIndex = this.findBarIndex(all1m, currentTimestamp);
        if (barIndex < 0) continue;

        const currentCandle = all1m[barIndex]!;

        // ─── Step 1: Process pending limit orders on 1m tick ─────────
        this.processPendingOrders(symbol, currentCandle, currentTimestamp);

        // ─── Step 2: Process active positions on 1m tick ─────────────
        this.processActivePositions(symbol, currentCandle, currentTimestamp);

        // ─── Step 3: Feed synthesizers ─────────────────────────────
        const htfSyn = this.htfSynthesizers.get(symbol)!;
        const ltfSyn = this.ltfSynthesizers.get(symbol)!;

        const closedHTF = htfSyn.feed(currentCandle);
        const closedLTF = ltfSyn.feed(currentCandle);

        const htfBuffer = this.htfBuffers.get(symbol)!;
        const ltfBuffer = this.ltfBuffers.get(symbol)!;

        if (closedHTF) {
          htfBuffer.push(closedHTF);
          if (htfBuffer.length > this.HTF_LOOKBACK) htfBuffer.shift();
        }

        if (closedLTF) {
          ltfBuffer.push(closedLTF);
          if (ltfBuffer.length > this.LTF_LOOKBACK) ltfBuffer.shift();

          // Increment TTL for pending orders
          for (const [id, order] of this.pendingOrders) {
            if (order.symbol === symbol) order.barsSincePlaced++;
          }
        }

        // Only run strategy engine if an LTF candle just closed
        if (!closedLTF) continue;

        // ─── Step 4: Skip warmup period ───────────────────
        if (currentTimestamp < warmupCutoff) {
          this.diagnostics.barsSkippedWarmup++;
          continue;
        }

        // ─── Step 5: Circuit breaker check ────────────────
        if (this.checkCircuitBreaker(currentTimestamp)) {
          this.diagnostics.barsSkippedCB++;
          continue;
        }

        // ─── Step 6: Skip if has active position/order ────
        if (this.hasActiveOrPending(symbol)) {
          this.diagnostics.barsSkippedHasPosition++;
          continue;
        }

        // ─── Step 7: Slice data (already capped) ─
        const htfSlice = this.sliceHTF(symbol);
        const ltfSlice = this.sliceLTF(symbol);

        // Minimum data requirements (same as live bot checks)
        if (htfSlice.length < 20) {
          this.diagnostics.barsSkippedHTFData++;
          continue;
        }
        if (ltfSlice.length < 50) continue;

        this.diagnostics.barsAnalyzed++;

        // ─── Step 8: Run strategy engine ──────────────────
        const constraints = getDefaultConstraints(symbol);
        let engineResult: ReturnType<typeof runEntryEngine> | undefined;

        try {
          engineResult = withSuppressedStdout(() =>
            runEntryEngine(symbol, htfSlice, ltfSlice, this.botConfig, constraints)
          );
        } catch (err: unknown) {
          this.diagnostics.signalEngineErrors++;
          const msg = err instanceof Error ? err.message : String(err);
          if (this.diagnostics.signalEngineErrorMessages.length < 5) {
            const shortMsg = `[${symbol} @ ${fmtDate(currentTimestamp)}] ${msg.slice(0, 120)}`;
            if (!this.diagnostics.signalEngineErrorMessages.includes(shortMsg)) {
              this.diagnostics.signalEngineErrorMessages.push(shortMsg);
            }
          }
          continue;
        }

        if (!engineResult || !engineResult.signal) continue;

        this.diagnostics.signalsGenerated++;
        const signal = engineResult.signal;

        // ─── Step 9: Position sizing ──────────────────────
        let posSize: ReturnType<typeof calculatePositionSize> | undefined;
        try {
          posSize = withSuppressedStdout(() =>
            calculatePositionSize(
              this.balance,
              signal.entryPrice,
              signal.stopLoss,
              signal.direction,
              this.botConfig,
              constraints,
            )
          );
        } catch (err: unknown) {
          this.diagnostics.positionSizeErrors++;
          continue;
        }

        if (!posSize || !posSize.isValid) {
          this.diagnostics.signalsRejectedPositionSize++;
          continue;
        }

        // ─── Step 10: TP levels ────────────────────────────
        let tpLevels: ReturnType<typeof calculateTakeProfitLevels> | undefined;
        try {
          tpLevels = withSuppressedStdout(() =>
            calculateTakeProfitLevels(
              signal.entryPrice,
              signal.stopLoss,
              posSize!.quantity,
              signal.direction,
              this.botConfig,
              constraints,
            )
          );
        } catch {
          continue;
        }

        if (!tpLevels || !tpLevels.isValid) {
          this.diagnostics.signalsRejectedTP++;
          continue;
        }

        // ─── Step 11: Place pending limit order ───────────
        const orderId = this.nextOrderId();
        this.pendingOrders.set(orderId, {
          id: orderId,
          symbol,
          signal,
          direction: signal.direction,
          limitPrice: signal.entryPrice,
          stopLoss: signal.stopLoss,
          takeProfit1: tpLevels.tp1Price,
          takeProfit2: tpLevels.tp2Price,
          totalQuantity: posSize.quantity,
          tp1Quantity: tpLevels.tp1Quantity,
          tp2Quantity: tpLevels.tp2Quantity,
          placedAtBar: 0,
          barsSincePlaced: 0,
          placedTimestamp: currentTimestamp,
        });

        this.diagnostics.ordersPlaced++;

        this.logSystem(
          `📝 [${symbol}] ${signal.direction} LIMIT @ ${fmtUSD(signal.entryPrice)} ` +
          `| SL: ${fmtUSD(signal.stopLoss)} | TP1: ${fmtUSD(tpLevels.tp1Price)} | TP2: ${fmtUSD(tpLevels.tp2Price)} ` +
          `| Qty: ${posSize.quantity} | TTL: ${this.cfg.orderTtlBars} bars`
        );
      }
    }

    process.stdout.write('\n');

    // Cancel remaining pending orders
    for (const [id, order] of this.pendingOrders) {
      this.logSystem(`🚫 [${order.symbol}] End-of-sim: cancelling ${id}`);
      this.diagnostics.ordersExpired++;
    }
    this.pendingOrders.clear();

    // Force-close remaining active positions at last 1m candle close price
    for (const [id, pos] of this.activePositions) {
      const all1m = this.data1m.get(pos.symbol)!;
      const lastCandle = all1m[all1m.length - 1]!;
      const remainingQty = pos.tp1Hit ? pos.tp2Quantity : pos.totalQuantity;

      let grossPnl: number;
      if (pos.direction === 'LONG') {
        grossPnl = (lastCandle.close - pos.entryPrice) * remainingQty;
      } else {
        grossPnl = (pos.entryPrice - lastCandle.close) * remainingQty;
      }

      const entryFeeShare = pos.entryFee * (remainingQty / pos.totalQuantity);
      const exitFee = this.calcTakerFee(lastCandle.close * remainingQty);
      const netPnl = grossPnl - entryFeeShare - exitFee;
      this.balance += netPnl;
      this.updateDrawdown();

      this.closedTrades.push({
        id: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: lastCandle.close,
        entryTimestamp: pos.entryTimestamp,
        exitTimestamp: lastCandle.timestamp,
        quantity: remainingQty,
        grossPnl,
        fees: entryFeeShare + exitFee,
        slippage: 0,
        netPnl,
        outcome: pos.tp1Hit ? 'TP1+BE' : 'STOP',
        holdingBars: 0,
        balanceAfter: this.balance,
      });

      this.logSystem(`🔚 [${pos.symbol}] Force-closed ${id} @ ${fmtUSD(lastCandle.close)} (end-of-sim)`);
    }
    this.activePositions.clear();

    this.printFinalSummary();
    this.saveResults();
  }

  // ─── Binary Search for Bar Index ─────────────────────────

  private findBarIndex(candles: Candle[], timestamp: number): number {
    let low = 0, high = candles.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (candles[mid]!.timestamp === timestamp) return mid;
      if (candles[mid]!.timestamp < timestamp) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  // ─── Init Banner ─────────────────────────────────────────

  private printInitBanner(): void {
    console.log('');
    console.log(`${C.bright}${C.cyan}╔══════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bright}${C.cyan}║     🧪 SMC BACKTEST ENGINE v2 — Simulation Mode         ║${C.reset}`);
    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Balance:  ${C.bright}${fmtUSD(this.cfg.initialBalance)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Risk:     ${C.bright}${this.cfg.riskPerTradePct}%${C.reset} per trade`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Pairs:    ${C.bright}${this.cfg.pairs.join(', ')}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Period:   ${C.bright}Dynamic (from CSVs)${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  HTF/LTF:  ${C.bright}${this.cfg.htfTimeframe} / ${this.cfg.ltfTimeframe}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Fees:     Maker ${C.bright}${(this.cfg.makerFeeRate * 100).toFixed(2)}%${C.reset} / Taker ${C.bright}${(this.cfg.takerFeeRate * 100).toFixed(2)}%${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Slippage: ${C.bright}${this.cfg.slippagePct}%${C.reset} on SL executions`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  TTL:      ${C.bright}${this.cfg.orderTtlBars} bars${C.reset} (ghost order cancel)`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Pessim.:  ${C.bright}${this.cfg.pessimisticExecution ? 'ON ⚠️' : 'OFF'}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Warmup:   ${C.bright}${this.cfg.warmupCandles} candles${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  LTF win:  ${C.bright}last ${this.LTF_LOOKBACK} candles${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  HTF win:  ${C.bright}last ${this.HTF_LOOKBACK} candles${C.reset}`);
    console.log(`${C.bright}${C.cyan}╚══════════════════════════════════════════════════════════╝${C.reset}`);
    console.log('');
  }

  // ─── Final Summary ───────────────────────────────────────

  private printFinalSummary(): void {
    const stats = this.computeStats();
    const D = this.diagnostics;

    console.log('');
    console.log(`${C.bright}${C.cyan}╔══════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bright}${C.cyan}║                   📊 BACKTEST RESULTS                   ║${C.reset}`);
    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);

    const retColor = stats.netReturnPct >= 0 ? C.green : C.red;
    console.log(`${C.bright}${C.cyan}║${C.reset}  Initial Balance:    ${C.bright}${fmtUSD(this.cfg.initialBalance)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Final Balance:      ${retColor}${C.bright}${fmtUSD(stats.finalBalance)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Net Return:         ${retColor}${C.bright}${fmtPct(stats.netReturnPct)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Total Trades:       ${C.bright}${stats.totalTrades}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Wins / Losses:      ${C.green}${C.bright}${stats.wins}${C.reset} / ${C.red}${C.bright}${stats.losses}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Win Rate:           ${C.bright}${stats.winRate.toFixed(1)}%${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Profit Factor:      ${C.bright}${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Max Drawdown:       ${C.red}${C.bright}${fmtUSD(stats.maxDrawdown)} (${stats.maxDrawdownPct.toFixed(2)}%)${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Avg Win:            ${C.green}${C.bright}${fmtUSD(stats.avgWin)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Avg Loss:           ${C.red}${C.bright}${fmtUSD(stats.avgLoss)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Best Trade:         ${C.green}${C.bright}${fmtUSD(stats.bestTrade)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Worst Trade:        ${C.red}${C.bright}${fmtUSD(stats.worstTrade)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Avg Holding (bars): ${C.bright}${stats.avgHoldingBars.toFixed(1)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Full TP:            ${C.bright}${stats.fullTPCount}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  TP1 + BE:           ${C.bright}${stats.tp1BECount}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Stop Loss:          ${C.bright}${stats.stopCount}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Total Fees Paid:    ${C.yellow}${C.bright}${fmtUSD(stats.totalFees)}${C.reset}`);
    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    
    // YEARLY BREAKDOWN
    console.log(`${C.bright}${C.cyan}║  ${C.yellow}${C.bright}YEARLY BREAKDOWN${C.reset}`);
    for (const y of stats.yearlyBreakdown) {
      const pnlColor = y.netPnl >= 0 ? C.green : C.red;
      const pnlStr = fmtUSD(y.netPnl).padStart(9);
      const winRate = y.trades > 0 ? ((y.wins / y.trades) * 100).toFixed(1) + '%' : '0%';
      console.log(`${C.bright}${C.cyan}║${C.reset}  ${y.period}    | ${y.symbol.padEnd(8)} | PnL: ${pnlColor}${pnlStr}${C.reset} | Trades: ${String(y.trades).padEnd(3)} (WR: ${winRate})`);
    }
    
    // MONTHLY BREAKDOWN
    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    console.log(`${C.bright}${C.cyan}║  ${C.yellow}${C.bright}MONTHLY BREAKDOWN${C.reset}`);
    for (const m of stats.monthlyBreakdown) {
      const pnlColor = m.netPnl >= 0 ? C.green : C.red;
      const pnlStr = fmtUSD(m.netPnl).padStart(9);
      const winRate = m.trades > 0 ? ((m.wins / m.trades) * 100).toFixed(1) + '%' : '0%';
      console.log(`${C.bright}${C.cyan}║${C.reset}  ${m.period} | ${m.symbol.padEnd(8)} | PnL: ${pnlColor}${pnlStr}${C.reset} | Trades: ${String(m.trades).padEnd(3)} (WR: ${winRate})`);
    }

    // WEEKLY BREAKDOWN
    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    console.log(`${C.bright}${C.cyan}║  ${C.yellow}${C.bright}WEEKLY BREAKDOWN${C.reset}`);
    for (const w of stats.weeklyBreakdown) {
      const pnlColor = w.netPnl >= 0 ? C.green : C.red;
      const pnlStr = fmtUSD(w.netPnl).padStart(9);
      const winRate = w.trades > 0 ? ((w.wins / w.trades) * 100).toFixed(1) + '%' : '0%';
      console.log(`${C.bright}${C.cyan}║${C.reset}  ${w.period} | ${w.symbol.padEnd(8)} | PnL: ${pnlColor}${pnlStr}${C.reset} | Trades: ${String(w.trades).padEnd(3)} (WR: ${winRate})`);
    }

    console.log(`${C.bright}${C.cyan}╠══════════════════════════════════════════════════════════╣${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  ${C.yellow}${C.bright}DIAGNOSTICS${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Bars analyzed:      ${C.bright}${D.barsAnalyzed.toLocaleString()}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Skipped (warmup):   ${C.dim}${D.barsSkippedWarmup.toLocaleString()}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Skipped (HTF data): ${C.dim}${D.barsSkippedHTFData.toLocaleString()}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Skipped (CB):       ${C.dim}${D.barsSkippedCB.toLocaleString()}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Skipped (position): ${C.dim}${D.barsSkippedHasPosition.toLocaleString()}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Signals generated:  ${C.bright}${D.signalsGenerated}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Orders placed:      ${C.bright}${D.ordersPlaced}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Orders filled:      ${C.bright}${D.ordersFilled}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Orders expired:     ${C.bright}${D.ordersExpired}${C.reset}`);
    console.log(`${C.bright}${C.cyan}║${C.reset}  Engine errors:      ${D.signalEngineErrors > 0 ? C.red : C.dim}${D.signalEngineErrors}${C.reset}`);
    if (D.signalEngineErrors > 0) {
      console.log(`${C.bright}${C.cyan}║${C.reset}  ${C.red}Rejected (size):     ${D.signalsRejectedPositionSize}${C.reset}`);
      console.log(`${C.bright}${C.cyan}║${C.reset}  ${C.red}Rejected (TP/RR):    ${D.signalsRejectedTP}${C.reset}`);
      for (const msg of D.signalEngineErrorMessages) {
        console.log(`${C.bright}${C.cyan}║${C.reset}  ${C.red}  ⚠ ${msg}${C.reset}`);
      }
    }
    console.log(`${C.bright}${C.cyan}╚══════════════════════════════════════════════════════════╝${C.reset}`);
    console.log('');
  }

  // ─── Statistics ──────────────────────────────────────────

  private computeStats() {
    const trades = this.closedTrades;
    const totalTrades = trades.length;
    const wins = trades.filter(t => t.netPnl > 0);
    const losses = trades.filter(t => t.netPnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

    const getISOWeek = (date: Date) => {
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const dayNum = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
      return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    };

    const yearlyMap = new Map<string, any>();
    const monthlyMap = new Map<string, any>();
    const weeklyMap = new Map<string, any>();

    const updateMap = (map: Map<string, any>, period: string, t: any) => {
      const key = `${t.symbol}|${period}`;
      if (!map.has(key)) map.set(key, { trades: 0, netPnl: 0, wins: 0, losses: 0 });
      const stat = map.get(key)!;
      stat.trades++;
      stat.netPnl += t.netPnl;
      if (t.netPnl > 0) stat.wins++;
      else stat.losses++;
    };

    for (const t of trades) {
      const date = new Date(t.exitTimestamp);
      const year = String(date.getUTCFullYear());
      const month = `${year}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      const week = getISOWeek(date);

      updateMap(yearlyMap, year, t);
      updateMap(monthlyMap, month, t);
      updateMap(weeklyMap, week, t);
    }

    const toArray = (map: Map<string, any>) => Array.from(map.entries()).map(([key, stat]) => {
      const [symbol, period] = key.split('|');
      return { symbol: symbol as string, period: period as string, ...stat };
    }).sort((a, b) => a.period.localeCompare(b.period) || a.symbol.localeCompare(b.symbol));

    const yearlyBreakdown = toArray(yearlyMap);
    const monthlyBreakdown = toArray(monthlyMap);
    const weeklyBreakdown = toArray(weeklyMap);

    return {
      finalBalance: this.balance,
      netReturnPct: ((this.balance - this.cfg.initialBalance) / this.cfg.initialBalance) * 100,
      totalTrades,
      wins: wins.length,
      losses: losses.length,
      winRate: totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPct: this.maxDrawdownPct,
      avgWin: wins.length > 0 ? grossWin / wins.length : 0,
      avgLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
      bestTrade: trades.length > 0 ? Math.max(...trades.map(t => t.netPnl)) : 0,
      worstTrade: trades.length > 0 ? Math.min(...trades.map(t => t.netPnl)) : 0,
      avgHoldingBars: totalTrades > 0 ? trades.reduce((s, t) => s + t.holdingBars, 0) / totalTrades : 0,
      fullTPCount: trades.filter(t => t.outcome === 'FULL_TP').length,
      tp1BECount: trades.filter(t => t.outcome === 'TP1+BE').length,
      stopCount: trades.filter(t => t.outcome === 'STOP').length,
      totalFees: trades.reduce((s, t) => s + t.fees, 0),
      yearlyBreakdown,
      monthlyBreakdown,
      weeklyBreakdown,
    };
  }

  // ─── Save Results (timestamped — never overwrites) ───────

  private saveResults(): void {
    const runId = makeRunId();
    const resultsDir = path.resolve(process.cwd(), 'backtest/results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    const tradesPath = path.join(resultsDir, `trades_${runId}.json`);
    const summaryPath = path.join(resultsDir, `summary_${runId}.md`);

    // trades.json
    fs.writeFileSync(tradesPath, JSON.stringify(this.closedTrades, null, 2), 'utf-8');
    console.log(`  💾 Trade log → ${path.basename(tradesPath)}`);

    // summary.md
    const stats = this.computeStats();
    fs.writeFileSync(summaryPath, this.generateMarkdown(stats, runId), 'utf-8');
    console.log(`  📝 Summary   → ${path.basename(summaryPath)}`);
    console.log('');
  }

  // ─── Markdown Report ─────────────────────────────────────

  private generateMarkdown(stats: ReturnType<typeof this.computeStats>, runId: string): string {
    const D = this.diagnostics;
    let md = `# SMC Backtest Report — ${runId}\n\n`;

    md += `## Configuration\n\n`;
    md += `| Parameter | Value |\n|-----------|-------|\n`;
    md += `| Initial Balance | ${fmtUSD(this.cfg.initialBalance)} |\n`;
    md += `| Risk Per Trade | ${this.cfg.riskPerTradePct}% |\n`;
    md += `| Max Daily Loss | ${this.cfg.maxDailyLossPct}% |\n`;
    md += `| Max Cons. Losses | ${this.cfg.maxConsecutiveLosses} |\n`;
    md += `| CB Cooldown | ${this.cfg.circuitBreakerCooldownHours} hours |\n`;
    md += `| TP1 R:R | ${this.cfg.tp1RR} |\n`;
    md += `| TP2 R:R | ${this.cfg.tp2RR} |\n`;
    md += `| Min R:R Ratio | ${this.cfg.minRRRatio} |\n`;
    md += `| Pairs | ${this.cfg.pairs.join(', ')} |\n`;
    md += `| HTF / LTF | ${this.cfg.htfTimeframe} / ${this.cfg.ltfTimeframe} |\n`;
    md += `| Maker Fee | ${(this.cfg.makerFeeRate * 100).toFixed(2)}% |\n`;
    md += `| Taker Fee | ${(this.cfg.takerFeeRate * 100).toFixed(2)}% |\n`;
    md += `| Slippage | ${this.cfg.slippagePct}% |\n`;
    md += `| Order TTL | ${this.cfg.orderTtlBars} bars |\n`;
    md += `| Pessimistic Exec. | ${this.cfg.pessimisticExecution ? 'Yes' : 'No'} |\n`;
    md += `| Warmup Candles | ${this.cfg.warmupCandles} |\n`;
    md += `| ADX Filter | Period: ${this.cfg.adxPeriod} \\| Threshold: ${this.cfg.adxThreshold} |\n`;
    md += `| Allowed Sessions | TZ: ${this.cfg.allowedSessions.timezone} \\| London: ${this.cfg.allowedSessions.london.start}-${this.cfg.allowedSessions.london.end} \\| NY: ${this.cfg.allowedSessions.ny.start}-${this.cfg.allowedSessions.ny.end} |\n\n`;

    md += `## Performance\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| **Final Balance** | **${fmtUSD(stats.finalBalance)}** |\n`;
    md += `| **Net Return** | **${fmtPct(stats.netReturnPct)}** |\n`;
    md += `| Total Trades | ${stats.totalTrades} |\n`;
    md += `| Wins / Losses | ${stats.wins} / ${stats.losses} |\n`;
    md += `| **Win Rate** | **${stats.winRate.toFixed(1)}%** |\n`;
    md += `| **Profit Factor** | **${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}** |\n`;
    md += `| **Max Drawdown** | **${fmtUSD(stats.maxDrawdown)} (${stats.maxDrawdownPct.toFixed(2)}%)** |\n`;
    md += `| Avg Win | ${fmtUSD(stats.avgWin)} |\n`;
    md += `| Avg Loss | ${fmtUSD(stats.avgLoss)} |\n`;
    md += `| Best Trade | ${fmtUSD(stats.bestTrade)} |\n`;
    md += `| Worst Trade | ${fmtUSD(stats.worstTrade)} |\n`;
    md += `| Total Fees | ${fmtUSD(stats.totalFees)} |\n\n`;

    const renderTable = (data: any[], title: string, periodHeader: string) => {
      let tbl = `## ${title}\n\n`;
      tbl += `| ${periodHeader} | Pair | PnL | Trades | Wins | Losses | Win Rate |\n`;
      tbl += `|---------|------|-----|--------|------|--------|----------|\n`;
      for (const row of data) {
        const winRate = row.trades > 0 ? ((row.wins / row.trades) * 100).toFixed(1) + '%' : '0%';
        tbl += `| ${row.period} | ${row.symbol} | **${fmtUSD(row.netPnl)}** | ${row.trades} | ${row.wins} | ${row.losses} | ${winRate} |\n`;
      }
      tbl += `\n`;
      return tbl;
    };

    md += renderTable(stats.yearlyBreakdown, 'Yearly Breakdown', 'Year');
    md += renderTable(stats.monthlyBreakdown, 'Monthly Breakdown', 'Month');
    md += renderTable(stats.weeklyBreakdown, 'Weekly Breakdown', 'Week');

    md += `## Diagnostics\n\n`;
    md += `| Metric | Count |\n|--------|-------|\n`;
    md += `| Bars analyzed | ${D.barsAnalyzed.toLocaleString()} |\n`;
    md += `| Signals generated | ${D.signalsGenerated} |\n`;
    md += `| Orders placed | ${D.ordersPlaced} |\n`;
    md += `| Orders filled | ${D.ordersFilled} |\n`;
    md += `| Orders expired | ${D.ordersExpired} |\n`;
    md += `| Engine errors | ${D.signalEngineErrors} |\n`;
    md += `| Rejected (pos size) | ${D.signalsRejectedPositionSize} |\n`;
    md += `| Rejected (TP/RR) | ${D.signalsRejectedTP} |\n\n`;

    if (D.signalEngineErrorMessages.length > 0) {
      md += `### Engine Error Samples\n\n`;
      for (const msg of D.signalEngineErrorMessages) {
        md += `- \`${msg}\`\n`;
      }
      md += '\n';
    }

    // Per-symbol breakdown
    md += `## Per-Symbol Breakdown\n\n`;
    md += `| Symbol | Trades | Win Rate | Net PnL | PF |\n|--------|--------|----------|---------|----|\n`;
    for (const symbol of this.cfg.pairs) {
      const symTrades = this.closedTrades.filter(t => t.symbol === symbol);
      const symWins = symTrades.filter(t => t.netPnl > 0);
      const symLosses = symTrades.filter(t => t.netPnl <= 0);
      const symNetPnl = symTrades.reduce((s, t) => s + t.netPnl, 0);
      const symGrossWin = symWins.reduce((s, t) => s + t.netPnl, 0);
      const symGrossLoss = Math.abs(symLosses.reduce((s, t) => s + t.netPnl, 0));
      const symWinRate = symTrades.length > 0 ? (symWins.length / symTrades.length) * 100 : 0;
      const symPF = symGrossLoss > 0 ? symGrossWin / symGrossLoss : (symGrossWin > 0 ? Infinity : 0);
      md += `| ${symbol} | ${symTrades.length} | ${symWinRate.toFixed(1)}% | ${fmtUSD(symNetPnl)} | ${symPF === Infinity ? '∞' : symPF.toFixed(2)} |\n`;
    }

    md += `\n---\n\n> Pessimistic execution: ${this.cfg.pessimisticExecution ? '**enabled**' : 'disabled'}. `;
    md += `Strict fills (low/high must cross level). Maker fees on limit fills, taker+slippage on SL market fills.\n`;

    return md;
  }
}

// ═══════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  try {
    const engine = new BacktestEngine(backtestConfig);
    await engine.run();
  } catch (err) {
    console.error(`\n${C.red}❌ Fatal error: ${err instanceof Error ? err.message : String(err)}${C.reset}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
