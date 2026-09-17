import { describe, it, expect } from 'vitest';
import { calculateTradeCosts, calculateNetPnL } from '../risk/cost_calculator.js';
import type { BotConfig, SymbolConstraints } from '../utils/types.js';

describe('cost_calculator', () => {
  const mockConfig: BotConfig = {
    apiKey: 'test',
    apiSecret: 'test',
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
    makerFeePct: 0.1,    // 0.1%
    takerFeePct: 0.1,    // 0.1%
    slippageTicks: 2,
    dryRun: true,
  };

  const mockConstraints: SymbolConstraints = {
    symbol: 'BTC/USDT',
    minQty: 0.00001,
    maxQty: 9000,
    stepSize: 0.00001,
    minNotional: 5,
    tickSize: 0.01,
    minPrice: 0.01,
    maxPrice: 1000000,
  };

  it('calculates trade costs correctly for LONG', () => {
    const entryPrice = 50000;
    const exitPrice = 49000;
    const quantity = 0.01;

    const costs = calculateTradeCosts(
      entryPrice,
      exitPrice,
      quantity,
      'LONG',
      mockConfig,
      mockConstraints,
    );

    // Entry value = 50000 * 0.01 = 500 USD
    // Entry commission = 500 * 0.001 = 0.50 USD
    expect(costs.entryCommission).toBeCloseTo(0.50, 4);

    // Exit value = 49000 * 0.01 = 490 USD
    // Exit commission = 490 * 0.001 = 0.49 USD
    expect(costs.exitCommission).toBeCloseTo(0.49, 4);

    // Slippage = tickSize (0.01) * slippageTicks (2) * quantity (0.01) = 0.0002 USD
    expect(costs.slippageCost).toBeCloseTo(0.0002, 4);

    expect(costs.totalCost).toBeCloseTo(0.50 + 0.49 + 0.0002, 4);

    // For LONG: effectiveEntry > entryPrice, effectiveExit < exitPrice
    expect(costs.effectiveEntry).toBeGreaterThan(entryPrice);
    expect(costs.effectiveExit).toBeLessThan(exitPrice);
  });

  it('calculates trade costs correctly for SHORT', () => {
    const entryPrice = 50000;
    const exitPrice = 51000;
    const quantity = 0.01;

    const costs = calculateTradeCosts(
      entryPrice,
      exitPrice,
      quantity,
      'SHORT',
      mockConfig,
      mockConstraints,
    );

    // For SHORT: effectiveEntry < entryPrice, effectiveExit > exitPrice
    expect(costs.effectiveEntry).toBeLessThan(entryPrice);
    expect(costs.effectiveExit).toBeGreaterThan(exitPrice);
  });

  it('calculates net PnL after costs correctly', () => {
    const entryPrice = 50000;
    const exitPrice = 52000; // +2000 USD gross gain
    const quantity = 0.01;   // +20 USD gross gain

    const netPnL = calculateNetPnL(
      entryPrice,
      exitPrice,
      quantity,
      'LONG',
      mockConfig,
      mockConstraints,
    );

    const costs = calculateTradeCosts(
      entryPrice,
      exitPrice,
      quantity,
      'LONG',
      mockConfig,
      mockConstraints,
    );

    expect(netPnL).toBeCloseTo(20 - costs.totalCost, 4);
    expect(netPnL).toBeGreaterThan(0);
  });
});
