import { describe, it, expect } from 'vitest';
import { analyzeMarketStructure } from '../strategy/market_structure.js';
import type { Candle } from '../utils/types.js';

describe('market_structure', () => {
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

  it('identifies BULLISH structure when HH and HL are formed', () => {
    // Generate a series of candles that create Higher Highs and Higher Lows with leftBars=2, rightBars=2
    const candles: Candle[] = [
      // Base
      createCandle(0, 50, 40, 45),
      createCandle(1, 55, 45, 50),
      // Swing Low 1 @ idx 2
      createCandle(2, 45, 30, 35),
      createCandle(3, 55, 45, 50),
      createCandle(4, 60, 50, 55),
      // Swing High 1 @ idx 5
      createCandle(5, 80, 70, 75),
      createCandle(6, 70, 60, 65),
      createCandle(7, 65, 55, 60),
      // Swing Low 2 @ idx 8 (HL: low 40 > 30)
      createCandle(8, 55, 40, 45),
      createCandle(9, 70, 60, 65),
      createCandle(10, 80, 70, 75),
      // Swing High 2 @ idx 11 (HH: high 100 > 80)
      createCandle(11, 100, 90, 95),
      createCandle(12, 90, 80, 85),
      createCandle(13, 88, 78, 80),
      createCandle(14, 85, 75, 78),
    ];

    const structure = analyzeMarketStructure(candles, 2, 2);
    expect(structure.bias).toBe('BULLISH');
  });

  it('identifies BEARISH structure when LH and LL are formed', () => {
    const candles: Candle[] = [
      // Base
      createCandle(0, 90, 80, 85),
      createCandle(1, 95, 85, 90),
      // Swing High 1 @ idx 2
      createCandle(2, 110, 100, 105),
      createCandle(3, 95, 85, 90),
      createCandle(4, 90, 80, 85),
      // Swing Low 1 @ idx 5
      createCandle(5, 70, 60, 65),
      createCandle(6, 80, 70, 75),
      createCandle(7, 85, 75, 80),
      // Swing High 2 @ idx 8 (LH: high 95 < 110)
      createCandle(8, 95, 85, 90),
      createCandle(9, 75, 65, 70),
      createCandle(10, 60, 50, 55),
      // Swing Low 2 @ idx 11 (LL: low 40 < 60)
      createCandle(11, 55, 40, 45),
      createCandle(12, 60, 50, 55),
      createCandle(13, 62, 52, 58),
      createCandle(14, 60, 50, 52),
    ];

    const structure = analyzeMarketStructure(candles, 2, 2);
    expect(structure.bias).toBe('BEARISH');
  });

  it('rejects wick-only break and confirms Bullish MSS ONLY on candle close', () => {
    // Downtrend base (LH + LL)
    const baseCandles: Candle[] = [
      createCandle(0, 90, 80, 85),
      createCandle(1, 95, 85, 90),
      // Swing High 1 @ idx 2 (price: 110)
      createCandle(2, 110, 100, 105),
      createCandle(3, 95, 85, 90),
      createCandle(4, 90, 80, 85),
      // Swing Low 1 @ idx 5 (price: 60)
      createCandle(5, 70, 60, 65),
      createCandle(6, 80, 70, 75),
      createCandle(7, 85, 75, 80),
      // Swing High 2 (Lower High) @ idx 8 (price: 95)
      createCandle(8, 95, 85, 90),
      createCandle(9, 75, 65, 70),
      createCandle(10, 60, 50, 55),
      // Swing Low 2 (Lower Low) @ idx 11 (price: 40)
      createCandle(11, 55, 40, 45),
      createCandle(12, 60, 50, 55),
      createCandle(13, 62, 52, 58),
    ];

    // Case A: Wick rejection — High reaches 98 (> lastHigh of 95), BUT Close is 92 (<= 95)
    const wickCandles = [
      ...baseCandles,
      createCandle(14, 98, 70, 92), // Wick poked above 95, close below 95
    ];
    const wickStructure = analyzeMarketStructure(wickCandles, 2, 2);
    expect(wickStructure.lastMSS).toBeUndefined(); // Wick alone MUST NOT confirm MSS!

    // Case B: Close break — High reaches 100, AND Close is 99 (> 95)
    const closeBreakCandles = [
      ...baseCandles,
      createCandle(14, 100, 70, 99), // Candle close ABOVE 95
      createCandle(15, 98, 85, 90),  // Subsequent pullback candle
    ];
    const closeStructure = analyzeMarketStructure(closeBreakCandles, 2, 2);
    expect(closeStructure.lastMSS).toBeDefined();
    expect(closeStructure.lastMSS?.type).toBe('BULLISH');
    expect(closeStructure.lastMSS?.price).toBe(95);
    expect(closeStructure.lastMSS?.confirmed).toBe(true);
  });
});
