import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadState,
  saveState,
  isCircuitBreakerTripped,
  recordTradeResult,
} from '../risk/circuit_breaker.js';
import type { BotConfig, CircuitBreakerState, TradeResult } from '../utils/types.js';

describe('circuit_breaker', () => {
  const stateFile = path.resolve(process.cwd(), 'circuit_breaker_state.json');

  const mockConfig: BotConfig = {
    apiKey: 'test',
    apiSecret: 'test',
    tradingPairs: ['BTC/USDT'],
    riskPerTradePct: 1,
    maxDailyLossPct: 3, // 3%
    maxConsecutiveLosses: 3, // 3 in a row
    minRRRatio: 2.0,
    tp1RR: 2.0,
    tp2RR: 3.0,
    htfTimeframe: '4h',
    ltfTimeframe: '15m',
    makerFeePct: 0.1,
    takerFeePct: 0.1,
    slippageTicks: 2,
    dryRun: true,
  };

  beforeEach(() => {
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  });

  afterEach(() => {
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  });

  it('initializes with default values', () => {
    const state = loadState(1000);
    expect(state.consecutiveLosses).toBe(0);
    expect(state.dailyPnL).toBe(0);
    expect(state.dailyStartBalance).toBe(1000);
    expect(state.isTripped).toBe(false);
    expect(isCircuitBreakerTripped(state)).toBe(false);
  });

  it('trips when consecutive losses reach limit (3 losses)', () => {
    let state = loadState(1000);

    const lossResult: TradeResult = {
      timestamp: Date.now(),
      symbol: 'BTC/USDT',
      direction: 'LONG',
      entryPrice: 50000,
      exitPrice: 49000,
      quantity: 0.001,
      pnl: -5,
      isWin: false,
      exitReason: 'STOP_LOSS',
    };

    state = recordTradeResult(state, lossResult, mockConfig);
    expect(state.consecutiveLosses).toBe(1);
    expect(state.isTripped).toBe(false);

    state = recordTradeResult(state, lossResult, mockConfig);
    expect(state.consecutiveLosses).toBe(2);
    expect(state.isTripped).toBe(false);

    state = recordTradeResult(state, lossResult, mockConfig);
    expect(state.consecutiveLosses).toBe(3);
    expect(state.isTripped).toBe(true);
    expect(isCircuitBreakerTripped(state)).toBe(true);
    expect(state.tripReason).toContain('3 ardışık stop-loss');
  });

  it('resets consecutive losses on winning trade', () => {
    let state = loadState(1000);

    const lossResult: TradeResult = {
      timestamp: Date.now(),
      symbol: 'BTC/USDT',
      direction: 'LONG',
      entryPrice: 50000,
      exitPrice: 49000,
      quantity: 0.001,
      pnl: -5,
      isWin: false,
      exitReason: 'STOP_LOSS',
    };

    const winResult: TradeResult = {
      timestamp: Date.now(),
      symbol: 'BTC/USDT',
      direction: 'LONG',
      entryPrice: 50000,
      exitPrice: 52000,
      quantity: 0.001,
      pnl: 10,
      isWin: true,
      exitReason: 'TAKE_PROFIT_2',
    };

    state = recordTradeResult(state, lossResult, mockConfig);
    state = recordTradeResult(state, lossResult, mockConfig);
    expect(state.consecutiveLosses).toBe(2);

    state = recordTradeResult(state, winResult, mockConfig);
    expect(state.consecutiveLosses).toBe(0);
    expect(state.isTripped).toBe(false);
  });

  it('trips when daily loss reaches 3%', () => {
    let state = loadState(1000); // 3% of 1000 = 30 USD

    const bigLossResult: TradeResult = {
      timestamp: Date.now(),
      symbol: 'BTC/USDT',
      direction: 'LONG',
      entryPrice: 50000,
      exitPrice: 40000,
      quantity: 0.0035,
      pnl: -35, // -35 USD > 3%
      isWin: false,
      exitReason: 'STOP_LOSS',
    };

    state = recordTradeResult(state, bigLossResult, mockConfig);
    expect(state.isTripped).toBe(true);
    expect(isCircuitBreakerTripped(state)).toBe(true);
    expect(state.tripReason).toContain('Günlük kayıp');
  });

  it('persists and recovers state across restarts', () => {
    const initialState = loadState(5000);
    initialState.consecutiveLosses = 2;
    initialState.dailyPnL = -25;
    saveState(initialState);

    const loadedState = loadState(5000);
    expect(loadedState.consecutiveLosses).toBe(2);
    expect(loadedState.dailyPnL).toBe(-25);
  });
});
