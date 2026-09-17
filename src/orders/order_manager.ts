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
import { getExchange } from '../exchange/binance_client.js';
import { floorToStepSize, roundToTickSize } from '../utils/candle_utils.js';
import { logger } from '../utils/logger.js';

// Çift bazlı aktif işlemler (Multi-Pair)
const activeTrades = new Map<string, ActiveTrade>();

export function getActiveTrade(symbol: string): ActiveTrade | null {
  return activeTrades.get(symbol) ?? null;
}

export function hasActiveTrade(symbol: string): boolean {
  return activeTrades.has(symbol);
}

export function getAllActiveTrades(): Map<string, ActiveTrade> {
  return activeTrades;
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
    logger.warn('ORDER', `[${symbol}] Zaten aktif işlem var. Yeni işlem reddedildi.`);
    return;
  }

  if (!posSize.isValid) {
    logger.warn('ORDER', `[${symbol}] Pozisyon geçersiz: ${posSize.rejectReason}`);
    return;
  }

  if (!tpLevels.isValid) {
    logger.warn('ORDER', `[${symbol}] TP geçersiz: ${tpLevels.rejectReason}`);
    return;
  }

  const exchange = getExchange();
  const side = signal.direction === 'LONG' ? 'buy' : 'sell';
  const quantity = posSize.quantity;
  const entryPrice = roundToTickSize(signal.entryPrice, constraints.tickSize);

  // ─── DRY-RUN ─────────────────────────────────────────────
  if (config.dryRun) {
    logger.separator();
    logger.info('ORDER', `🧪 DRY-RUN [${symbol}]: Emir GÖNDERİLMEDİ`);
    logger.info('ORDER', `  ${side.toUpperCase()} ${quantity} @ ${logger.formatUSD(entryPrice)}`);
    logger.info('ORDER', `  SL: ${logger.formatUSD(signal.stopLoss)} | TP1: ${logger.formatUSD(tpLevels.tp1Price)} | TP2: ${logger.formatUSD(tpLevels.tp2Price)}`);
    logger.info('ORDER', `  Tetik: ${signal.triggerType} | ${signal.reason}`);
    logger.separator();

    activeTrades.set(symbol, createVirtualTrade(signal, quantity, entryPrice, tpLevels));
    return;
  }

  // ─── LIVE ────────────────────────────────────────────────
  try {
    logger.separator();
    logger.info('ORDER', `📤 [${symbol}] LIMIT ${side.toUpperCase()} gönderiliyor...`);

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
    playSound('ORDER');

    // SL emri burada baştan gönderilmeyecek! Partial fill / dolum anında manageActiveTrade içinde gönderilecek.
    logger.info('ORDER', `🛡️ [${symbol}] SL emri dolum (fill) beklentisiyle beklemeye alındı.`);

    activeTrades.set(symbol, {
      symbol,
      entryOrder: entryManaged,
      stopLossOrder: undefined, // Dolum gelene kadar undefined
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
    logger.error('ORDER', `[${symbol}] Emir hatası: ${msg}`);
    await cleanupOrders(symbol);
  }
}

/**
 * TP emirlerini yerleştirir. Kısmi dolum desteği dahil.
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

  // Kısmi dolum — miktarları oranla
  let tp1Qty: number;
  let tp2Qty: number;

  if (filledQuantity < trade.entryOrder.quantity) {
    const ratio = filledQuantity / trade.entryOrder.quantity;
    tp1Qty = floorToStepSize(tpLevels.tp1Quantity * ratio, constraints.stepSize);
    tp2Qty = floorToStepSize(filledQuantity - tp1Qty, constraints.stepSize);
    logger.warn('FILL', `[${symbol}] Kısmi dolum: ${filledQuantity}/${trade.entryOrder.quantity} (${(ratio * 100).toFixed(1)}%)`);
  } else {
    tp1Qty = tpLevels.tp1Quantity;
    tp2Qty = tpLevels.tp2Quantity;
  }

  if (config.dryRun) {
    logger.info('ORDER', `🧪 DRY-RUN [${symbol}]: TP emirleri simüle edildi`);
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

    if (tp2Qty > 0 && tp2Qty * tpLevels.tp2Price >= minNotional) {
      const tp2Price = roundToTickSize(tpLevels.tp2Price, constraints.tickSize);
      const tp2Order = await exchange.createOrder(symbol, 'limit', side, tp2Qty, tp2Price, tpParams);
      trade.tp2Order = {
        id: tp2Order.id ?? '', clientOrderId: `tp2_${Date.now()}`, symbol,
        type: 'TAKE_PROFIT_2', side, price: tp2Price, quantity: tp2Qty,
        filledQuantity: 0, status: 'OPEN', createdAt: Date.now(), updatedAt: Date.now(),
      };
      logger.info('ORDER', `🎯 [${symbol}] TP2: ${tp2Qty} @ ${logger.formatUSD(tp2Price)}`);
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
      logger.info('ORDER', `🧪 DRY-RUN [${symbol}]: SL simüle edildi @ ${logger.formatUSD(slPrice)}`);
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
      await exchange.cancelOrder(trade.stopLossOrder.id, symbol);
    }

    const slParams: any = { stopPrice: slPrice };
    let slOrderType = 'STOP_LOSS_LIMIT';
    let slLimitPrice: number | undefined = slPrice;

    if (config.marketType === 'futures') {
      slOrderType = 'STOP_MARKET';
      slLimitPrice = undefined;
      slParams.reduceOnly = true;
    } else {
      slParams.timeInForce = 'GTC';
    }

    const slOrder = await exchange.createOrder(
      symbol, slOrderType, slSide, filledQuantity, slLimitPrice, slParams,
    );

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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('ORDER', `[${symbol}] SL emir hatası: ${msg}`);
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
      await exchange.cancelOrder(trade.stopLossOrder.id, symbol);
    }

    const beParams: any = { stopPrice: breakEvenPrice };
    let slOrderType = 'STOP_LOSS_LIMIT';
    let slLimitPrice: number | undefined = breakEvenPrice;

    if (config.marketType === 'futures') {
      slOrderType = 'STOP_MARKET';
      slLimitPrice = undefined;
      beParams.reduceOnly = true;
    } else {
      beParams.timeInForce = 'GTC';
    }

    const newSlOrder = await exchange.createOrder(
      symbol, slOrderType, slSide, remainingQty, slLimitPrice, beParams,
    );

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
    logger.error('ORDER', `[${symbol}] Break-Even hatası: ${msg}`);
  }
}

/**
 * Ghost emirleri iptal eder.
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
    logger.info('CANCEL', `🧪 [${symbol}] ${ordersToCancel.length} ghost emir iptal simülasyonu`);
    activeTrades.delete(symbol);
    return;
  }

  const exchange = getExchange();
  for (const order of ordersToCancel) {
    try {
      await exchange.cancelOrder(order.id, symbol);
      logger.info('CANCEL', `🚫 [${symbol}] ${order.type} iptal: ${order.id}`);
    } catch {
      logger.debug('CANCEL', `[${symbol}] ${order.id} zaten kapalı olabilir`);
    }
  }

  activeTrades.delete(symbol);
}

/**
 * Açık emirlerin durumunu borsadan senkronize eder.
 */
export async function syncOrderStatuses(symbol: string, config: BotConfig): Promise<void> {
  const trade = activeTrades.get(symbol);
  if (!trade || config.dryRun) return;

  const exchange = getExchange();
  const orders = [trade.entryOrder, trade.stopLossOrder, trade.tp1Order, trade.tp2Order]
    .filter((o): o is ManagedOrder => o !== undefined && o.status === 'OPEN');

  for (const mo of orders) {
    try {
      const live = await exchange.fetchOrder(mo.id, symbol);
      const prev = mo.status;
      mo.filledQuantity = live.filled ?? 0;
      mo.updatedAt = Date.now();

      if (live.status === 'closed') mo.status = 'FILLED';
      else if (live.status === 'canceled') mo.status = 'CANCELLED';
      else if ((live.filled ?? 0) > 0 && live.status === 'open') mo.status = 'PARTIALLY_FILLED';

      if (mo.status !== prev) {
        logger.info('FILL', `[${symbol}] ${mo.type}: ${prev} → ${mo.status} (${mo.filledQuantity}/${mo.quantity})`);
      }
    } catch (e: any) {
      if (e.message.includes('-2013') || e.message.includes('Order does not exist')) {
        logger.debug('ORDER', `[${symbol}] ${mo.id} borsada bulunamadı (-2013). Tetiklenmiş veya silinmiş kabul ediliyor.`);
        mo.status = mo.type === 'ENTRY' ? 'CANCELLED' : 'FILLED';
        mo.updatedAt = Date.now();
      } else {
        logger.debug('ORDER', `[${symbol}] ${mo.id} durumu sorgulanamadı: ${e.message}`);
      }
    }
  }
}

export function clearActiveTrade(symbol: string): void {
  activeTrades.delete(symbol);
}

async function cleanupOrders(symbol: string): Promise<void> {
  const exchange = getExchange();
  try {
    const open = await exchange.fetchOpenOrders(symbol);
    for (const o of open) {
      await exchange.cancelOrder(o.id!, symbol);
    }
  } catch { /* ignore */ }
  activeTrades.delete(symbol);
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

  // 2. Durum: Giriş Emri Henüz Açık (Beklemede)
  if (trade.entryOrder.status === 'OPEN') {
    // 2.1 Ghost Emir Kontrolü (Setup bozuldu mu?)
    const htfResult = runHTFFilter(htfCandles);
    const ltfStructure = analyzeMarketStructure(ltfCandles, 5, 5);

    let setupBroken = false;
    let cancelReason = '';

    if (htfResult.bias !== trade.signal.htfBias) {
      setupBroken = true;
      cancelReason = `4H trend değişti (${trade.signal.htfBias} → ${htfResult.bias})`;
    } else if (ltfStructure.lastMSS && ltfStructure.lastMSS.type !== trade.signal.htfBias) {
      setupBroken = true;
      cancelReason = `15m'de ters yönde MSS (${ltfStructure.lastMSS.type}) algılandı`;
    }

    if (setupBroken) {
      logger.warn('ORDER', `[${symbol}] 👻 GHOST EMİR: ${cancelReason}. Pusu iptal ediliyor...`);
      await cancelGhostOrders(symbol, config);
      recordTradeResult(cbState, {
        timestamp: Date.now(),
        symbol,
        direction: trade.signal.direction,
        entryPrice: trade.entryOrder.price,
        exitPrice: trade.entryOrder.price,
        quantity: 0,
        pnl: 0,
        isWin: false,
        exitReason: 'GHOST_CANCEL',
      }, config);
      return;
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
        logger.info('FILL', `🧪 DRY-RUN [${symbol}] Entry DOLDU: ${trade.entryOrder.quantity} @ ${logger.formatUSD(trade.entryOrder.price)}`);

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

    // 3.0.5 TP Emirlerini Yerleştir (Kısmi Başarısızlıkları Önle)
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

      // Tek TP ile birleştirme (minNotional koruması)
      const ratio = trade.entryOrder.filledQuantity / trade.entryOrder.quantity;
      const tp1Qty = floorToStepSize(trade.tp1Quantity * ratio, constraints.stepSize);
      const tp2Qty = floorToStepSize(trade.entryOrder.filledQuantity - tp1Qty, constraints.stepSize);
      
      const minNotional = Math.max(constraints.minNotional, 5);
      
      // Eğer TP1 veya TP2'den biri minNotional altında kalıyorsa, hepsini TP1'e taşı (Sadece biri oluşturulacak)
      let shouldCombine = false;
      if (tp1Qty > 0 && tp1Qty * trade.tp1Price < minNotional) shouldCombine = true;
      if (tp2Qty > 0 && tp2Qty * trade.tp2Price < minNotional) shouldCombine = true;

      if (shouldCombine && !trade.tp1Order && !trade.tp2Order) {
        // Tüm miktarı TP1'de birleştir
        tpLevels.tp1Quantity = trade.entryOrder.quantity; // Orijinal miktar
        tpLevels.tp2Quantity = 0;
        logger.warn('ORDER', `[${symbol}] Kısmi dolum miktar küçük, TP hedefleri birleştiriliyor.`);
        await placeTPOrders(symbol, tpLevels, trade.entryOrder.filledQuantity, config, constraints);
      } else {
        // Sızıntıyı önleyen ayrı kontroller
        if (!trade.tp1Order || !trade.tp2Order) {
           await placeTPOrders(symbol, tpLevels, trade.entryOrder.filledQuantity, config, constraints);
        }
      }
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
      logger.info('ORDER', `[${symbol}] 🎯 TP1 dolumu teyit edildi. SL Break-Even seviyesine taşınıyor...`);
      playSound('PROFIT');
      await applyBreakEvenStopLoss(symbol, config, constraints);
    }

    // 3.3 Kural: TP2 Doldu (Tam Kâr Alımı ile Pozisyon Kapandı)
    if (trade.tp2Order?.status === 'FILLED') {
      logger.separator();
      logger.info('ORDER', `[${symbol}] 🏆 TP2 DOLDU! Tüm pozisyon hedefine ulaştı.`);
      playSound('PROFIT');

      // Stop-loss emrini iptal et
      if (!config.dryRun && trade.stopLossOrder?.status === 'OPEN') {
        const exchange = getExchange();
        try {
          await exchange.cancelOrder(trade.stopLossOrder.id, symbol);
        } catch { /* ignore */ }
      }

      const tp1Qty = trade.tp1Quantity ?? (trade.entryOrder.quantity * 0.5);
      const tp2Qty = trade.tp2Quantity ?? (trade.entryOrder.quantity * 0.5);
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
      logger.warn('ORDER', `[${symbol}] 🛑 STOP-LOSS TETİKLENDİ!`);

      // Kalan açık TP emirlerini iptal et
      if (!config.dryRun) {
        const exchange = getExchange();
        try {
          if (trade.tp1Order?.status === 'OPEN') await exchange.cancelOrder(trade.tp1Order.id, symbol);
          if (trade.tp2Order?.status === 'OPEN') await exchange.cancelOrder(trade.tp2Order.id, symbol);
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
    logger.info('ORDER', `[${symbol}] Giriş emri iptal edilmiş. Aktif işlem temizlendi.`);
    clearActiveTrade(symbol);
  }
}
