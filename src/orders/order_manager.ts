// ══════════════════════════════════════════════════════════════
// order_manager.ts — Emir Yönetimi (Multi-Pair)
// Her çift kendi aktif işlemini tutar. Ghost emir, partial fill,
// TP1→Break-Even SL yönetimi dahil.
// ══════════════════════════════════════════════════════════════

import type {
  BotConfig,
  TradeSignal,
  ManagedOrder,
  ActiveTrade,
  PositionSizeResult,
  SymbolConstraints,
  Candle,
  CircuitBreakerState,
} from '../utils/types.js';
import type { TakeProfitLevels } from '../risk/take_profit.js';
import { calculateBreakEvenStopLoss } from '../risk/stop_loss.js';
import { calculateNetPnL } from '../risk/cost_calculator.js';
import { playSound } from '../utils/sound_player.js';
import { recordTradeResult } from '../risk/circuit_breaker.js';
import { runHTFFilter } from '../strategy/htf_filter.js';
import { analyzeMarketStructure } from '../strategy/market_structure.js';
import { getExchange, fetchPosition } from '../exchange/binance_client.js';
import { floorToStepSize, roundToTickSize } from '../utils/candle_utils.js';
import { logger } from '../utils/logger.js';
import { saveActiveTrades, loadActiveTrades as loadActiveTradesFromDisk } from './trade_persistence.js';

// Çift bazlı aktif işlemler (Multi-Pair) — diskten yüklenir, her değişiklikte diske yazılır
let activeTrades = new Map<string, ActiveTrade>();

/**
 * Bot başlangıcında diskten aktif işlemleri yükler.
 * index.ts'ten initExchange() sonrası çağrılmalı.
 */
export function initActiveTrades(): void {
  activeTrades = loadActiveTradesFromDisk();
}

export function getActiveTrade(symbol: string): ActiveTrade | null {
  return activeTrades.get(symbol) ?? null;
}

export function hasActiveTrade(symbol: string): boolean {
  return activeTrades.has(symbol);
}

export function getAllActiveTrades(): Map<string, ActiveTrade> {
  return activeTrades;
}

/** activeTrades'e ekle ve diske yaz */
function persistSet(symbol: string, trade: ActiveTrade): void {
  activeTrades.set(symbol, trade);
  saveActiveTrades(activeTrades);
}

/** activeTrades'ten sil ve diske yaz */
function persistDelete(symbol: string): void {
  activeTrades.delete(symbol);
  saveActiveTrades(activeTrades);
}

/**
 * Yeni işlem açar — symbol parametresiyle multi-pair destekli.
 */
