import { describe, it, expect } from 'vitest';
import {
  detectFairValueGaps,
  getActiveFVGs,
  getLatestActiveFVG,
  isPriceInFVG,
  getNearestActiveFVG,
} from '../strategy/fair_value_gap.js';
import type { Candle } from '../utils/types.js';

describe('fair_value_gap', () => {
  function createCandle(index: number, high: number, low: number, open?: number, close?: number): Candle {
    const o = open ?? (high + low) / 2;
    const c = close ?? (high + low) / 2;
    return {
      timestamp: 1000 + index * 60000,
      open: o,
      high,
      low,
      close: c,
      volume: 100,
    };
  }

  it('detects a Bullish FVG (candle 1 high < candle 3 low)', () => {
    const candles: Candle[] = [
      createCandle(0, 50, 40),
      createCandle(1, 52, 42),
      createCandle(2, 50, 40), // candle 1: high = 50
      createCandle(3, 75, 48), // candle 2: big impulse candle
      createCandle(4, 85, 60), // candle 3: low = 60 (> candle 1 high of 50)
      createCandle(5, 84, 65),
    ];

    const gaps = detectFairValueGaps(candles, 0); // minATRRatio = 0 to avoid filtering
    const bullishGaps = gaps.filter(g => g.type === 'BULLISH');

    expect(bullishGaps.length).toBeGreaterThan(0);
    const gap = bullishGaps[0]!;
    expect(gap.low).toBe(50);
    expect(gap.high).toBe(60);
    expect(gap.midpoint).toBe(55);
    expect(gap.mitigated).toBe(false);
  });

  it('detects a Bearish FVG (candle 1 low > candle 3 high)', () => {
    const candles: Candle[] = [
      createCandle(0, 100, 90),
      createCandle(1, 98, 88),
      createCandle(2, 95, 80), // candle 1: low = 80
      createCandle(3, 82, 55), // candle 2: big impulse down
      createCandle(4, 65, 50), // candle 3: high = 65 (< candle 1 low of 80)
      createCandle(5, 62, 48),
    ];

    const gaps = detectFairValueGaps(candles, 0);
    const bearishGaps = gaps.filter(g => g.type === 'BEARISH');

    expect(bearishGaps.length).toBeGreaterThan(0);
    const gap = bearishGaps[0]!;
    expect(gap.high).toBe(80);
    expect(gap.low).toBe(65);
    expect(gap.midpoint).toBe(72.5);
  });

  it('marks FVG as mitigated when subsequent price action fills the gap', () => {
    const candles: Candle[] = [
      createCandle(0, 50, 40),
      createCandle(1, 52, 42),
      createCandle(2, 50, 40), // candle 1: high = 50
      createCandle(3, 75, 48), // impulse
      createCandle(4, 85, 60), // candle 3: low = 60
      createCandle(5, 70, 45), // price retraces: low = 45 <= FVG high of 60 -> MITIGATED!
    ];

    const gaps = detectFairValueGaps(candles, 0);
    const bullishGap = gaps.find(g => g.type === 'BULLISH');
    expect(bullishGap).toBeDefined();
    expect(bullishGap?.mitigated).toBe(true);

    const activeGaps = getActiveFVGs(candles, 'BULLISH');
    expect(activeGaps.length).toBe(0);
  });

  it('correctly checks isPriceInFVG', () => {
    const gap = {
      type: 'BULLISH' as const,
      high: 60,
      low: 50,
      midpoint: 55,
      timestamp: 1000,
      index: 1,
      mitigated: false,
      size: 10,
    };

    expect(isPriceInFVG(55, gap)).toBe(true);
    expect(isPriceInFVG(50, gap)).toBe(true);
    expect(isPriceInFVG(60, gap)).toBe(true);
    expect(isPriceInFVG(49, gap)).toBe(false);
    expect(isPriceInFVG(61, gap)).toBe(false);
  });

  it('fetches only the latest active FVG and ignores older ones', () => {
    const candles: Candle[] = [
      // FVG 1 (older, idx 1-3)
      createCandle(0, 30, 20),
      createCandle(1, 30, 20),
      createCandle(2, 45, 28),
      createCandle(3, 55, 38), // FVG 1 between 30 and 38
      // Middle candles
      createCandle(4, 56, 45),
      createCandle(5, 58, 46),
      // FVG 2 (latest, idx 5-7)
      createCandle(6, 75, 50),
      createCandle(7, 85, 68), // FVG 2 between 58 and 68
      createCandle(8, 86, 72),
    ];

    const latest = getLatestActiveFVG(candles, 'BULLISH', 25);
    expect(latest).toBeDefined();
    // Latest should be FVG 2: [58, 68]
    expect(latest?.low).toBe(58);
    expect(latest?.high).toBe(68);
  });
});
