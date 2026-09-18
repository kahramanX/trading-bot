// ══════════════════════════════════════════════════════════════
// breaker_block.ts — Breaker Block Tespit & Mitigation
// Kırılan eski destek/direnç blokları (Order Block → Breaker)
// FVG ile confluence (örtüşme) kontrolü dahil.
// ══════════════════════════════════════════════════════════════

import type { Candle, BreakerBlock, SwingPoint } from '../utils/types.js';
import { findSwingPoints } from '../risk/stop_loss.js';
import { logger } from '../utils/logger.js';

/**
 * Breaker Block'ları tespit eder.
 *
 * Bullish Breaker: Önceden direnç olarak işlev gören bir swing high
 *   bölgesi, fiyat tarafından yukarı kırıldıktan sonra destek haline gelir.
 *   Fiyat bu bölgeye geri çekildiğinde alım fırsatı.
 *
 * Bearish Breaker: Önceden destek olan swing low bölgesi, fiyat
 *   tarafından aşağı kırıldıktan sonra direnç haline gelir.
 *
 * @param candles - Mum verileri
 * @returns BreakerBlock dizisi
 */
export function detectBreakerBlocks(candles: Candle[]): BreakerBlock[] {
  if (candles.length < 20) return [];

  const swings = findSwingPoints(candles, 5, 5);
  const breakers: BreakerBlock[] = [];

  const highs = swings.filter(s => s.type === 'HIGH').sort((a, b) => a.index - b.index);
  const lows = swings.filter(s => s.type === 'LOW').sort((a, b) => a.index - b.index);

  // ─── Bullish Breaker Block ────────────────────────────────
  // Swing High (eski direnç) kırıldıysa → breaker
  for (let i = 0; i < highs.length; i++) {
    const swingHigh = highs[i]!;

    // Bu swing high'ın sonraki mumlarda kırılıp kırılmadığını kontrol et
    let broken = false;
    let breakIndex = -1;

    for (let j = swingHigh.index + 1; j < candles.length; j++) {
      if (candles[j]!.close > swingHigh.price) {
        broken = true;
        breakIndex = j;
        break;
      }
    }

    if (broken && breakIndex > 0) {
      // Kırılma mumundan önceki son düşüş mumunu bul (order block body)
      const orderBlockCandle = findLastBearishCandle(candles, swingHigh.index, breakIndex);
      if (orderBlockCandle) {
        const high = Math.max(orderBlockCandle.open, orderBlockCandle.close);
        const low = Math.min(orderBlockCandle.open, orderBlockCandle.close);

        breakers.push({
          type: 'BULLISH',
          high,
          low,
          timestamp: orderBlockCandle.timestamp,
          index: candles.indexOf(orderBlockCandle),
          mitigated: false,
        });
      }
    }
  }

  // ─── Bearish Breaker Block ────────────────────────────────
  for (let i = 0; i < lows.length; i++) {
    const swingLow = lows[i]!;

    let broken = false;
    let breakIndex = -1;

    for (let j = swingLow.index + 1; j < candles.length; j++) {
      if (candles[j]!.close < swingLow.price) {
        broken = true;
        breakIndex = j;
        break;
      }
    }

    if (broken && breakIndex > 0) {
      const orderBlockCandle = findLastBullishCandle(candles, swingLow.index, breakIndex);
      if (orderBlockCandle) {
        const high = Math.max(orderBlockCandle.open, orderBlockCandle.close);
        const low = Math.min(orderBlockCandle.open, orderBlockCandle.close);

        breakers.push({
          type: 'BEARISH',
          high,
          low,
          timestamp: orderBlockCandle.timestamp,
          index: candles.indexOf(orderBlockCandle),
          mitigated: false,
        });
      }
    }
  }

  // ─── Mitigation kontrolü ─────────────────────────────────
  for (const breaker of breakers) {
    for (let i = breaker.index + 1; i < candles.length; i++) {
      const candle = candles[i]!;

      if (breaker.type === 'BULLISH') {
        // Fiyat breaker bölgesine geri çekildi
        if (candle.low <= breaker.high && candle.low >= breaker.low) {
          breaker.mitigated = true;
          break;
        }
      } else {
        if (candle.high >= breaker.low && candle.high <= breaker.high) {
          breaker.mitigated = true;
          break;
        }
      }
    }
  }

  return breakers.sort((a, b) => b.index - a.index);
}