export async function openTrade(
  signal: TradeSignal,
  posSize: PositionSizeResult,
  tpLevels: TakeProfitLevels,
  config: BotConfig,
  constraints: SymbolConstraints,
): Promise<void> {
  const symbol = signal.symbol;

  if (activeTrades.has(symbol)) {
    logger.warn('ORDER', `[${symbol}] Active trade already exists. New trade rejected.`);
    return;
  }

  if (!posSize.isValid) {
    logger.warn('ORDER', `[${symbol}] Invalid position: ${posSize.rejectReason}`);
    return;
  }

  if (!tpLevels.isValid) {
    logger.warn('ORDER', `[${symbol}] Invalid TP: ${tpLevels.rejectReason}`);
    return;
  }

  const exchange = getExchange();
  const side = signal.direction === 'LONG' ? 'buy' : 'sell';
  const quantity = posSize.quantity;
  const entryPrice = roundToTickSize(signal.entryPrice, constraints.tickSize);

  // ─── DRY-RUN ─────────────────────────────────────────────
  if (config.dryRun) {
    logger.separator();
    logger.info('ORDER', `🧪 DRY-RUN [${symbol}]: Order NOT SENT`);
    logger.info('ORDER', `  ${side.toUpperCase()} ${quantity} @ ${logger.formatUSD(entryPrice)}`);
    logger.info('ORDER', `  SL: ${logger.formatUSD(signal.stopLoss)} | TP1: ${logger.formatUSD(tpLevels.tp1Price)} | TP2: ${logger.formatUSD(tpLevels.tp2Price)}`);
    logger.info('ORDER', `  Trigger: ${signal.triggerType} | ${signal.reason}`);
    logger.separator();

    persistSet(symbol, createVirtualTrade(signal, quantity, entryPrice, tpLevels));
    return;
  }

  // ─── LIVE ────────────────────────────────────────────────
  try {
    logger.separator();
    logger.info('ORDER', `📤 [${symbol}] Sending LIMIT ${side.toUpperCase()}...`);

    const entryOrder = await exchange.createLimitOrder(symbol, side, quantity, entryPrice);

    const entryManaged: ManagedOrder = {
      id: entryOrder.id ?? '',
      clientOrderId: `entry_${Date.now()}`,
      symbol,
      type: 'ENTRY',
      side,
      price: entryPrice,
      quantity,
      filledQuantity: 0,
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    logger.info('ORDER', `✅ [${symbol}] Entry: ${entryOrder.id} | ${side.toUpperCase()} ${quantity} @ ${logger.formatUSD(entryPrice)}`);

    // 5. Save trade
    persistSet(symbol, {
      signal, constraints, entryOrder,
    } as any);

    logger.info('ORDER', `🛡️ [${symbol}] Waiting for SL order fill.`);

    persistSet(symbol, {
      symbol,
      entryOrder: entryManaged,
      stopLossOrder: undefined, // Until fill
      signal,
      tp1Hit: false,
      breakEvenApplied: false,
      tp1Price: tpLevels.tp1Price,
      tp2Price: tpLevels.tp2Price,
      tp1Quantity: tpLevels.tp1Quantity,
      tp2Quantity: tpLevels.tp2Quantity,
    });

    logger.separator();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('ORDER', `[${symbol}] Order error: ${msg}`);
    await cleanupOrders(symbol);
  }
}

/**
 * Places TP orders. Includes partial fill support.
 */
export async function placeTPOrders(
  symbol: string,
  tpLevels: TakeProfitLevels,
  filledQuantity: number,
  config: BotConfig,
  constraints: SymbolConstraints,
): Promise<void> {
  const trade = activeTrades.get(symbol);
  if (!trade) return;

  const exchange = getExchange();
  const side = trade.signal.direction === 'LONG' ? 'sell' : 'buy';

  // Partial fill — scale quantities
  let tp1Qty: number;
  let tp2Qty: number;

  if (filledQuantity < trade.entryOrder.quantity) {
    const ratio = filledQuantity / trade.entryOrder.quantity;
    tp1Qty = floorToStepSize(tpLevels.tp1Quantity * ratio, constraints.stepSize);
    tp2Qty = floorToStepSize(filledQuantity - tp1Qty, constraints.stepSize);
    logger.warn('FILL', `[${symbol}] Partial fill: ${filledQuantity}/${trade.entryOrder.quantity} (${(ratio * 100).toFixed(1)}%)`);
  } else {
    tp1Qty = tpLevels.tp1Quantity;
    tp2Qty = tpLevels.tp2Quantity;
  }

  if (config.dryRun) {
    logger.info('ORDER', `🧪 DRY-RUN [${symbol}]: TP orders simulated`);
    trade.tp1Order = {
      id: `dry_tp1_${Date.now()}`, clientOrderId: `dry_tp1_${Date.now()}`, symbol,
      type: 'TAKE_PROFIT_1', side, price: tpLevels.tp1Price, quantity: tp1Qty,
      filledQuantity: 0, status: 'OPEN', createdAt: Date.now(), updatedAt: Date.now(),
    };
    trade.tp2Order = {
      id: `dry_tp2_${Date.now()}`, clientOrderId: `dry_tp2_${Date.now()}`, symbol,
      type: 'TAKE_PROFIT_2', side, price: tpLevels.tp2Price, quantity: tp2Qty,
      filledQuantity: 0, status: 'OPEN', createdAt: Date.now(), updatedAt: Date.now(),
    };
    return;
  }

  const minNotional = Math.max(constraints.minNotional, 5);

  try {
    const tpParams: any = {};
    if (config.marketType === 'futures') {
      tpParams.reduceOnly = true;
    }

    if (tp1Qty > 0 && tp1Qty * tpLevels.tp1Price >= minNotional) {
      const tp1Price = roundToTickSize(tpLevels.tp1Price, constraints.tickSize);
      const tp1Order = await exchange.createOrder(symbol, 'limit', side, tp1Qty, tp1Price, tpParams);
      trade.tp1Order = {
        id: tp1Order.id ?? '', clientOrderId: `tp1_${Date.now()}`, symbol,
        type: 'TAKE_PROFIT_1', side, price: tp1Price, quantity: tp1Qty,
        filledQuantity: 0, status: 'OPEN', createdAt: Date.now(), updatedAt: Date.now(),
      };
      logger.info('ORDER', `🎯 [${symbol}] TP1: ${tp1Qty} @ ${logger.formatUSD(tp1Price)}`);
    }

    if (tp2Qty > 0) {
      const tp2Params: any = { reduceOnly: true };
      if (config.marketType === 'spot') tp2Params.timeInForce = 'GTC';
      
      const tp2Order = await exchange.createOrder(
        symbol, 'limit', side, tp2Qty, tpLevels.tp2Price, tp2Params,
      );
      
      trade.tp2Order = {
        id: tp2Order.id ?? '', clientOrderId: `tp2_${Date.now()}`, symbol,
        type: 'TAKE_PROFIT_2', side: side, price: tpLevels.tp2Price, quantity: tp2Qty,
        filledQuantity: 0, status: 'OPEN', createdAt: Date.now(), updatedAt: Date.now(),
      };
      logger.info('ORDER', `🎯 [${symbol}] TP2: ${tp2Qty} @ ${logger.formatUSD(tpLevels.tp2Price)}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('ORDER', `[${symbol}] TP emir hatası: ${msg}`);
  }
}

/**
 * SL emrini yerleştirir veya günceller (Kısmi dolumlar için)
 */
export async function placeSLOrder(
  symbol: string,
  filledQuantity: number,
  config: BotConfig,
  constraints: SymbolConstraints,
): Promise<void> {
  const trade = activeTrades.get(symbol);
  if (!trade) return;

  const exchange = getExchange();
  const slSide = trade.signal.direction === 'LONG' ? 'sell' : 'buy';
  const slPrice = roundToTickSize(trade.signal.stopLoss, constraints.tickSize);

  if (config.dryRun) {
    if (!trade.stopLossOrder) {
      logger.info('ORDER', `🧪 DRY-RUN [${symbol}]: SL simulated @ ${logger.formatUSD(slPrice)}`);
      trade.stopLossOrder = {
        id: `dry_sl_${Date.now()}`, clientOrderId: `dry_sl_${Date.now()}`, symbol,
        type: 'STOP_LOSS', side: slSide, price: slPrice, quantity: filledQuantity,
        filledQuantity: 0, status: 'OPEN', createdAt: Date.now(), updatedAt: Date.now(),
      };
    } else {
      trade.stopLossOrder.quantity = filledQuantity;
    }
    return;
  }

  try {
    // Varsa eski SL'yi iptal et
    if (trade.stopLossOrder?.status === 'OPEN') {
      if (trade.stopLossOrder.quantity === filledQuantity) return; // Zaten güncel
      await cancelSLOrder(symbol, trade.stopLossOrder.id, config);
    }

    let slOrder;
    if (config.marketType === 'futures') {
      // FIX: Futures STOP_MARKET — ccxt unified API: triggerPrice parametresi kullan
      // Not: Bu emir Binance'te "conditional order" olarak oluşturulur.
      // fetchOpenOrders'ta görünmez, cancelOrder yerine cancelAllOrders kullanılmalıdır.
      slOrder = await exchange.createOrder(symbol, 'market', slSide, filledQuantity, undefined, {
        triggerPrice: slPrice,
        reduceOnly: true,
      });
    } else {
      // Spot STOP_LOSS_LIMIT
      const slOffset = constraints.tickSize * (config.slippageTicks + 1);
      let slLimitPrice: number;
      if (trade.signal.direction === 'LONG') {
        slLimitPrice = roundToTickSize(slPrice - slOffset, constraints.tickSize);
      } else {
        slLimitPrice = roundToTickSize(slPrice + slOffset, constraints.tickSize);
      }
      slOrder = await exchange.createOrder(symbol, 'STOP_LOSS_LIMIT', slSide, filledQuantity, slLimitPrice, {
        stopPrice: slPrice,
        timeInForce: 'GTC',
      });
    }

    trade.stopLossOrder = {
      id: slOrder.id ?? '',
      clientOrderId: `sl_${Date.now()}`,
      symbol,
      type: 'STOP_LOSS',
      side: slSide,
      price: slPrice,
      quantity: filledQuantity,
      filledQuantity: 0,
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    logger.info('ORDER', `🛡️ [${symbol}] SL: ${trade.stopLossOrder.id} | ${filledQuantity} lot @ ${logger.formatUSD(slPrice)}`);
    persistSet(symbol, trade);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('ORDER', `[${symbol}] SL order error: ${msg}`);
    // KRİTİK: SL oluşturulamazsa pozisyon korumasız kalır — acil market çıkış yap
    if (!trade.stopLossOrder) {
      logger.error('ORDER', `[${symbol}] ⚠️ FAILED TO CREATE SL ORDER! Position is unprotected. Emergency market exit initiated...`);
      try {
        await exchange.createMarketOrder(symbol, slSide, filledQuantity, undefined, { reduceOnly: true });
        logger.warn('ORDER', `[${symbol}] Position closed via market order (due to SL failure).`);
        clearActiveTrade(symbol);
      } catch (exitErr) {
        const exitMsg = exitErr instanceof Error ? exitErr.message : String(exitErr);
        logger.error('ORDER', `[${symbol}] ⛔ EMERGENCY EXIT ALSO FAILED: ${exitMsg}. MANUAL INTERVENTION REQUIRED!`);
      }
    }
  }
}

/**
 * TP1 dolduğunda SL'yi Break-Even'a taşır.
 */
export async function applyBreakEvenStopLoss(
  symbol: string,
  config: BotConfig,
  constraints: SymbolConstraints,
): Promise<void> {
  const trade = activeTrades.get(symbol);
  if (!trade || trade.breakEvenApplied) return;

  const exchange = getExchange();
  const slSide = trade.signal.direction === 'LONG' ? 'sell' : 'buy';
  const remainingQty = trade.tp2Order?.quantity ?? 0;
  if (remainingQty <= 0) return;

  const breakEvenPrice = calculateBreakEvenStopLoss(
    trade.entryOrder.price, trade.signal.direction, constraints.tickSize, config,
  );

  if (config.dryRun) {
    logger.info('ORDER', `🧪 DRY-RUN [${symbol}]: SL → Break-Even @ ${logger.formatUSD(breakEvenPrice)}`);
    trade.tp1Hit = true;
    trade.breakEvenApplied = true;
    return;
  }

  try {
    if (trade.stopLossOrder?.status === 'OPEN') {
      await cancelSLOrder(symbol, trade.stopLossOrder.id, config);
    }

    let newSlOrder;
    if (config.marketType === 'futures') {
      // FIX: ccxt triggerPrice parametresi ile STOP_MARKET oluştur
      newSlOrder = await exchange.createOrder(symbol, 'market', slSide, remainingQty, undefined, {
        triggerPrice: breakEvenPrice,
        reduceOnly: true,
      });
    } else {
      newSlOrder = await exchange.createOrder(symbol, 'STOP_LOSS_LIMIT', slSide, remainingQty, breakEvenPrice, {
        stopPrice: breakEvenPrice,
        timeInForce: 'GTC',
      });
    }

    trade.stopLossOrder = {
      id: newSlOrder.id ?? '', clientOrderId: `sl_be_${Date.now()}`, symbol,
      type: 'STOP_LOSS', side: slSide, price: breakEvenPrice, quantity: remainingQty,
      filledQuantity: 0, status: 'OPEN', createdAt: Date.now(), updatedAt: Date.now(),
    };

    trade.tp1Hit = true;
    trade.breakEvenApplied = true;
    logger.info('ORDER', `🔄 [${symbol}] SL → Break-Even @ ${logger.formatUSD(breakEvenPrice)}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('ORDER', `[${symbol}] Break-Even error: ${msg}`);
  }
}

/**
 * Ghost emirleri iptal eder.
 * DİKKAT: Sadece giriş emri henüz dolmamışken çağrılmalı.
 */
export async function cancelGhostOrders(symbol: string, config: BotConfig): Promise<void> {
  const trade = activeTrades.get(symbol);
  if (!trade) return;

  const ordersToCancel: ManagedOrder[] = [];
  if (trade.entryOrder.status === 'OPEN') ordersToCancel.push(trade.entryOrder);
  if (trade.stopLossOrder?.status === 'OPEN') ordersToCancel.push(trade.stopLossOrder);
  if (trade.tp1Order?.status === 'OPEN') ordersToCancel.push(trade.tp1Order);
  if (trade.tp2Order?.status === 'OPEN') ordersToCancel.push(trade.tp2Order);

  if (ordersToCancel.length === 0) return;

  if (config.dryRun) {
    logger.info('CANCEL', `🧪 [${symbol}] ${ordersToCancel.length} ghost order cancel simulation`);
    persistDelete(symbol);
    return;
  }

  const exchange = getExchange();
  // FIX: Futures conditional order'lar (STOP_MARKET) cancelOrder ile iptal edilemez.
  // cancelAllOrders tüm açık emirleri (hem normal hem conditional) iptal eder.
  try {
    await exchange.cancelAllOrders(symbol);
    logger.info('CANCEL', `🚫 [${symbol}] All orders cancelled (ghost cancel)`);
  } catch {
    // Fallback: Tek tek dene
    for (const order of ordersToCancel) {
      try {
        await exchange.cancelOrder(order.id, symbol);
        logger.info('CANCEL', `🚫 [${symbol}] ${order.type} cancelled: ${order.id}`);
      } catch {
        logger.debug('CANCEL', `[${symbol}] ${order.id} might already be closed`);
      }
    }
  }

  persistDelete(symbol);
}

/**
 * SL emrini iptal eder.
 * Futures conditional order'lar cancelOrder ile iptal edilemez — cancelAllOrders kullanılır.
 * Ama cancelAllOrders tüm emirleri iptal edeceğinden, SL iptalinden sonra TP emirleri yeniden gönderilmelidir.
 */
async function cancelSLOrder(symbol: string, slOrderId: string, config: BotConfig): Promise<void> {
  const exchange = getExchange();
  try {
    await exchange.cancelOrder(slOrderId, symbol);
  } catch {
    // Conditional order (STOP_MARKET) cancelOrder ile iptal edilemez
    // cancelAllOrders kullan — bu TP'leri de iptal edecek, ama manageActiveTrade
    // döngüsünde TP'ler yeniden gönderilecek (tp1Order/tp2Order undefined olacak)
    logger.debug('ORDER', `[${symbol}] SL ${slOrderId} could not be cancelled with cancelOrder — trying cancelAllOrders`);
    try {
      await exchange.cancelAllOrders(symbol);
      // TP emirlerini de temizle — bir sonraki döngüde yeniden gönderilecek
      const trade = activeTrades.get(symbol);
      if (trade) {
        if (trade.tp1Order) trade.tp1Order = undefined;
        if (trade.tp2Order) trade.tp2Order = undefined;
      }
    } catch (e2) {
      logger.debug('ORDER', `[${symbol}] cancelAllOrders also failed`);
    }
  }
}

/**
 * Açık emirlerin durumunu borsadan senkronize eder.
 * R-02 FIX: Tek fetchOpenOrders() çağrısı ile batch senkronizasyon.
 */
export async function syncOrderStatuses(symbol: string, config: BotConfig): Promise<void> {
  const trade = activeTrades.get(symbol);
  if (!trade || config.dryRun) return;

  const exchange = getExchange();
  const managedOrders = [trade.entryOrder, trade.stopLossOrder, trade.tp1Order, trade.tp2Order]
    .filter((o): o is ManagedOrder => o !== undefined && o.status === 'OPEN');

  if (managedOrders.length === 0) return;

  try {
    // Tek API çağrısı ile tüm açık emirleri al
    const liveOpenOrders = await exchange.fetchOpenOrders(symbol);
    const openOrderIds = new Set(liveOpenOrders.map(o => o.id));

    for (const mo of managedOrders) {
      const prev = mo.status;

      if (openOrderIds.has(mo.id)) {
        // Emir hâlâ açık — filled miktarını güncelle
        const liveOrder = liveOpenOrders.find(o => o.id === mo.id);
        if (liveOrder) {
          mo.filledQuantity = liveOrder.filled ?? 0;
          if ((liveOrder.filled ?? 0) > 0) mo.status = 'PARTIALLY_FILLED';
        }
      } else {
        // Emir artık açık değil — fetchOrder ile kesin durumu al
        try {
          const closedOrder = await exchange.fetchOrder(mo.id, symbol);
          mo.filledQuantity = closedOrder.filled ?? 0;
          if (closedOrder.status === 'closed') mo.status = 'FILLED';
          else if (closedOrder.status === 'canceled') mo.status = 'CANCELLED';
          // FIX: 'expired' durumu — Binance reduceOnly çakışması veya
          // pozisyon kapandığında oluşur. TP emirleri için EXPIRED olarak işaretle.
          else if (closedOrder.status === 'expired') {
            mo.status = 'EXPIRED';
            logger.warn('ORDER', `[${symbol}] ${mo.type} (${mo.id}) EXPIRED! Order expired/rejected by exchange.`);
          }
        } catch (e: any) {
          if (e.message?.includes('-2013') || e.message?.includes('Order does not exist')) {
            // FIX: Futures STOP_MARKET emirleri conditional order tablosunda olduğundan
            // fetchOrder ile bulunamaz. SL emri için bu normal bir durum.
            if (mo.type === 'STOP_LOSS') {
              logger.debug('ORDER', `[${symbol}] SL ${mo.id} conditional order — cannot be fetched via fetchOrder. Assuming OPEN.`);
              // SL conditional order'ı fetchOrder ile takip edemiyoruz.
              // Durumunu değiştirmiyoruz — 'OPEN' olarak kalacak.
            } else {
              logger.debug('ORDER', `[${symbol}] ${mo.id} not found on exchange. Assuming triggered.`);
              mo.status = mo.type === 'ENTRY' ? 'CANCELLED' : 'FILLED';
            }
          } else {
            logger.debug('ORDER', `[${symbol}] Could not query status for ${mo.id}: ${e.message}`);
          }
        }
      }

      mo.updatedAt = Date.now();
      if (mo.status !== prev) {
        logger.info('FILL', `[${symbol}] ${mo.type}: ${prev} → ${mo.status} (${mo.filledQuantity}/${mo.quantity})`);
        if (mo.type === 'ENTRY' && mo.status === 'FILLED') playSound('ORDER');
      }
    }

    // Durum değişikliğini diske yaz
    saveActiveTrades(activeTrades);
  } catch (e: any) {
    logger.debug('ORDER', `[${symbol}] Order sync failed: ${e.message}`);
  }
}

export function clearActiveTrade(symbol: string): void {
  persistDelete(symbol);
}

async function cleanupOrders(symbol: string): Promise<void> {
  const exchange = getExchange();
  try {
    const open = await exchange.fetchOpenOrders(symbol);
    for (const o of open) {
      await exchange.cancelOrder(o.id!, symbol);
    }
  } catch { /* ignore */ }
  persistDelete(symbol);
}

function createVirtualTrade(
  signal: TradeSignal,
  quantity: number,
  entryPrice: number,
  tpLevels?: TakeProfitLevels,
): ActiveTrade {
  return {
    symbol: signal.symbol,
    entryOrder: {
      id: `dry_entry_${Date.now()}`, clientOrderId: `dry_entry_${Date.now()}`, symbol: signal.symbol,
      type: 'ENTRY', side: signal.direction === 'LONG' ? 'buy' : 'sell',
      price: entryPrice, quantity, filledQuantity: 0, status: 'OPEN',
      createdAt: Date.now(), updatedAt: Date.now(),
    },
    stopLossOrder: undefined, // SL emri baştan konulmuyor
    signal,
    tp1Hit: false,
    breakEvenApplied: false,
    tp1Price: tpLevels?.tp1Price,
    tp2Price: tpLevels?.tp2Price,
    tp1Quantity: tpLevels?.tp1Quantity,
    tp2Quantity: tpLevels?.tp2Quantity,
  };
}

/**
 * Aktif işlemi ve emir durumlarını yönetir.
 * - ccxt üzerinden emir durumlarını senkronize eder.
 * - Ghost emir kontrolü: Limit giriş emri henüz dolmadan HTF trendi veya LTF yapısı bozulduysa iptal eder.
 * - Dry-run modunda mum verisine göre fill ve SL/TP tetiklenmelerini simüle eder.
 * - TP1 dolduğunda SL'yi Break-Even'a taşır.
 * - TP2 veya SL dolduğunda işlemi kapatır ve sonucu Circuit Breaker'a kaydeder.
 */
export async function manageActiveTrade(
  symbol: string,
  htfCandles: Candle[],
  ltfCandles: Candle[],
  config: BotConfig,
  constraints: SymbolConstraints,
  cbState: CircuitBreakerState,
): Promise<void> {
  const trade = activeTrades.get(symbol);
  if (!trade) return;

  // 1. Canlı modda emir durumlarını güncelle
  await syncOrderStatuses(symbol, config);

  const lastCandle = ltfCandles[ltfCandles.length - 1];
  if (!lastCandle) return;

  // 1.5 Gerçek Pozisyon Doğrulaması (True Position Sync)
  // Bu kontrol, SL emrinin Binance'te "Conditional Order" olması ve tetiklendiğinde fetchOrder'da bulunamaması
  // (Order does not exist) sorununu çözer. Borsadaki gerçek pozisyon sıfırlanmışsa işlem kapanmıştır!
  if (!config.dryRun && (trade.entryOrder.status === 'FILLED' || trade.entryOrder.status === 'PARTIALLY_FILLED')) {
    try {
      const actualPosSize = await fetchPosition(symbol, config.marketType);
      
      if (actualPosSize < constraints.minQty) {
        logger.warn('ORDER', `[${symbol}] 🚨 Actual position size is 0! Trade was closed externally (SL hit, Liquidated, or Manual Close).`);
        
        // 1. Kalan açık emirleri (TP, varsa hayalet emirleri) temizle
        await cancelGhostOrders(symbol, config);
        
        // 2. İşlemi SL olarak (veya harici çıkış) kaydet
        const exitPrice = trade.stopLossOrder?.price ?? lastCandle.close;
        const totalQty = trade.entryOrder.filledQuantity || trade.entryOrder.quantity;
        const pnl = calculateNetPnL(trade.entryOrder.price, exitPrice, totalQty, trade.signal.direction, config, constraints);
        
        playSound(pnl > 0 ? 'PROFIT' : 'LOSS');
        
        recordTradeResult(cbState, {
          timestamp: Date.now(),
          symbol,
          direction: trade.signal.direction,
          entryPrice: trade.entryOrder.price,
          exitPrice,
          quantity: totalQty,
          pnl,
          isWin: pnl > 0,
          exitReason: 'EXTERNAL',
        }, config);
        
        // 3. Botu temizle
        clearActiveTrade(symbol);
        logger.separator();
        return;
      }
    } catch (err: any) {
      logger.debug('ORDER', `[${symbol}] fetchPosition error during verification: ${err.message}`);
    }
  }

  // 2. Durum: Giriş Emri Henüz Açık (Beklemede)
  if (trade.entryOrder.status === 'OPEN') {
    // FIX: Ghost cancel güvenlik kontrolü — Entry gerçekten açık mı?
    // syncOrderStatuses başarısız olmuş olabilir ve entry aslında dolmuş olabilir.
    // Borsadan entry'nin gerçek durumunu doğrudan kontrol et.
    if (!config.dryRun) {
      try {
        const exchange = getExchange();
        const realEntry = await exchange.fetchOrder(trade.entryOrder.id, symbol);
        if (realEntry.status === 'closed') {
          logger.info('FILL', `[${symbol}] Entry actually filled! (syncOrderStatuses missed it)`);
          trade.entryOrder.status = 'FILLED';
          trade.entryOrder.filledQuantity = realEntry.filled ?? trade.entryOrder.quantity;
          trade.entryOrder.updatedAt = Date.now();
          playSound('ORDER');
          persistSet(symbol, trade);
          // Aşağıdaki ghost cancel'a GİRME — entry dolmuş, pozisyon yönetimine devam et
        } else if (realEntry.status === 'canceled') {
          trade.entryOrder.status = 'CANCELLED';
          trade.entryOrder.updatedAt = Date.now();
          clearActiveTrade(symbol);
          return;
        }
      } catch {
        // fetchOrder başarısız — mevcut durumla devam et
      }
    }

    // Entry hala OPEN ise ghost cancel kontrolü yap
    if (trade.entryOrder.status === 'OPEN') {
      // 2.1 Ghost Emir Kontrolü (Setup bozuldu mu?)
      const htfResult = runHTFFilter(htfCandles, config.htfTimeframe);
      const ltfStructure = analyzeMarketStructure(ltfCandles, 5, 5);

      let setupBroken = false;
      let cancelReason = '';

      if (htfResult.bias !== trade.signal.htfBias) {
        setupBroken = true;
        cancelReason = `${config.htfTimeframe} trend değişti (${trade.signal.htfBias} → ${htfResult.bias})`;
      } else if (ltfStructure.lastMSS && ltfStructure.lastMSS.type !== trade.signal.htfBias) {
        setupBroken = true;
        cancelReason = `${config.ltfTimeframe}'de ters yönde MSS (${ltfStructure.lastMSS.type}) algılandı`;
      }

      if (setupBroken) {
        logger.warn('ORDER', `[${symbol}] 👻 GHOST ORDER: ${cancelReason}. Cancelling ambush...`);
        await cancelGhostOrders(symbol, config);
        // C-05 FIX: Ghost cancel bir gerçek kayıp değil.
        recordTradeResult(cbState, {
          timestamp: Date.now(),
          symbol,
          direction: trade.signal.direction,
          entryPrice: trade.entryOrder.price,
          exitPrice: trade.entryOrder.price,
          quantity: 0,
          pnl: 0,
          isWin: true,
          exitReason: 'GHOST_CANCEL',
        }, config);
        return;
      }
    }

    // 2.2 Dry-run: Fiyat pusu bölgesine geldi mi?
    if (config.dryRun) {
      const isTriggered = trade.signal.direction === 'LONG'
        ? lastCandle.low <= trade.entryOrder.price
        : lastCandle.high >= trade.entryOrder.price;

      if (isTriggered) {
        trade.entryOrder.status = 'FILLED';
        trade.entryOrder.filledQuantity = trade.entryOrder.quantity;
        trade.entryOrder.updatedAt = Date.now();
        logger.info('FILL', `🧪 DRY-RUN [${symbol}] Entry FILLED: ${trade.entryOrder.quantity} @ ${logger.formatUSD(trade.entryOrder.price)}`);
        playSound('ORDER');

        // TP emirlerini oluştur
        if (trade.tp1Price && trade.tp2Price && trade.tp1Quantity && trade.tp2Quantity) {
          const tpLevels: TakeProfitLevels = {
            tp1Price: trade.tp1Price,
            tp2Price: trade.tp2Price,
            tp1Quantity: trade.tp1Quantity,
            tp2Quantity: trade.tp2Quantity,
            riskRewardTP1: config.tp1RR,
            riskRewardTP2: config.tp2RR,
            isValid: true,
          };
          await placeTPOrders(symbol, tpLevels, trade.entryOrder.quantity, config, constraints);
        }
      }
    }
  }

  // 3. Durum: Giriş Emri Doldu (veya Kısmi Doldu)
  if (trade.entryOrder.status === 'FILLED' || trade.entryOrder.status === 'PARTIALLY_FILLED') {
    
    // 3.0 SL Emrini Yerleştir / Güncelle
    if (!trade.stopLossOrder || trade.stopLossOrder.quantity < trade.entryOrder.filledQuantity) {
      await placeSLOrder(symbol, trade.entryOrder.filledQuantity, config, constraints);
    }

    // 3.0.5 TP Emirlerini Yerleştir / Yeniden Gönder
    // FIX: TP emirleri expired/cancelled olduysa yeniden gönder (reduceOnly çakışması düzeltmesi)
    if (trade.tp1Order?.status === 'EXPIRED' || trade.tp1Order?.status === 'CANCELLED') {
      logger.warn('ORDER', `[${symbol}] TP1 order is ${trade.tp1Order.status} — will be resent`);
      trade.tp1Order = undefined;
    }
    if (trade.tp2Order?.status === 'EXPIRED' || trade.tp2Order?.status === 'CANCELLED') {
      logger.warn('ORDER', `[${symbol}] TP2 order is ${trade.tp2Order.status} — will be resent`);
      trade.tp2Order = undefined;
    }

    // TP emirleri yoksa (ilk kez veya yeniden gönderim) yerleştir
    if (trade.tp1Price && trade.tp2Price && trade.tp1Quantity && trade.tp2Quantity
        && !trade.tp1Order && !trade.tp2Order) {

      const filledQty = trade.entryOrder.filledQuantity;
      const minNotional = Math.max(constraints.minNotional, 5);

      // Kısmi dolum oranı ile TP miktarlarını hesapla
      const ratio = filledQty / trade.entryOrder.quantity;
      let tp1Qty = floorToStepSize(trade.tp1Quantity * ratio, constraints.stepSize);
      let tp2Qty = floorToStepSize(filledQty - tp1Qty, constraints.stepSize);

      // C-03 FIX: minNotional kontrolü — gerekirse tek TP'ye birleştir
      let shouldCombine = false;
      if (tp1Qty > 0 && tp1Qty * trade.tp1Price < minNotional) shouldCombine = true;
      if (tp2Qty > 0 && tp2Qty * trade.tp2Price < minNotional) shouldCombine = true;

      const tpLevels: TakeProfitLevels = {
        tp1Price: trade.tp1Price,
        tp2Price: trade.tp2Price,
        tp1Quantity: shouldCombine ? filledQty : trade.tp1Quantity,
        tp2Quantity: shouldCombine ? 0 : trade.tp2Quantity,
        riskRewardTP1: config.tp1RR,
        riskRewardTP2: config.tp2RR,
        isValid: true,
      };

      if (shouldCombine) {
        logger.warn('ORDER', `[${symbol}] Amount too small, merging TP targets (total: ${filledQty}).`);
      }

      await placeTPOrders(symbol, tpLevels, filledQty, config, constraints);
    }

    // 3.1 Dry-run fiyat tetiklemelerini simüle et
    if (config.dryRun) {
      const currentSlPrice = trade.stopLossOrder?.price ?? trade.signal.stopLoss;
      const isSlTriggered = trade.signal.direction === 'LONG'
        ? lastCandle.low <= currentSlPrice
        : lastCandle.high >= currentSlPrice;

      if (isSlTriggered && trade.stopLossOrder) {
        trade.stopLossOrder.status = 'FILLED';
        trade.stopLossOrder.updatedAt = Date.now();
      }

      // TP1 tetiklenme kontrolü
      if (!trade.tp1Hit && trade.tp1Price && trade.tp1Order) {
        const isTp1Triggered = trade.signal.direction === 'LONG'
          ? lastCandle.high >= trade.tp1Price
          : lastCandle.low <= trade.tp1Price;

        if (isTp1Triggered) {
          trade.tp1Order.status = 'FILLED';
          trade.tp1Hit = true;
          trade.tp1Order.updatedAt = Date.now();
        }
      }

      // TP2 tetiklenme kontrolü (TP1 dolduktan sonra)
      if (trade.tp1Hit && trade.tp2Price && trade.tp2Order) {
        const isTp2Triggered = trade.signal.direction === 'LONG'
          ? lastCandle.high >= trade.tp2Price
          : lastCandle.low <= trade.tp2Price;

        if (isTp2Triggered) {
          trade.tp2Order.status = 'FILLED';
          trade.tp2Order.updatedAt = Date.now();
        }
      }
    }

    // 3.2 Kural: TP1 Gerçekleştiğinde SL Break-Even'a çekilmelidir
    if ((trade.tp1Order?.status === 'FILLED' || trade.tp1Hit) && !trade.breakEvenApplied) {
      trade.breakEvenApplied = true;

      // Eğer TP2 emri yoksa (küçük bakiye/lot yüzünden TP'ler birleştirilmişse), TP1 pozisyonu tamamen kapatır!
      if (!trade.tp2Order) {
        logger.separator();
        const totalQty = trade.entryOrder.filledQuantity || trade.entryOrder.quantity;
        logger.info('ORDER', `[${symbol}] 🏆 TP target reached! Entire position (${totalQty} lot) closed with profit.`);
        playSound('PROFIT');

        // Stop-loss emrini iptal et
        if (!config.dryRun && trade.stopLossOrder?.status === 'OPEN') {
          try {
            await cancelSLOrder(symbol, trade.stopLossOrder.id, config);
          } catch { /* ignore */ }
        }

        const tpPrice = trade.tp1Price ?? trade.signal.takeProfit1;
        const totalNetPnL = calculateNetPnL(trade.entryOrder.price, tpPrice, totalQty, trade.signal.direction, config, constraints);

        recordTradeResult(cbState, {
          timestamp: Date.now(),
          symbol,
          direction: trade.signal.direction,
          entryPrice: trade.entryOrder.price,
          exitPrice: tpPrice,
          quantity: totalQty,
          pnl: totalNetPnL,
          isWin: true,
          exitReason: 'TAKE_PROFIT_1',
        }, config);

        clearActiveTrade(symbol);
        logger.separator();
        return;
      }

      const tp1Qty = trade.tp1Quantity ?? (trade.entryOrder.quantity * 0.5);
      logger.info('ORDER', `[${symbol}] 🎯 TP1 target reached! ${tp1Qty} lot sold for profit. SL moved to Break-Even for remaining amount...`);
      playSound('PROFIT');
      await applyBreakEvenStopLoss(symbol, config, constraints);
    }

    // 3.3 Kural: TP2 Doldu (Tam Kâr Alımı ile Pozisyon Kapandı)
    if (trade.tp2Order?.status === 'FILLED') {
      logger.separator();
      const tp2Qty = trade.tp2Quantity ?? (trade.entryOrder.quantity * 0.5);
      logger.info('ORDER', `[${symbol}] 🏆 TP2 target reached! Remaining ${tp2Qty} lot sold for profit. Trade closed with max profit.`);
      playSound('PROFIT');

      // Stop-loss emrini iptal et
      if (!config.dryRun && trade.stopLossOrder?.status === 'OPEN') {
        try {
          await cancelSLOrder(symbol, trade.stopLossOrder.id, config);
        } catch { /* ignore */ }
      }

      const tp1Qty = trade.tp1Quantity ?? (trade.entryOrder.quantity * 0.5);
      const tp1Price = trade.tp1Price ?? trade.signal.takeProfit1;
      const tp2Price = trade.tp2Price ?? trade.signal.takeProfit2;

      const pnl1 = calculateNetPnL(trade.entryOrder.price, tp1Price, tp1Qty, trade.signal.direction, config, constraints);
      const pnl2 = calculateNetPnL(trade.entryOrder.price, tp2Price, tp2Qty, trade.signal.direction, config, constraints);
      const totalNetPnL = pnl1 + pnl2;

      recordTradeResult(cbState, {
        timestamp: Date.now(),
        symbol,
        direction: trade.signal.direction,
        entryPrice: trade.entryOrder.price,
        exitPrice: tp2Price,
        quantity: trade.entryOrder.filledQuantity || trade.entryOrder.quantity,
        pnl: totalNetPnL,
        isWin: true,
        exitReason: 'TAKE_PROFIT_2',
      }, config);

      clearActiveTrade(symbol);
      logger.separator();
      return;
    }

    // 3.4 Kural: Stop-Loss Tetiklendi
    if (trade.stopLossOrder?.status === 'FILLED') {
      logger.separator();
      logger.warn('ORDER', `[${symbol}] 🛑 STOP-LOSS TRIGGERED!`);

      // Kalan açık TP emirlerini iptal et
      if (!config.dryRun) {
        const exchange = getExchange();
        try {
          await exchange.cancelAllOrders(symbol);
        } catch { /* ignore */ }
      }

      let totalNetPnL: number;
      if (trade.breakEvenApplied) {
        // TP1 kârı alındı, kalan kısım başa baş kapandı
        const tp1Qty = trade.tp1Quantity ?? (trade.entryOrder.quantity * 0.5);
        const remainingQty = trade.tp2Quantity ?? (trade.entryOrder.quantity * 0.5);
        const tp1Price = trade.tp1Price ?? trade.signal.takeProfit1;
        const bePrice = trade.stopLossOrder.price;

        const pnl1 = calculateNetPnL(trade.entryOrder.price, tp1Price, tp1Qty, trade.signal.direction, config, constraints);
        const pnl2 = calculateNetPnL(trade.entryOrder.price, bePrice, remainingQty, trade.signal.direction, config, constraints);
        totalNetPnL = pnl1 + pnl2;
      } else {
        // İlk baştaki tam stop loss
        const fullQty = trade.entryOrder.filledQuantity || trade.entryOrder.quantity;
        totalNetPnL = calculateNetPnL(trade.entryOrder.price, trade.stopLossOrder.price, fullQty, trade.signal.direction, config, constraints);
      }

      const isWin = totalNetPnL > 0;
      if (isWin) {
        playSound('PROFIT');
      } else {
        playSound('LOSS');
      }

      recordTradeResult(cbState, {
        timestamp: Date.now(),
        symbol,
        direction: trade.signal.direction,
        entryPrice: trade.entryOrder.price,
        exitPrice: trade.stopLossOrder.price,
        quantity: trade.entryOrder.filledQuantity || trade.entryOrder.quantity,
        pnl: totalNetPnL,
        isWin,
        exitReason: 'STOP_LOSS',
      }, config);

      clearActiveTrade(symbol);
      logger.separator();
      return;
    }
  }

  // 4. Durum: Giriş Emri İptal Edilmişse
  if (trade.entryOrder.status === 'CANCELLED') {
    logger.info('ORDER', `[${symbol}] Entry order was cancelled. Active trade cleared.`);
    clearActiveTrade(symbol);
  }
}
