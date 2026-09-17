import { describe, it, expect } from 'vitest';
import { findSwingPoints, calculateStopLoss, calculateBreakEvenStopLoss } from '../risk/stop_loss.js';
import type { Candle } from '../utils/types.js';

describe('stop_loss', () => {
  function createCandle(index: number, high: number, low: number, close: number): Candle {
    return {
      timestamp: 1000 + index * 60000,
      open: (high + low) / 2,
      high,
      low,
      close,
      volume: 100,
    };
  }

  it('finds swing points with custom left/right bars', () => {
    // 5 candles: index 2 is peak
    const candles: Candle[] = [
      createCandle(0, 10, 5, 8),
      createCandle(1, 12, 7, 10),
      createCandle(2, 20, 15, 18), // Swing High
      createCandle(3, 11, 6, 9),
      createCandle(4, 9, 4, 7),
    ];

    const swings = findSwingPoints(candles, 2, 2);
    expect(swings.length).toBeGreaterThan(0);
    const swingHigh = swings.find(s => s.type === 'HIGH');
    expect(swingHigh).toBeDefined();
    expect(swingHigh?.price).toBe(20);
    expect(swingHigh?.index).toBe(2);
  });

  it('calculates swing-based stop loss for LONG', () => {
    // Need at least 11 candles for default 5/5 swing detection
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      let low = 100;
      let high = 110;
      if (i === 6) {
        low = 90; // Swing low
        high = 95;
      }
      candles.push(createCandle(i, high, low, (high + low) / 2));
    }

    const sl = calculateStopLoss(candles, 105, 'LONG', 100, 0.01);
    expect(sl).toBeDefined();
    expect(sl).toBeLessThan(95);
  });

  it('calculates break-even stop loss properly', () => {
    const entryPrice = 50000;
    const tickSize = 0.01;
    const mockConfig = {
      makerFeePct: 0.02,
      takerFeePct: 0.05,
    } as any;

    const longBE = calculateBreakEvenStopLoss(entryPrice, 'LONG', tickSize, mockConfig);
    expect(longBE).toBeGreaterThan(entryPrice); // Covers fee

    const shortBE = calculateBreakEvenStopLoss(entryPrice, 'SHORT', tickSize, mockConfig);
    expect(shortBE).toBeLessThan(entryPrice); // Covers fee
  });
});
