// ══════════════════════════════════════════════════════════════
// market_structure.ts — Market Structure Analizi
// Swing High/Low → HH/HL/LH/LL → MSS (CHoCH) algılama
// "Yapı kırılmadan işlem yok" kuralının motorudur.
// ══════════════════════════════════════════════════════════════

import type { Candle, SwingPoint, MarketStructure, MarketStructureShift, MarketBias } from '../utils/types.js';
import { findSwingPoints } from '../risk/stop_loss.js';
import { logger } from '../utils/logger.js';

/**
 * Market Structure analizi yapar.
 * Swing noktalarından yapı (HH/HL vs LH/LL) belirler ve
 * MSS (Market Structure Shift = CHoCH) algılar.
 *
 * @param candles   - Mum verileri
 * @param leftBars  - Swing pivot sol bar sayısı
 * @param rightBars - Swing pivot sağ bar sayısı
 * @returns MarketStructure — bias + swingPoints + lastMSS
 */
export function analyzeMarketStructure(
  candles: Candle[],
  leftBars: number = 5,
  rightBars: number = 5,
): MarketStructure {
  const swings = findSwingPoints(candles, leftBars, rightBars);

  if (swings.length < 4) {
    return { bias: 'NEUTRAL', swingPoints: swings };
  }

  // ─── Swing'leri sırayla analiz et ─────────────────────────
  const highs = swings.filter(s => s.type === 'HIGH').sort((a, b) => a.index - b.index);
  const lows = swings.filter(s => s.type === 'LOW').sort((a, b) => a.index - b.index);

  if (highs.length < 2 || lows.length < 2) {
    return { bias: 'NEUTRAL', swingPoints: swings };
  }

  // ─── Son 4 swing ile yapı belirleme ───────────────────────
  // HH = Higher High, HL = Higher Low → BULLISH
  // LH = Lower High, LL = Lower Low → BEARISH

  let bullishCount = 0;
  let bearishCount = 0;

  // High'ları karşılaştır (HH vs LH)
  for (let i = 1; i < highs.length; i++) {
    if (highs[i]!.price > highs[i - 1]!.price) {
      bullishCount++;  // Higher High
    } else if (highs[i]!.price < highs[i - 1]!.price) {
      bearishCount++;  // Lower High
    }
  }

  // Low'ları karşılaştır (HL vs LL)
  for (let i = 1; i < lows.length; i++) {
    if (lows[i]!.price > lows[i - 1]!.price) {
      bullishCount++;  // Higher Low
    } else if (lows[i]!.price < lows[i - 1]!.price) {
      bearishCount++;  // Lower Low
    }
  }

  // ─── Bias belirleme ──────────────────────────────────────
  let bias: MarketBias;
  if (bullishCount > bearishCount + 1) {
    bias = 'BULLISH';
  } else if (bearishCount > bullishCount + 1) {
    bias = 'BEARISH';
  } else {
    bias = 'NEUTRAL';
  }

  // ─── MSS (Market Structure Shift) algılama ────────────────
  const lastMSS = detectMSS(candles, highs, lows);

  return { bias, swingPoints: swings, lastMSS };
}

/**
 * MSS (Market Structure Shift / CHoCH) algılar.
 * 
 * Close Break Kuralı:
 * Swing noktalarının kırılımı (BOS veya CHoCH) sadece fitil/iğne (wick) ile OLMAZ.
 * Kırılım onayı için fiyatın mutlaka o Swing seviyesinin üzerinde/altında
 * mum kapanışı (candle close) yapması şarttır.
 * 
 * Bullish MSS: Düşüş yapısında (LH + LL) son Lower High seviyesinin
 *   üzerinde mum kapanışı yapılması.
 * Bearish MSS: Yükseliş yapısında (HH + HL) son Higher Low seviyesinin
 *   altında mum kapanışı yapılması.
 */
