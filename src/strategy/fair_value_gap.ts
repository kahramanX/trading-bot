// ══════════════════════════════════════════════════════════════
// fair_value_gap.ts — FVG (Fair Value Gap) Tespit & Mitigation
// 3-mum pattern'ı ile oluşan fiyat dengesizliklerini bulur.
// Bot bu bölgelere "pusu kurar".
// ══════════════════════════════════════════════════════════════

import type { Candle, FairValueGap } from '../utils/types.js';
import { calculateATR } from '../utils/candle_utils.js';
import { logger } from '../utils/logger.js';

/**
 * FVG (Fair Value Gap) bölgelerini tespit eder.
 *
 * Bullish FVG: mum[i-2].high < mum[i].low → arada dolmamış boşluk
 * Bearish FVG: mum[i-2].low > mum[i].high → arada dolmamış boşluk
 *
 * @param candles     - Mum verileri (15m veya istenilen TF)
 * @param minATRRatio - Minimum FVG büyüklüğü (ATR'nin oranı olarak). Gürültü filtresi.
 * @returns FairValueGap dizisi (en yeniden en eskiye)
 */
export function detectFairValueGaps(
  candles: Candle[],
  minATRRatio: number = 0.3,
): FairValueGap[] {
  if (candles.length < 5) return [];

  // ATR(14) kuralı: Boşluğun geçerli olması için ATR(14)'ün en az %30'u olması şarttır
  const atr = calculateATR(candles, 14);
  const minSize = atr ? atr * minATRRatio : 0;

  const gaps: FairValueGap[] = [];

  // i=2'den başla (3 mum gerekli: i-2, i-1, i)
  for (let i = 2; i < candles.length; i++) {
    const candle1 = candles[i - 2]!;  // İlk mum
    const candle3 = candles[i]!;       // Üçüncü mum

    // ─── Bullish FVG ────────────────────────────────────────
    // Mum 1'in HIGH'ı < Mum 3'ün LOW'u → arada dolmamış boşluk
    if (candle1.high < candle3.low) {
      const size = candle3.low - candle1.high;

      if (size >= minSize) {
        gaps.push({
          type: 'BULLISH',
          high: candle3.low,        // FVG üst kenarı
          low: candle1.high,        // FVG alt kenarı
          midpoint: (candle3.low + candle1.high) / 2,
          timestamp: candles[i - 1]!.timestamp,  // Ortadaki mumun zamanı
          index: i - 1,
          mitigated: false,
          size,
        });
      }
    }

    // ─── Bearish FVG ────────────────────────────────────────
    // Mum 1'in LOW'u > Mum 3'ün HIGH'ı → arada dolmamış boşluk
    if (candle1.low > candle3.high) {
      const size = candle1.low - candle3.high;

      if (size >= minSize) {
        gaps.push({
          type: 'BEARISH',
          high: candle1.low,        // FVG üst kenarı
          low: candle3.high,        // FVG alt kenarı
          midpoint: (candle1.low + candle3.high) / 2,
          timestamp: candles[i - 1]!.timestamp,
          index: i - 1,
          mitigated: false,
          size,
        });
      }
    }
  }

  // ─── Mitigation kontrolü ─────────────────────────────────
  // Fiyat geçmiş mumlarda FVG bölgesini tamamen doldurdu mu?
  // Not: Güncel mum (candles.length - 1) pusu ve giriş anı olduğu için geçmiş mitigation döngüsüne dahil edilmez.
  for (const gap of gaps) {
    for (let i = gap.index + 2; i < candles.length; i++) {
      const candle = candles[i]!;

      if (gap.type === 'BULLISH') {
        // Bullish FVG: Fiyat FVG'nin altına tamamen indi/doldurdu (low <= gap.low)
        if (candle.low <= gap.low) {
          gap.mitigated = true;
          break;
        }
      } else {
        // Bearish FVG: Fiyat FVG'nin üstüne tamamen çıktı/doldurdu (high >= gap.high)
        if (candle.high >= gap.high) {
          gap.mitigated = true;
          break;
        }
      }
    }
  }

  // En yeniden en eskiye sırala (b.index - a.index)
  return gaps.sort((a, b) => b.index - a.index);
}

/**
 * Aktif (henüz mitigate edilmemiş) FVG'leri filtreler.
 * Sadece belirtilen yöndeki gap'leri döndürür.
 */
export function getActiveFVGs(
  candles: Candle[],
  direction: 'BULLISH' | 'BEARISH',
  maxAge: number = 25,  // Eski FVG'leri hafızada tutma (varsayılan: 25 mum)
): FairValueGap[] {
  const allGaps = detectFairValueGaps(candles);
  const lastIndex = candles.length - 1;

  return allGaps.filter(gap =>
    gap.type === direction &&
    !gap.mitigated &&
    (lastIndex - gap.index) <= maxAge
  );
}

/**
 * Sadece EN SON oluşan geçerli ve aktif FVG'yi döndürür.
 * Kural: Eski FVG'leri hafızada tutma, sadece en son oluşan yapıyı takip et.
 */
export function getLatestActiveFVG(
  candles: Candle[],
  direction: 'BULLISH' | 'BEARISH',
  maxAge: number = 25,
): FairValueGap | null {
  const active = getActiveFVGs(candles, direction, maxAge);
  return active.length > 0 ? active[0]! : null;
}

/**
 * Fiyatın bir FVG bölgesinde olup olmadığını kontrol eder.
 * Giriş sinyali için — fiyat FVG'ye "değdi" mi?
 */
export function isPriceInFVG(price: number, gap: FairValueGap): boolean {
  return price >= gap.low && price <= gap.high;
}

/**
 * En yakın aktif FVG'yi döndürür (fiyata en yakın).
 */
export function getNearestActiveFVG(
  candles: Candle[],
  currentPrice: number,
  direction: 'BULLISH' | 'BEARISH',
): FairValueGap | null {
  const activeGaps = getActiveFVGs(candles, direction);

  if (activeGaps.length === 0) return null;

  // Fiyata en yakın FVG'yi bul
  return activeGaps.reduce((nearest, gap) => {
    const distCurrent = Math.abs(currentPrice - gap.midpoint);
    const distNearest = Math.abs(currentPrice - nearest.midpoint);
    return distCurrent < distNearest ? gap : nearest;
  });
}

/**
 * FVG durumunu loglar.
 */
export function logFVGStatus(symbol: string, candles: Candle[]): void {
  const bullishGaps = getActiveFVGs(candles, 'BULLISH');
  const bearishGaps = getActiveFVGs(candles, 'BEARISH');

  if (bullishGaps.length > 0) {
    logger.info('FVG', `[${symbol}] ${bullishGaps.length} active Bullish FVGs:`);
    for (const gap of bullishGaps.slice(0, 3)) {
      logger.info('FVG', `  📐 ${logger.formatUSD(gap.low)} — ${logger.formatUSD(gap.high)} (size: ${logger.formatUSD(gap.size)})`);
    }
  }

  if (bearishGaps.length > 0) {
    logger.info('FVG', `[${symbol}] ${bearishGaps.length} active Bearish FVGs:`);
    for (const gap of bearishGaps.slice(0, 3)) {
      logger.info('FVG', `  📐 ${logger.formatUSD(gap.low)} — ${logger.formatUSD(gap.high)} (size: ${logger.formatUSD(gap.size)})`);
    }
  }

  if (bullishGaps.length === 0 && bearishGaps.length === 0) {
    logger.debug('FVG', `[${symbol}] No active FVG.`);
  }
}
