// ══════════════════════════════════════════════════════════════
// cost_calculator.ts — Komisyon + Slippage Maliyet Motoru
// "Görünmeyen maliyetleri" hesaplar. Gerçek dünyada kârlı görünen
// işlemlerin komisyon+kayma sonrası zararda olup olmayacağını ortaya koyar.
// ══════════════════════════════════════════════════════════════

import type { TradeCosts, BotConfig, TradeDirection, SymbolConstraints } from '../utils/types.js';
import { logger } from '../utils/logger.js';

/**
 * Bir işlemin toplam maliyetini hesaplar.
 * Komisyon (maker/taker) + slippage dahil.
 *
 * @param entryPrice   - Hedef giriş fiyatı
 * @param exitPrice    - Hedef çıkış fiyatı (SL veya TP)
 * @param quantity     - İşlem miktarı (coin)
 * @param direction    - İşlem yönü (LONG veya SHORT)
 * @param config       - Bot konfigürasyonu (komisyon oranları)
 * @param constraints  - Sembol kısıtlamaları (tickSize)
 * @returns TradeCosts  - Detaylı maliyet analizi
 */
export function calculateTradeCosts(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  direction: TradeDirection,
  config: BotConfig,
  constraints: SymbolConstraints,
  exitType: 'SL' | 'TP' = 'SL',
): TradeCosts {
  // ─── Pozisyon Değerleri ───────────────────────────────────
  const entryValue = entryPrice * quantity;
  const exitValue = exitPrice * quantity;

  // ─── Komisyon Hesaplama ───────────────────────────────────
  // Giriş: Limit emir (Maker) — pusu kuruyoruz
  const entryCommission = entryValue * (config.makerFeePct / 100);

  // Çıkış: SL = Market emir (Taker), TP = Limit emir (Maker)
  const exitCommission = exitType === 'SL'
    ? exitValue * (config.takerFeePct / 100)
    : exitValue * (config.makerFeePct / 100);

  // ─── Slippage (Fiyat Kayması) Hesaplama ───────────────────
  // Slippage sadece market emirlerde (SL tetiklendiğinde) oluşur
  // Limit emirlerde (giriş ve TP) slippage yok
  const slippagePerUnit = exitType === 'SL' ? (constraints.tickSize * config.slippageTicks) : 0;
  const slippageCost = slippagePerUnit * quantity;

  // ─── Toplam Maliyet ──────────────────────────────────────
  const totalCost = entryCommission + exitCommission + slippageCost;

  // ─── Efektif Fiyatlar ────────────────────────────────────
  // Maliyetler dahil edildiğinde gerçek giriş/çıkış fiyatları
  let effectiveEntry: number;
  let effectiveExit: number;

  if (direction === 'LONG') {
    // LONG: Komisyon+kayma giriş fiyatını artırır, çıkış fiyatını düşürür
    effectiveEntry = entryPrice + (entryCommission / quantity);
    effectiveExit = exitPrice - (exitCommission / quantity) - slippagePerUnit;
  } else {
    // SHORT: Komisyon+kayma giriş fiyatını düşürür, çıkış fiyatını artırır
    effectiveEntry = entryPrice - (entryCommission / quantity);
    effectiveExit = exitPrice + (exitCommission / quantity) + slippagePerUnit;
  }

  return {
    entryCommission,
    exitCommission,
    slippageCost,
    totalCost,
    effectiveEntry,
    effectiveExit,
  };
}

/**
 * Logs cost details to the terminal.
 */
export function logCostBreakdown(costs: TradeCosts, entryPrice: number, exitPrice: number): void {
  logger.info('RISK', `Cost Analysis:`);
  logger.info('RISK', `  Entry Commission: ${logger.formatUSD(costs.entryCommission)} (Maker)`);
  logger.info('RISK', `  Exit Commission:  ${logger.formatUSD(costs.exitCommission)} (Taker/SL scenario)`);
  logger.info('RISK', `  Slippage:         ${logger.formatUSD(costs.slippageCost)}`);
  logger.info('RISK', `  Total Cost:       ${logger.formatUSD(costs.totalCost)}`);
  logger.separator();
  logger.info('RISK', `  Raw Entry:        ${logger.formatUSD(entryPrice)} → Effective: ${logger.formatUSD(costs.effectiveEntry)}`);
  logger.info('RISK', `  Raw Exit:         ${logger.formatUSD(exitPrice)} → Effective: ${logger.formatUSD(costs.effectiveExit)}`);
}

/**
 * Calculates net profit/loss after costs for a trade.
 * Used to verify if R:R is realistic.
 *
 * @returns Net P&L ($) — positive profit, negative loss
 */
export function calculateNetPnL(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  direction: TradeDirection,
  config: BotConfig,
  constraints: SymbolConstraints,
  exitType: 'SL' | 'TP' = 'SL',
): number {
  const costs = calculateTradeCosts(entryPrice, exitPrice, quantity, direction, config, constraints, exitType);

  let grossPnL: number;
  if (direction === 'LONG') {
    grossPnL = (exitPrice - entryPrice) * quantity;
  } else {
    grossPnL = (entryPrice - exitPrice) * quantity;
  }

  return grossPnL - costs.totalCost;
}
