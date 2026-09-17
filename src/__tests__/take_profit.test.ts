import { describe, it, expect } from 'vitest';
import { calculateTakeProfitLevels } from '../risk/take_profit.js';
import type { BotConfig, SymbolConstraints } from '../utils/types.js';

describe('take_profit', () => {
  const mockConfig: BotConfig = {
    apiKey: 'test',
    apiSecret: 'test',
    network: 'demo',
    marketType: 'futures',
    leverage: 1,
    tradingPairs: ['BTC/USDT'],
    riskPerTradePct: 1,
    maxDailyLossPct: 3,
    maxConsecutiveLosses: 3,
    circuitBreakerCooldownHours: 4,
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

  const btcConstraints: SymbolConstraints = {
    symbol: 'BTC/USDT',
    minQty: 0.00001,
    maxQty: 9000,
    stepSize: 0.00001,
    minNotional: 5,
    tickSize: 0.01,
    minPrice: 0.01,
    maxPrice: 1000000,
  };

  it('calculates 50/50 split TP1 @ 1:2 and TP2 @ 1:3 for LONG', () => {
    const entryPrice = 50000;
    const stopLoss = 49000; // SL distance = 1000
    const quantity = 0.1;

    const result = calculateTakeProfitLevels(
      entryPrice,
      stopLoss,
      quantity,
      'LONG',
      mockConfig,
      btcConstraints,
    );

    expect(result.isValid).toBe(true);
    // TP1 = 50000 + 1000 * 2 = 52000
    expect(result.tp1Price).toBe(52000);
    // TP2 = 50000 + 1000 * 3 = 53000
    expect(result.tp2Price).toBe(53000);

    // 50% split of 0.1 = 0.05 each
    expect(result.tp1Quantity).toBe(0.05);
    expect(result.tp2Quantity).toBe(0.05);

    // Effective R:R accounts for fees and slippage (slightly less than gross 2.0 and 3.0)
    expect(result.riskRewardTP1).toBeGreaterThan(1.6);
    expect(result.riskRewardTP1).toBeLessThan(2.0);
    expect(result.riskRewardTP2).toBeGreaterThan(2.5);
    expect(result.riskRewardTP2).toBeLessThan(3.0);
  });

  it('calculates TP1 and TP2 correctly for SHORT', () => {
    const entryPrice = 50000;
    const stopLoss = 51000; // SL distance = 1000
    const quantity = 0.1;

    const result = calculateTakeProfitLevels(
      entryPrice,
      stopLoss,
      quantity,
      'SHORT',
      mockConfig,
      btcConstraints,
    );

    expect(result.isValid).toBe(true);
    // For SHORT: TP1 = 50000 - 1000 * 2 = 48000
    expect(result.tp1Price).toBe(48000);
    // TP2 = 50000 - 1000 * 3 = 47000
    expect(result.tp2Price).toBe(47000);
  });

  it('rejects TP if SL distance <= 0', () => {
    const entryPrice = 50000;
    const invalidStopLoss = 50000; // SL == entry
    const quantity = 0.1;

    const result = calculateTakeProfitLevels(
      entryPrice,
      invalidStopLoss,
      quantity,
      'LONG',
      mockConfig,
      btcConstraints,
    );

    expect(result.isValid).toBe(false);
    expect(result.rejectReason).toContain('Geçersiz SL mesafesi');
  });
});