/**
 * Aktif (henüz mitigate edilmemiş) Breaker Block'ları filtreler.
 */
export function getActiveBreakerBlocks(
  candles: Candle[],
  direction: 'BULLISH' | 'BEARISH',
  maxAge: number = 25,
): BreakerBlock[] {
  const all = detectBreakerBlocks(candles);
  const lastIndex = candles.length - 1;

  return all.filter(b =>
    b.type === direction &&
    !b.mitigated &&
    (lastIndex - b.index) <= maxAge
  );
}

/**
 * Sadece en son oluşan aktif Breaker Block'u döndürür.
 */
export function getLatestActiveBreakerBlock(
  candles: Candle[],
  direction: 'BULLISH' | 'BEARISH',
  maxAge: number = 25,
): BreakerBlock | null {
  const active = getActiveBreakerBlocks(candles, direction, maxAge);
  return active.length > 0 ? active[0]! : null;
}

/**
 * Fiyatın Breaker Block bölgesinde olup olmadığını kontrol eder.
 */
export function isPriceInBreakerBlock(price: number, block: BreakerBlock): boolean {
  return price >= block.low && price <= block.high;
}

/**
 * FVG ile Breaker Block arasında confluence (örtüşme) kontrolü.
 * İki bölgenin kesişip kesişmediğini kontrol eder.
 */
export function hasConfluence(
  fvgLow: number,
  fvgHigh: number,
  breakerLow: number,
  breakerHigh: number,
): boolean {
  // İki aralık kesişiyor mu?
  return fvgLow <= breakerHigh && fvgHigh >= breakerLow;
}

/**
 * İki index arasındaki son düşüş (bearish) mumunu bulur.
 */
function findLastBearishCandle(candles: Candle[], startIdx: number, endIdx: number): Candle | null {
  for (let i = endIdx - 1; i >= startIdx; i--) {
    const c = candles[i]!;
    if (c.close < c.open) return c;  // Düşüş mumu (kırmızı)
  }
  return null;
}

/**
 * İki index arasındaki son yükseliş (bullish) mumunu bulur.
 */
function findLastBullishCandle(candles: Candle[], startIdx: number, endIdx: number): Candle | null {
  for (let i = endIdx - 1; i >= startIdx; i--) {
    const c = candles[i]!;
    if (c.close > c.open) return c;  // Yükseliş mumu (yeşil)
  }
  return null;
}

/**
 * Breaker Block durumunu loglar.
 */
export function logBreakerBlockStatus(symbol: string, candles: Candle[]): void {
  const bullish = getActiveBreakerBlocks(candles, 'BULLISH');
  const bearish = getActiveBreakerBlocks(candles, 'BEARISH');

  if (bullish.length > 0) {
    logger.info('BRK', `[${symbol}] ${bullish.length} active Bullish Breakers:`);
    for (const b of bullish.slice(0, 3)) {
      logger.info('BRK', `  🧱 ${logger.formatUSD(b.low)} — ${logger.formatUSD(b.high)}`);
    }
  }

  if (bearish.length > 0) {
    logger.info('BRK', `[${symbol}] ${bearish.length} active Bearish Breakers:`);
    for (const b of bearish.slice(0, 3)) {
      logger.info('BRK', `  🧱 ${logger.formatUSD(b.low)} — ${logger.formatUSD(b.high)}`);
    }
  }
}
