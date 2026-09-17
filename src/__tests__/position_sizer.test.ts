import { describe, it, expect } from 'vitest';
import { calculatePositionSize } from '../risk/position_sizer.js';
import type { BotConfig, SymbolConstraints } from '../utils/types.js';

describe('position_sizer', () => {
  const mockConfig: BotConfig = {
    apiKey: 'test',
    apiSecret: 'test',
    tradingPairs: ['BTC/USDT'],
    riskPerTradePct: 1, // 1% risk
    maxDailyLossPct: 3,
    maxConsecutiveLosses: 3,
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

  it('calculates position size correctly with cost deduction', () => {
    const balance = 10000; // 1% risk = 100 USD
    const entryPrice = 50000;
    const stopLoss = 49000; // SL distance = 1000 USD

    const result = calculatePositionSize(
      balance,
      entryPrice,
      stopLoss,
      'LONG',
      mockConfig,
      btcConstraints,
    );

    expect(result.isValid).toBe(true);
    expect(result.riskAmount).toBe(100);
    expect(result.stopDistance).toBe(1000);
    // Quantity should be approximately (100 - costs) / 1000 ≈ 0.098 BTC
    expect(result.quantity).toBeGreaterThan(0.08);
    expect(result.quantity).toBeLessThan(0.10);
    expect(result.positionValue).toBeGreaterThan(5);
  });

  it('rejects position when position value is below $5 (graceful rejection)', () => {
    const balance = 100; // 1% risk = 1.00 USD
    const entryPrice = 2;
    const stopLoss = 1; // SL distance = 1 USD -> quantity ≈ 1 unit -> positionValue ≈ 2 USD < $5

    const result = calculatePositionSize(
      balance,
      entryPrice,
      stopLoss,
      'LONG',
      mockConfig,
      btcConstraints,
    );

    expect(result.isValid).toBe(false);
    expect(result.rejectReason).toContain('$5');
  });

  it('rejects position when stop distance is invalid (SL on wrong side)', () => {
    const balance = 5000;
    const entryPrice = 50000;
    const invalidStopLoss = 51000; // SL is above entry for a LONG!

    const result = calculatePositionSize(
      balance,
      entryPrice,
      invalidStopLoss,
      'LONG',
      mockConfig,
      btcConstraints,
    );

    expect(result.isValid).toBe(false);
    expect(result.rejectReason).toContain('Geçersiz SL mesafesi');
  });

  it('floors quantity according to stepSize', () => {
    const customConstraints: SymbolConstraints = {
      ...btcConstraints,
      stepSize: 0.1, // stepSize = 0.1
    };

    const balance = 50000;
    const entryPrice = 50000;
    const stopLoss = 49000;

    const result = calculatePositionSize(
      balance,
      entryPrice,
      stopLoss,
      'LONG',
      mockConfig,
      customConstraints,
    );

    if (result.isValid) {
      // remainder when divided by 0.1 should be 0
      const remainder = (result.quantity * 10) % 1;
      expect(remainder).toBeCloseTo(0, 5);
    }
  });
});
