// ══════════════════════════════════════════════════════════════
// take_profit.ts — Kademeli TP (%50/%50) + R:R Kontrolü
// TP1: %50 @ 1:2 | TP2: kalan %50 @ 1:3
// Efektif R:R komisyon+kayma dahil hesaplanır.
// ══════════════════════════════════════════════════════════════

import type { BotConfig, TradeDirection, SymbolConstraints } from '../utils/types.js';
import { calculateTradeCosts } from './cost_calculator.js';
import { roundToTickSize } from '../utils/candle_utils.js';
import { logger } from '../utils/logger.js';

export interface TakeProfitLevels {
  tp1Price: number;
  tp2Price: number;
  tp1Quantity: number;
  tp2Quantity: number;
  riskRewardTP1: number;
  riskRewardTP2: number;
  isValid: boolean;
  rejectReason?: string;
}

export function calculateTakeProfitLevels(
  entryPrice: number,
  stopLoss: number,
  quantity: number,
  direction: TradeDirection,
  config: BotConfig,
  constraints: SymbolConstraints,
): TakeProfitLevels {
  const stopDistance = direction === 'LONG'
    ? entryPrice - stopLoss
    : stopLoss - entryPrice;

  if (stopDistance <= 0) {
    return {
      tp1Price: 0, tp2Price: 0, tp1Quantity: 0, tp2Quantity: 0,
      riskRewardTP1: 0, riskRewardTP2: 0, isValid: false,
      rejectReason: 'Geçersiz SL mesafesi',
    };
  }

  let tp1Price = direction === 'LONG'
    ? entryPrice + (stopDistance * config.tp1RR)
    : entryPrice - (stopDistance * config.tp1RR);

  let tp2Price = direction === 'LONG'
    ? entryPrice + (stopDistance * config.tp2RR)
    : entryPrice - (stopDistance * config.tp2RR);

  tp1Price = roundToTickSize(tp1Price, constraints.tickSize);
  tp2Price = roundToTickSize(tp2Price, constraints.tickSize);

  // %50/%50 dağılım — coin'in stepSize'ına uygun
  const tp1Quantity = Math.floor((quantity / 2) / constraints.stepSize) * constraints.stepSize;
  const tp2Quantity = quantity - tp1Quantity;

  // Efektif R:R (maliyetler dahil)
  const tp1Costs = calculateTradeCosts(entryPrice, tp1Price, tp1Quantity, direction, config, constraints, 'TP');
  const tp2Costs = calculateTradeCosts(entryPrice, tp2Price, tp2Quantity, direction, config, constraints, 'TP');
  const slCosts = calculateTradeCosts(entryPrice, stopLoss, quantity, direction, config, constraints, 'SL');

  const effectiveRisk = direction === 'LONG'
    ? (slCosts.effectiveEntry - slCosts.effectiveExit)
    : (slCosts.effectiveExit - slCosts.effectiveEntry);

  const effectiveTP1 = direction === 'LONG'
    ? (tp1Costs.effectiveExit - tp1Costs.effectiveEntry)
    : (tp1Costs.effectiveEntry - tp1Costs.effectiveExit);

  const effectiveTP2 = direction === 'LONG'
    ? (tp2Costs.effectiveExit - tp2Costs.effectiveEntry)
    : (tp2Costs.effectiveEntry - tp2Costs.effectiveExit);

  const riskRewardTP1 = effectiveRisk > 0 ? effectiveTP1 / effectiveRisk : 0;
  const riskRewardTP2 = effectiveRisk > 0 ? effectiveTP2 / effectiveRisk : 0;
  const weightedRR = (riskRewardTP1 * 0.5) + (riskRewardTP2 * 0.5);

  if (weightedRR < config.minRRRatio) {
    const reason = `[${constraints.symbol}] Efektif R:R (${weightedRR.toFixed(2)}) < minimum (1:${config.minRRRatio}). İşlem reddedildi.`;
    logger.warn('RISK', reason);
    return {
      tp1Price, tp2Price, tp1Quantity, tp2Quantity,
      riskRewardTP1, riskRewardTP2, isValid: false, rejectReason: reason,
    };
  }

  logger.info('RISK', `[${constraints.symbol}] TP1: ${logger.formatUSD(tp1Price)} (R:R ${riskRewardTP1.toFixed(2)}) — %50 (${tp1Quantity})`);
  logger.info('RISK', `[${constraints.symbol}] TP2: ${logger.formatUSD(tp2Price)} (R:R ${riskRewardTP2.toFixed(2)}) — %50 (${tp2Quantity})`);
  logger.info('RISK', `[${constraints.symbol}] Ağırlıklı R:R: ${weightedRR.toFixed(2)} ✅ | TP1 hit → SL Break-Even`);

  return {
    tp1Price, tp2Price, tp1Quantity, tp2Quantity,
    riskRewardTP1, riskRewardTP2, isValid: true,
  };
}
