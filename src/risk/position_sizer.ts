// ══════════════════════════════════════════════════════════════
// position_sizer.ts — Dinamik Pozisyon Büyüklüğü (Multi-Pair)
// Her coin'in kendi hassasiyeti (stepSize, tickSize, minNotional)
// ile hesaplama yapılır. $5 kuralı zarif reddetme.
// ══════════════════════════════════════════════════════════════

import type {
  PositionSizeResult,
  BotConfig,
  TradeDirection,
  SymbolConstraints,
} from '../utils/types.js';
import { calculateTradeCosts } from './cost_calculator.js';
import { floorToStepSize, roundToTickSize } from '../utils/candle_utils.js';
import { logger } from '../utils/logger.js';

/**
 * Dinamik pozisyon büyüklüğü hesaplar.
 * Formül: (balance × %risk - costs) / SL distance
 * Her coin'in LOT_SIZE/MIN_NOTIONAL/PRICE_FILTER kuralları otomatik uygulanır.
 */
export function calculatePositionSize(
  balance: number,
  entryPrice: number,
  stopLoss: number,
  direction: TradeDirection,
  config: BotConfig,
  constraints: SymbolConstraints,
): PositionSizeResult {

  const riskAmount = balance * (config.riskPerTradePct / 100);

  const stopDistance = direction === 'LONG'
    ? entryPrice - stopLoss
    : stopLoss - entryPrice;

  if (stopDistance <= 0) {
    return rejectPosition(riskAmount, 0, stopDistance,
      `[${constraints.symbol}] Geçersiz SL mesafesi: ${stopDistance.toFixed(2)}. ` +
      `${direction} için SL, giriş fiyatının ${direction === 'LONG' ? 'altında' : 'üstünde'} olmalı.`);
  }

  // Gerçek (Kesin) quantity hesabı — cebirsel yaklaşım
  const makerFee = config.makerFeePct / 100;
  const takerFee = config.takerFeePct / 100;
  const slippagePerUnit = constraints.tickSize * config.slippageTicks;

  // Birim başına maliyet (Komisyon + Kayma)
  const costPerUnit = (entryPrice * makerFee) + (stopLoss * takerFee) + slippagePerUnit;
  const totalLossPerUnit = stopDistance + costPerUnit;

  let quantity = riskAmount / totalLossPerUnit;
  quantity = floorToStepSize(quantity, constraints.stepSize);

  if (quantity < constraints.minQty) {
    return rejectPosition(riskAmount, 0, stopDistance,
      `[${constraints.symbol}] Hesaplanan miktar (${quantity}) minimum lot büyüklüğünün (${constraints.minQty}) altında.`);
  }

  // Fiyat coin'in tickSize'ına göre yuvarlanır
  const adjustedEntry = roundToTickSize(entryPrice, constraints.tickSize);
  const positionValue = quantity * adjustedEntry;

  // $5 / MIN_NOTIONAL kontrolü — throw yerine zarif reddetme
  const effectiveMinNotional = Math.max(constraints.minNotional, 5);
  if (positionValue < effectiveMinNotional) {
    const reason = positionValue < 5
      ? `[${constraints.symbol}] İşlem reddedildi ($5 kuralı): Pozisyon değeri ${logger.formatUSD(positionValue)} < $5 minimum.`
      : `[${constraints.symbol}] İşlem reddedildi (MIN_NOTIONAL): Pozisyon değeri ${logger.formatUSD(positionValue)} < ${logger.formatUSD(constraints.minNotional)} minimum.`;
    return rejectPosition(riskAmount, costPerUnit * quantity, stopDistance, reason);
  }

  // Futures için Marjin (Kasa) Yeterliliği Kontrolü
  const leverage = config.marketType === 'futures' ? config.leverage : 1;
  const marginRequired = positionValue / leverage;
  if (marginRequired > balance) {
    return rejectPosition(riskAmount, costPerUnit * quantity, stopDistance,
      `[${constraints.symbol}] İşlem reddedildi (Yetersiz Bakiye): Gerekli marjin ${logger.formatUSD(marginRequired)} > Kasa ${logger.formatUSD(balance)}. (Kaldıraç: ${leverage}x)`);
  }

  // Nihai maliyet hesaplama (gerçek quantity ile)
  const finalCosts = calculateTradeCosts(
    adjustedEntry, stopLoss, quantity, direction, config, constraints,
  );

  const result: PositionSizeResult = {
    quantity,
    positionValue,
    riskAmount,
    riskPercent: config.riskPerTradePct,
    stopDistance,
    totalCosts: finalCosts,
    isValid: true,
  };

  logPositionSize(result, balance, adjustedEntry, stopLoss, constraints.symbol);
  return result;
}

function rejectPosition(
  riskAmount: number,
  totalCost: number,
  stopDistance: number,
  reason: string,
): PositionSizeResult {
  logger.warn('SIZE', reason);
  return {
    quantity: 0,
    positionValue: 0,
    riskAmount,
    riskPercent: 0,
    stopDistance,
    totalCosts: {
      entryCommission: 0, exitCommission: 0, slippageCost: 0,
      totalCost, effectiveEntry: 0, effectiveExit: 0,
    },
    isValid: false,
    rejectReason: reason,
  };
}

function logPositionSize(
  result: PositionSizeResult,
  balance: number,
  entryPrice: number,
  stopLoss: number,
  symbol: string,
): void {
  logger.info('RISK', `[${symbol}] Balance: ${logger.formatUSD(balance)} | ` +
    `${logger.formatPct(result.riskPercent)} Risk = ${logger.formatUSD(result.riskAmount)} | ` +
    `Cost: ${logger.formatUSD(result.totalCosts.totalCost)} | ` +
    `Net Risk: ${logger.formatUSD(result.riskAmount - result.totalCosts.totalCost)}`);

  logger.info('SIZE', `[${symbol}] SL Distance: ${logger.formatUSD(result.stopDistance)} | ` +
    `Quantity: ${result.quantity} | Position: ${logger.formatUSD(result.positionValue)}`);
}
