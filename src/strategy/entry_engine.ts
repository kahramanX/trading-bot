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
import { calculateATR } from '../utils/candle_utils.js';
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

  logger.info('ENGINE', `━━━ [${symbol}] Starting Strategy Analysis ━━━`);

  // ─── Adım 0: Session Killzones (Time Filter) ─────────────
  const lastCandle = ltfCandles[ltfCandles.length - 1]!;
  
  // Format the UTC timestamp to HH:mm in the configured timezone
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.allowedSessions.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const currentHHMM = formatter.format(new Date(lastCandle.timestamp));

  const isWithinSession = (time: string, bounds: {start: string, end: string}) => {
    return time >= bounds.start && time <= bounds.end;
  };

  const inLondon = isWithinSession(currentHHMM, config.allowedSessions.london);
  const inNY = isWithinSession(currentHHMM, config.allowedSessions.ny);

  if (!inLondon && !inNY) {
    return noSignal(`[${symbol}] Out of session (${currentHHMM}). Only London/NY allowed.`, 'SESSION_FILTER');
  }

  // ─── Adım 1: HTF Filtre ──────────────────────────────────
  const htfResult = runHTFFilter(htfCandles, config, config.htfTimeframe);
  logHTFFilter(symbol, htfResult);

  if (htfResult.bias === 'NEUTRAL') {
    return noSignal(htfResult.reason, 'HTF_FILTER');
  }

  const direction = htfResult.bias === 'BULLISH' ? 'LONG' : 'SHORT';
  const fvgDirection = htfResult.bias;

  // C-02 FIX: Spot piyasada SHORT desteklenmez
  if (config.marketType === 'spot' && direction === 'SHORT') {
    return noSignal(`[${symbol}] SHORT not supported in spot market. Signal skipped.`, 'SPOT_SHORT_BLOCK');
  }

  // ─── Adım 2: LTF Market Structure + MSS ──────────────────
  const ltfStructure = analyzeMarketStructure(ltfCandles, 5, 5);
  logMarketStructure(symbol, ltfStructure);

  // MSS onayı gerekli
  if (!ltfStructure.lastMSS) {
    return noSignal(`[${symbol}] No MSS detected in ${config.ltfTimeframe}. Waiting...`, 'MSS_CHECK');
  }

  // MSS yönü HTF ile uyumlu olmalı
  if (ltfStructure.lastMSS.type !== htfResult.bias) {
    return noSignal(
      `[${symbol}] MSS direction (${ltfStructure.lastMSS.type}) conflicts with HTF (${htfResult.bias}). Waiting...`,
      'MSS_DIRECTION'
    );
  }

  if (!ltfStructure.lastMSS.confirmed) {
    return noSignal(`[${symbol}] MSS not yet confirmed (waiting for candle close).`, 'MSS_CONFIRM');
  }

  logger.info('ENGINE', `[${symbol}] ✅ MSS confirmed: ${ltfStructure.lastMSS.type} @ ${logger.formatUSD(ltfStructure.lastMSS.price)}`);

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
      logger.info('ENGINE', `[${symbol}] 🎯 CONFLUENCE! FVG + Breaker overlap. Confidence: ${(confidence * 100).toFixed(0)}%`);
    }
  }

  // Öncelik 2: Sadece FVG
  if (!entryPrice && targetFVG) {
    if (isPriceInFVG(currentPrice, targetFVG)) {
      entryPrice = targetFVG.midpoint;
      triggerType = 'FVG';
      zoneEdge = direction === 'LONG' ? targetFVG.low : targetFVG.high;
      confidence = 0.65;
      logger.info('ENGINE', `[${symbol}] 📐 Price is in FVG zone: ${logger.formatUSD(targetFVG.low)} — ${logger.formatUSD(targetFVG.high)}`);
    } else {
      // L-01 FIX: Fiyat FVG'ye gelmedi — proximity (yakınlık) kontrolü yap
      const atr = calculateATR(ltfCandles) ?? 0;
      const distanceToFVG = Math.abs(currentPrice - targetFVG.midpoint);
      const maxDistance = atr * 3; // ATR(14) × 3'ten uzaksa çok uzak

      if (atr > 0 && distanceToFVG > maxDistance) {
        return noSignal(
          `[${symbol}] FVG too far: distance ${distanceToFVG.toFixed(2)} > ATR×3 (${maxDistance.toFixed(2)}). Ambush skipped.`,
          'FVG_TOO_FAR'
        );
      }

      entryPrice = targetFVG.midpoint;
      triggerType = 'FVG';
      zoneEdge = direction === 'LONG' ? targetFVG.low : targetFVG.high;
      confidence = 0.55;
      logger.info('ENGINE', `[${symbol}] 📐 FVG ambush: ${logger.formatUSD(targetFVG.midpoint)} (price hasn't reached yet)`);
    }
  }

  // Öncelik 3: Sadece Breaker Block
  if (!entryPrice && targetBreaker) {
    if (isPriceInBreakerBlock(currentPrice, targetBreaker)) {
      entryPrice = (targetBreaker.high + targetBreaker.low) / 2;
      triggerType = 'BREAKER_BLOCK';
      zoneEdge = direction === 'LONG' ? targetBreaker.low : targetBreaker.high;
      confidence = 0.6;
      logger.info('ENGINE', `[${symbol}] 🧱 Price is in Breaker zone: ${logger.formatUSD(targetBreaker.low)} — ${logger.formatUSD(targetBreaker.high)}`);
    }
  }

  // Hiçbir bölge bulunamadı
  if (!entryPrice) {
    return noSignal(`[${symbol}] No active FVG or Breaker Block found. Waiting...`, 'ZONE_SEARCH');
  }

  // ─── Adım 5: SL Hesaplama ────────────────────────────────
  const stopLoss = calculateStopLoss(
    ltfCandles, entryPrice, direction, zoneEdge, constraints.tickSize,
  );

  if (stopLoss === null) {
    return noSignal(`[${symbol}] SL could not be calculated.`, 'SL_CALC');
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
    logger.warn('ENGINE', `[${symbol}] Signal rejected: Expected RR ${config.minRRRatio}, Found RR ${avgRR.toFixed(2)}`);
    return noSignal(`[${symbol}] Signal rejected: Expected RR ${config.minRRRatio}, Found RR ${avgRR.toFixed(2)}`, 'RR_CHECK');
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
  logger.info('ENGINE', `[${symbol}] 🚀 SIGNAL GENERATED!`);
  playSound('SIGNAL');
  logger.info('ENGINE', `  Direction: ${direction} | Trigger: ${triggerType} | Confidence: ${(confidence * 100).toFixed(0)}%`);
  logger.info('ENGINE', `  Entry: ${logger.formatUSD(entryPrice)} | SL: ${logger.formatUSD(stopLoss)} | TP1: ${logger.formatUSD(tp1)} | TP2: ${logger.formatUSD(tp2)}`);
  logger.info('ENGINE', `  Reason: ${signal.reason}`);
  logger.separator();

  return { signal, reason: signal.reason, step: 'SIGNAL_GENERATED' };
}
