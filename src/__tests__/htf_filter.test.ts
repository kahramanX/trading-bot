import { describe, it, expect } from 'vitest';
import { runHTFFilter } from '../strategy/htf_filter.js';
import type { Candle } from '../utils/types.js';

describe('htf_filter', () => {
  function generateTrendCandles(count: number, startPrice: number, step: number): Candle[] {
    const candles: Candle[] = [];
    let current = startPrice;
    for (let i = 0; i < count; i++) {
      current += step;
      candles.push({
        timestamp: 1000 + i * 4 * 60 * 60 * 1000,
        open: current - 5,
        high: current + 10,
        low: current - 10,
        close: current,
        volume: 1000,
      });
    }
    return candles;
  }

  it('returns NEUTRAL if insufficient data (fewer than 10 candles)', () => {
    const candles = generateTrendCandles(5, 1000, 5);
    const result = runHTFFilter(candles);
    expect(result.bias).toBe('NEUTRAL');
    expect(result.reason).toContain('yetersiz veri');
  });

  it('detects strong BULLISH trend when price is well above EMA(200)', () => {
    // Generate 250 candles with strong upward drift
    const candles = generateTrendCandles(250, 1000, 10);
    const result = runHTFFilter(candles);
    expect(result.bias).toBe('BULLISH');
    expect(result.currentPrice).toBeGreaterThan(result.emaValue);
    expect(result.emaDistance).toBeGreaterThan(0.5);
  });

  it('detects strong BEARISH trend when price is well below EMA(200)', () => {
    // Generate 250 candles with strong downward drift
    const candles = generateTrendCandles(250, 5000, -10);
    const result = runHTFFilter(candles);
    expect(result.bias).toBe('BEARISH');
    expect(result.currentPrice).toBeLessThan(result.emaValue);
    expect(result.emaDistance).toBeLessThan(-0.5);
  });
});
