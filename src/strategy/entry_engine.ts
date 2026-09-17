// ══════════════════════════════════════════════════════════════
// entry_engine.ts — Giriş Sinyali Orkestratörü
// Tüm strateji bileşenlerini birleştirir:
//   HTF Filtre → MSS → FVG/Breaker → R:R → Risk → Sinyal
// Her adım terminale loglanır — kara kutu yok.
// ══════════════════════════════════════════════════════════════

import type { Candle, TradeSignal, MarketBias, BotConfig, SymbolConstraints } from '../utils/types.js';
import { runHTFFilter, logHTFFilter } from './htf_filter.js';
import { analyzeMarketStructure, logMarketStructure } from './market_structure.js';
import { getNearestActiveFVG, getLatestActiveFVG, isPriceInFVG, logFVGStatus } from './fair_value_gap.js';
import { getActiveBreakerBlocks, getLatestActiveBreakerBlock, isPriceInBreakerBlock, hasConfluence, logBreakerBlockStatus } from './breaker_block.js';
import { calculateStopLoss } from '../risk/stop_loss.js';
import { logger } from '../utils/logger.js';
import { playSound } from '../utils/sound_player.js';

export interface EngineResult {
  signal: TradeSignal | null;
  reason: string;            // Neden sinyal verildi/verilmedi
  step: string;              // Hangi adımda durdu
}

/**
 * Giriş sinyali motoru — bir sembol için tam analiz döngüsü.
 *
 * Adımlar:
 *   1. HTF filtre (4H) → BULLISH/BEARISH/NEUTRAL
 *   2. LTF (15m) Market Structure + MSS onayı
 *   3. FVG veya Breaker Block tespiti
 *   4. Fiyat mitigation bölgesinde mi?
 *   5. SL hesaplama → R:R uygun mu?
 *   6. ✅ Sinyal oluştur
 */
