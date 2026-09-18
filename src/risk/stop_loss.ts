// ══════════════════════════════════════════════════════════════
// stop_loss.ts — Hard Stop-Loss Hesaplama + Break-Even SL
// ══════════════════════════════════════════════════════════════

import type { Candle, TradeDirection, SwingPoint, BotConfig } from '../utils/types.js';
import { calculateATR, roundToTickSize, ceilToTickSize, floorToTickSize } from '../utils/candle_utils.js';
import { logger } from '../utils/logger.js';

/**
 * Swing High/Low noktalarını tespit eder (N-bar pivot).
 */
export function findSwingPoints(
  candles: Candle[],
  leftBars: number = 5,
  rightBars: number = 5,
): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const required = leftBars + rightBars + 1;
  if (candles.length < required) return swings;

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const current = candles[i]!;

    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= current.high) isSwingHigh = false;
      if (candles[j]!.low <= current.low) isSwingLow = false;
      if (!isSwingHigh && !isSwingLow) break;
    }

    if (isSwingHigh) {
      swings.push({ type: 'HIGH', price: current.high, index: i, timestamp: current.timestamp });
    }
    if (isSwingLow) {
      swings.push({ type: 'LOW', price: current.low, index: i, timestamp: current.timestamp });
    }
  }

  return swings;
}

/**
 * Hard Stop-Loss hesaplar.
 * Öncelik: Swing Low/High → ATR(14) × 1.5 fallback
 */
export function calculateStopLoss(
  candles: Candle[],
  entryPrice: number,
  direction: TradeDirection,
  zoneEdge: number,
  tickSize: number,
  atrMultiplier: number = 1.5,
  minSlPct: number = 0.002, // default 0.2%
): number | null {
  const swings = findSwingPoints(candles);
  let stopLoss: number | null = null;
  let method = '';

  if (direction === 'LONG') {
    const swingLows = swings
      .filter(s => s.type === 'LOW' && s.price < zoneEdge)
      .sort((a, b) => b.price - a.price);

    if (swingLows.length > 0) {
      stopLoss = swingLows[0]!.price - tickSize;
      method = 'Swing Low';
    }
  } else {
    const swingHighs = swings
      .filter(s => s.type === 'HIGH' && s.price > zoneEdge)
      .sort((a, b) => a.price - b.price);

    if (swingHighs.length > 0) {
      stopLoss = swingHighs[0]!.price + tickSize;
      method = 'Swing High';
    }
  }

  if (stopLoss === null) {
    const atr = calculateATR(candles);
    if (atr === null) {
      logger.error('RISK', 'Cannot calculate SL: Swing not found, insufficient ATR data.');
      return null;
    }
    const atrDistance = atr * atrMultiplier;
    stopLoss = direction === 'LONG' ? entryPrice - atrDistance : entryPrice + atrDistance;
    method = `ATR(14) × ${atrMultiplier}`;
  }

  stopLoss = roundToTickSize(stopLoss, tickSize);

  // Apply Minimum SL Percentage Safeguard
  const slDistance = Math.abs(entryPrice - stopLoss);
  const slPct = slDistance / entryPrice;
  
  if (slPct < minSlPct) {
    const minDistance = entryPrice * minSlPct;
    stopLoss = direction === 'LONG' 
      ? entryPrice - minDistance
      : entryPrice + minDistance;
    stopLoss = roundToTickSize(stopLoss, tickSize);
    method += ` (Adjusted to min ${(minSlPct * 100).toFixed(2)}%)`;
  }

  logger.info('RISK', `SL (${method}): ${logger.formatUSD(stopLoss)} | ` +
    `Entry: ${logger.formatUSD(entryPrice)} | Distance: ${logger.formatUSD(Math.abs(entryPrice - stopLoss))}`);

  return stopLoss;
}

/**
 * Break-Even SL — TP1 hit sonrası kalan pozisyonun SL'ini girişe çeker.
 */
export function calculateBreakEvenStopLoss(
  entryPrice: number,
  direction: TradeDirection,
  tickSize: number,
  config: BotConfig,
): number {
  const makerFee = config.makerFeePct / 100;
  const takerFee = config.takerFeePct / 100;
  let breakEvenSL: number;

  if (direction === 'LONG') {
    breakEvenSL = entryPrice * (1 + makerFee) / (1 - takerFee);
    breakEvenSL = ceilToTickSize(breakEvenSL, tickSize);
  } else {
    breakEvenSL = entryPrice * (1 - makerFee) / (1 + takerFee);
    breakEvenSL = floorToTickSize(breakEvenSL, tickSize);
  }

  logger.info('RISK', `🔄 SL → True Break-Even: ${logger.formatUSD(breakEvenSL)}`);
  return breakEvenSL;
}
