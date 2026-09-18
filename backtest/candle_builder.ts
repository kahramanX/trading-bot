import type { Candle } from '../src/utils/types.js';

export function timeframeToMs(tf: string): number {
  const match = tf.match(/^(\d+)([mhdwM])$/);
  if (!match) throw new Error(`Invalid timeframe: ${tf}`);
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    'm': 60_000,
    'h': 3_600_000,
    'd': 86_400_000,
    'w': 604_800_000,
  };
  if (unit === 'M') throw new Error("Monthly synthesis not supported by simple math");
  return value * multipliers[unit]!;
}

export class CandleSynthesizer {
  private currentCandle: Candle | null = null;
  private currentCandleStartTime = 0;
  private readonly timeframeMs: number;

  constructor(timeframe: string) {
    this.timeframeMs = timeframeToMs(timeframe);
  }

  /**
   * Feeds a 1m candle into the synthesizer.
   * Returns a fully formed higher-timeframe candle if the new 1m candle
   * crosses the boundary, meaning the PREVIOUS synthetic candle has closed.
   */
  public feed(candle1m: Candle): Candle | null {
    // 4H candle starting at 00:00:00 UTC has timestamp 0.
    // We can find the start of the current synthetic candle by rounding down.
    const syntheticStartTime = Math.floor(candle1m.timestamp / this.timeframeMs) * this.timeframeMs;

    let closedCandle: Candle | null = null;

    if (!this.currentCandle) {
      // First candle ever
      this.currentCandleStartTime = syntheticStartTime;
      this.currentCandle = { ...candle1m, timestamp: syntheticStartTime };
    } else if (syntheticStartTime > this.currentCandleStartTime) {
      // Boundary crossed! The old candle is now fully closed.
      closedCandle = this.currentCandle;
      
      // Start a new one
      this.currentCandleStartTime = syntheticStartTime;
      this.currentCandle = { ...candle1m, timestamp: syntheticStartTime };
    } else {
      // Still inside the current synthetic candle, aggregate data
      this.currentCandle.high = Math.max(this.currentCandle.high, candle1m.high);
      this.currentCandle.low = Math.min(this.currentCandle.low, candle1m.low);
      this.currentCandle.close = candle1m.close;
      this.currentCandle.volume += candle1m.volume;
    }

    return closedCandle;
  }
}