function detectMSS(
  candles: Candle[],
  highs: SwingPoint[],
  lows: SwingPoint[],
): MarketStructureShift | undefined {
  if (highs.length < 2 || lows.length < 2) return undefined;

  // Son iki High'ı al (kronolojik sıra)
  const lastHigh = highs[highs.length - 1]!;
  const prevHigh = highs[highs.length - 2]!;

  // Son iki Low'u al
  const lastLow = lows[lows.length - 1]!;
  const prevLow = lows[lows.length - 2]!;

  // ─── Bullish MSS: Düşüş yapısında (LH + LL), fiyat son Lower High'ı mum kapanışıyla yukarı kırıyor
  if (prevHigh.price > lastHigh.price && prevLow.price > lastLow.price) {
    // Son High oluştuktan sonraki mumları tara
    for (let i = lastHigh.index + 1; i < candles.length; i++) {
      const c = candles[i]!;

      // CLOSE BREAK KURALI: Mutlaka mum kapanışı (close) seviyenin üstünde olmalı!
      // Sadece high > lastHigh.price olup close <= lastHigh.price ise kırılım YOKTUR (wick rejection).
      if (c.close > lastHigh.price) {
        // KÖK SORUN DÜZELTMESİ (False Positive MSS):
        // Fiyat lastHigh'ı kırmadan önce veya kırılım mumunun kendi iğnesiyle (low) 
        // lastLow seviyesinin altına düştü mü? Düştüyse yapı zaten çoktan çökmüştür.
        let brokenBeforeMSS = false;
        for (let k = lastHigh.index + 1; k <= i; k++) {
          if (candles[k]!.low < lastLow.price) {
            brokenBeforeMSS = true;
            break;
          }
        }
        
        if (brokenBeforeMSS) {
          // Bu yapı geçersiz oldu, sonraki aramalara geç
          continue;
        }

        // Kırılma sonrası yapı bozuldu mu kontrol et:
        // Eğer fiyat daha sonra son Low'un altına kapandı/sarktıyse MSS iptal olmuştur.
        let invalidated = false;
        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j]!.low < lastLow.price) { // Wick (low) ihlali yeterlidir, close beklenmez
            invalidated = true;
            break;
          }
        }

        if (!invalidated) {
          // Kırılmanın üzerinden çok fazla mum geçmemiş olmalı (mitigation penceresi: max 25 mum)
          const candlesSinceBreak = candles.length - 1 - i;
          if (candlesSinceBreak <= 25) {
            return {
              type: 'BULLISH',
              price: lastHigh.price,
              timestamp: c.timestamp,
              confirmed: true,
            };
          }
        }
      }
    }
  }

  // ─── Bearish MSS: Yükseliş yapısında (HH + HL), fiyat son Higher Low'u mum kapanışıyla aşağı kırıyor
  if (prevHigh.price < lastHigh.price && prevLow.price < lastLow.price) {
    // Son Low oluştuktan sonraki mumları tara
    for (let i = lastLow.index + 1; i < candles.length; i++) {
      const c = candles[i]!;

      // CLOSE BREAK KURALI: Mutlaka mum kapanışı (close) seviyenin altında olmalı!
      if (c.close < lastLow.price) {
        
        // KÖK SORUN DÜZELTMESİ (False Positive MSS):
        // Kırılımdan önce veya kırılım anında lastHigh seviyesi yukarı kırıldı mı?
        let brokenBeforeMSS = false;
        for (let k = lastLow.index + 1; k <= i; k++) {
          if (candles[k]!.high > lastHigh.price) {
            brokenBeforeMSS = true;
            break;
          }
        }
        
        if (brokenBeforeMSS) continue;

        let invalidated = false;
        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j]!.high > lastHigh.price) { // Wick (high) ihlali yeterlidir
            invalidated = true;
            break;
          }
        }

        if (!invalidated) {
          const candlesSinceBreak = candles.length - 1 - i;
          if (candlesSinceBreak <= 25) {
            return {
              type: 'BEARISH',
              price: lastLow.price,
              timestamp: c.timestamp,
              confirmed: true,
            };
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Market Structure durumunu loglar.
 */
export function logMarketStructure(symbol: string, structure: MarketStructure): void {
  const biasEmoji = structure.bias === 'BULLISH' ? '🟢' : structure.bias === 'BEARISH' ? '🔴' : '⚪';
  logger.info('LTF', `[${symbol}] Structure: ${biasEmoji} ${structure.bias} | Swing: ${structure.swingPoints.length} points`);

  if (structure.lastMSS) {
    const mssEmoji = structure.lastMSS.type === 'BULLISH' ? '🔀↗️' : '🔀↘️';
    logger.info('MSS', `[${symbol}] ${mssEmoji} ${structure.lastMSS.type} MSS @ ${logger.formatUSD(structure.lastMSS.price)} ` +
      `(${structure.lastMSS.confirmed ? 'CONFIRMED ✅' : 'pending...'})`);
  }
}