export function runEntryEngine(
  symbol: string,
  htfCandles: Candle[],
  ltfCandles: Candle[],
  config: BotConfig,
  constraints: SymbolConstraints,
): EngineResult {
  const noSignal = (reason: string, step: string): EngineResult => ({
    signal: null, reason, step,
  });

  logger.info('ENGINE', `━━━ [${symbol}] Strateji Analizi Başlıyor ━━━`);

  // ─── Adım 1: HTF Filtre ──────────────────────────────────
  const htfResult = runHTFFilter(htfCandles);
  logHTFFilter(symbol, htfResult);

  if (htfResult.bias === 'NEUTRAL') {
    return noSignal(htfResult.reason, 'HTF_FILTER');
  }

  const direction = htfResult.bias === 'BULLISH' ? 'LONG' : 'SHORT';
  const fvgDirection = htfResult.bias;

  // ─── Adım 2: LTF Market Structure + MSS ──────────────────
  const ltfStructure = analyzeMarketStructure(ltfCandles, 5, 5);
  logMarketStructure(symbol, ltfStructure);

  // MSS onayı gerekli
  if (!ltfStructure.lastMSS) {
    return noSignal(`[${symbol}] 15m'de MSS (yapı kırılması) algılanmadı. Bekleniyor...`, 'MSS_CHECK');
  }

  // MSS yönü HTF ile uyumlu olmalı
  if (ltfStructure.lastMSS.type !== htfResult.bias) {
    return noSignal(
      `[${symbol}] MSS yönü (${ltfStructure.lastMSS.type}) HTF ile uyumsuz (${htfResult.bias}). Bekleniyor...`,
      'MSS_DIRECTION'
    );
  }

  if (!ltfStructure.lastMSS.confirmed) {
    return noSignal(`[${symbol}] MSS henüz onaylanmadı (close ile kırılma bekleniyor).`, 'MSS_CONFIRM');
  }

  logger.info('ENGINE', `[${symbol}] ✅ MSS onaylandı: ${ltfStructure.lastMSS.type} @ ${logger.formatUSD(ltfStructure.lastMSS.price)}`);

  // ─── Adım 3: FVG & Breaker Block Tespiti ─────────────────
  logFVGStatus(symbol, ltfCandles);
  logBreakerBlockStatus(symbol, ltfCandles);

  const currentPrice = ltfCandles[ltfCandles.length - 1]!.close;

  // FVG arama — Kural: Eski FVG'leri tutma, en son oluşan geçerli yapıyı takip et
  const targetFVG = getLatestActiveFVG(ltfCandles, fvgDirection, 25) ?? getNearestActiveFVG(ltfCandles, currentPrice, fvgDirection);

  // Breaker Block arama — En son oluşan aktif Breaker Block
  const targetBreaker = getLatestActiveBreakerBlock(ltfCandles, fvgDirection, 25);

  // ─── Adım 4: Mitigation — fiyat bölgede mi? ──────────────
  let entryPrice: number | null = null;
  let triggerType: 'FVG' | 'BREAKER_BLOCK' = 'FVG';
  let zoneEdge: number = 0;
  let confidence = 0.5;

  // Öncelik 1: FVG + Breaker confluence
  if (targetFVG && targetBreaker && hasConfluence(targetFVG.low, targetFVG.high, targetBreaker.low, targetBreaker.high)) {
    if (isPriceInFVG(currentPrice, targetFVG) || isPriceInBreakerBlock(currentPrice, targetBreaker)) {
      entryPrice = targetFVG.midpoint;
      triggerType = 'FVG';
      zoneEdge = direction === 'LONG' ? targetFVG.low : targetFVG.high;
      confidence = 0.85;  // Yüksek güven — iki bölge örtüşüyor
      logger.info('ENGINE', `[${symbol}] 🎯 CONFLUENCE! FVG + Breaker örtüşüyor. Güven: ${(confidence * 100).toFixed(0)}%`);
    }
  }

  // Öncelik 2: Sadece FVG
  if (!entryPrice && targetFVG) {
    if (isPriceInFVG(currentPrice, targetFVG)) {
      entryPrice = targetFVG.midpoint;
      triggerType = 'FVG';
      zoneEdge = direction === 'LONG' ? targetFVG.low : targetFVG.high;
      confidence = 0.65;
      logger.info('ENGINE', `[${symbol}] 📐 Fiyat FVG bölgesinde: ${logger.formatUSD(targetFVG.low)} — ${logger.formatUSD(targetFVG.high)}`);
    } else {
      // Fiyat henüz FVG'ye gelmedi — pusu kurulabilir
      entryPrice = targetFVG.midpoint;
      triggerType = 'FVG';
      zoneEdge = direction === 'LONG' ? targetFVG.low : targetFVG.high;
      confidence = 0.55;
      logger.info('ENGINE', `[${symbol}] 📐 FVG pusu: ${logger.formatUSD(targetFVG.midpoint)} (fiyat henüz gelmedi)`);
    }
  }

  // Öncelik 3: Sadece Breaker Block
  if (!entryPrice && targetBreaker) {
    if (isPriceInBreakerBlock(currentPrice, targetBreaker)) {
      entryPrice = (targetBreaker.high + targetBreaker.low) / 2;
      triggerType = 'BREAKER_BLOCK';
      zoneEdge = direction === 'LONG' ? targetBreaker.low : targetBreaker.high;
      confidence = 0.6;
      logger.info('ENGINE', `[${symbol}] 🧱 Fiyat Breaker bölgesinde: ${logger.formatUSD(targetBreaker.low)} — ${logger.formatUSD(targetBreaker.high)}`);
    }
  }

  // Hiçbir bölge bulunamadı
  if (!entryPrice) {
    return noSignal(`[${symbol}] Aktif FVG veya Breaker Block bulunamadı. Bekleniyor...`, 'ZONE_SEARCH');
  }

  // ─── Adım 5: SL Hesaplama ────────────────────────────────
  const stopLoss = calculateStopLoss(
    ltfCandles, entryPrice, direction, zoneEdge, constraints.tickSize,
  );

  if (stopLoss === null) {
    return noSignal(`[${symbol}] SL hesaplanamadı.`, 'SL_CALC');
  }

  // ─── Adım 6: R:R Ön Kontrol ──────────────────────────────
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const tp1Distance = stopDistance * config.tp1RR;
  const tp2Distance = stopDistance * config.tp2RR;

  const tp1 = direction === 'LONG' ? entryPrice + tp1Distance : entryPrice - tp1Distance;
  const tp2 = direction === 'LONG' ? entryPrice + tp2Distance : entryPrice - tp2Distance;

  // Kaba R:R kontrolü (efektif hesap position_sizer/take_profit'te yapılacak)
  const avgRR = (config.tp1RR * 0.5 + config.tp2RR * 0.5);
  if (avgRR < config.minRRRatio) {
    logger.warn('ENGINE', `[${symbol}] Sinyal reddedildi: Beklenen RR ${config.minRRRatio}, Bulunan RR ${avgRR.toFixed(2)}`);
    return noSignal(`[${symbol}] Sinyal reddedildi: Beklenen RR ${config.minRRRatio}, Bulunan RR ${avgRR.toFixed(2)}`, 'RR_CHECK');
  }

  // ─── ✅ Sinyal Oluştur ────────────────────────────────────
  const signal: TradeSignal = {
    symbol,
    direction,
    entryPrice,
    stopLoss,
    takeProfit1: tp1,
    takeProfit2: tp2,
    htfBias: htfResult.bias,
    triggerType,
    confidence,
    reason: `${htfResult.bias} HTF → ${ltfStructure.lastMSS.type} MSS → ${triggerType} @ ${entryPrice.toFixed(2)}`,
  };

  logger.separator();
  logger.info('ENGINE', `[${symbol}] 🚀 SİNYAL OLUŞTU!`);
  playSound('SIGNAL');
  logger.info('ENGINE', `  Yön: ${direction} | Tetik: ${triggerType} | Güven: ${(confidence * 100).toFixed(0)}%`);
  logger.info('ENGINE', `  Giriş: ${logger.formatUSD(entryPrice)} | SL: ${logger.formatUSD(stopLoss)} | TP1: ${logger.formatUSD(tp1)} | TP2: ${logger.formatUSD(tp2)}`);
  logger.info('ENGINE', `  Sebep: ${signal.reason}`);
  logger.separator();

  return { signal, reason: signal.reason, step: 'SIGNAL_GENERATED' };
}
