// ══════════════════════════════════════════════════════════════
// htf_filter.ts — 4H Trend Filtresi (EMA200 + Yapı)
// Ana trend yönünü belirlemeden 15m'de işlem aranmaz.
// Range'de nakitte beklenir.
// ══════════════════════════════════════════════════════════════

import type { Candle, MarketBias } from '../utils/types.js';
import { calculateEMA } from '../utils/candle_utils.js';
import { analyzeMarketStructure } from './market_structure.js';
import { logger } from '../utils/logger.js';

export interface HTFFilterResult {
  bias: MarketBias;
  emaValue: number;           // Son EMA(200) değeri
  currentPrice: number;       // Son kapanış fiyatı
  emaDistance: number;         // Fiyat-EMA mesafesi (%)
  structureBias: MarketBias;  // HTF yapı analizi
  reason: string;             // İnsan okunur açıklama
}

/**
 * HTF trend filtresini çalıştırır.
 *
 * Kurallar:
 *   1. EMA(200) üstü = bullish bias → sadece LONG
 *   2. EMA(200) altı = bearish bias → sadece SHORT
 *   3. EMA(200) yakınında (%0.5 band) + yapı kararsız = NEUTRAL → işlem yok
 *   4. EMA ve yapı çelişiyorsa = NEUTRAL → işlem yok
 *
 * @param htfCandles - HTF mum verileri (min 210 mum gerekir)
 * @param tf - Zaman dilimi etiketi (varsayılan: 'HTF')
 * @returns HTFFilterResult
 */
export function runHTFFilter(htfCandles: Candle[], tf: string = 'HTF'): HTFFilterResult {
  const currentPrice = htfCandles[htfCandles.length - 1]!.close;

  // ─── EMA(200) Hesapla ────────────────────────────────────
  const emaValues = calculateEMA(htfCandles, 200);

  if (emaValues.length === 0) {
    return {
      bias: 'NEUTRAL',
      emaValue: 0,
      currentPrice,
      emaDistance: 0,
      structureBias: 'NEUTRAL',
      reason: `${tf} EMA(200) hesaplanamıyor — yetersiz veri`,
    };
  }

  const emaValue = emaValues[emaValues.length - 1]!;
  const emaDistance = ((currentPrice - emaValue) / emaValue) * 100;

  // ─── HTF Market Structure Analizi ─────────────────────────
  // Daha büyük pivot'lar (leftBars=10) kullanarak daha anlamlı yapı yakala
  const htfStructure = analyzeMarketStructure(htfCandles, 10, 10);
  const structureBias = htfStructure.bias;

  // ─── Bias Belirleme ──────────────────────────────────────
  let bias: MarketBias;
  let reason: string;

  // Kural 3: EMA yakınında sıkışma → NEUTRAL
  const rangeThreshold = 0.5; // %0.5
  if (Math.abs(emaDistance) < rangeThreshold) {
    bias = 'NEUTRAL';
    reason = `Fiyat EMA(200) yakınında sıkışmış (${emaDistance.toFixed(2)}%). Range — nakitte bekle.`;
  }
  // Kural 1: EMA üstü
  else if (currentPrice > emaValue) {
    if (structureBias === 'BEARISH') {
      // Kural 4: EMA bullish ama yapı bearish → çelişki → NEUTRAL
      bias = 'NEUTRAL';
      reason = `EMA bullish ama ${tf} yapı bearish — çelişki. Bekle.`;
    } else {
      bias = 'BULLISH';
      reason = `Fiyat EMA(200) üstünde (+${emaDistance.toFixed(2)}%). ${tf} yapı: ${structureBias}. LONG ara.`;
    }
  }
  // Kural 2: EMA altı
  else {
    if (structureBias === 'BULLISH') {
      bias = 'NEUTRAL';
      reason = `EMA bearish ama ${tf} yapı bullish — çelişki. Bekle.`;
    } else {
      bias = 'BEARISH';
      reason = `Fiyat EMA(200) altında (${emaDistance.toFixed(2)}%). ${tf} yapı: ${structureBias}. SHORT ara.`;
    }
  }

  return {
    bias,
    emaValue,
    currentPrice,
    emaDistance,
    structureBias,
    reason,
  };
}

/**
 * HTF filtre sonucunu loglar.
 */
export function logHTFFilter(symbol: string, result: HTFFilterResult): void {
  const biasEmoji = result.bias === 'BULLISH' ? '🟢' : result.bias === 'BEARISH' ? '🔴' : '⚪';

  logger.info('HTF', `[${symbol}] ${biasEmoji} HTF Trend: ${result.bias}`);
  logger.info('HTF', `[${symbol}]   EMA(200): ${logger.formatUSD(result.emaValue)} | ` +
    `Fiyat: ${logger.formatUSD(result.currentPrice)} | ` +
    `Mesafe: ${result.emaDistance >= 0 ? '+' : ''}${result.emaDistance.toFixed(2)}%`);
  logger.info('HTF', `[${symbol}]   Yapı: ${result.structureBias} | ${result.reason}`);
}
