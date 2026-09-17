// ══════════════════════════════════════════════════════════════
// order_manager.ts — Emir Yönetimi (Faz 1 İskeleti)
// Emir oluşturma, SL/TP yerleştirme, ghost emir iptali,
// kısmi dolum (partial fill) yönetimi ve TP1→Break-Even SL
// ══════════════════════════════════════════════════════════════

import type {
  BotConfig,
  TradeSignal,
  ManagedOrder,
  ActiveTrade,
  PositionSizeResult,
  SymbolConstraints,
} from '../utils/types.js';
import type { TakeProfitLevels } from '../risk/take_profit.js';
import { calculateBreakEvenStopLoss } from '../risk/stop_loss.js';
import { getExchange, getSymbolConstraints } from '../exchange/binance_client.js';
import { floorToStepSize, roundToTickSize } from '../utils/candle_utils.js';
import { logger } from '../utils/logger.js';

// Aktif işlemleri bellekte takip et
let activeTrade: ActiveTrade | null = null;

/**
 * Aktif işlem varsa döndürür, yoksa null.
 */
export function getActiveTrade(): ActiveTrade | null {
  return activeTrade;
}

/**
 * Aktif işlem olup olmadığını kontrol eder.
 */
export function hasActiveTrade(): boolean {
  return activeTrade !== null;
}

/**
 * Yeni bir işlem açar — Entry (LIMIT) + SL emri aynı anda borsaya iletilir.
 *
 * @param signal      - Giriş sinyali
 * @param posSize     - Pozisyon büyüklüğü hesaplama sonucu
 * @param tpLevels    - TP seviyeleri
 * @param config      - Bot konfigürasyonu
 * @param constraints - Sembol kısıtlamaları
 */
export async function openTrade(
  signal: TradeSignal,
  posSize: PositionSizeResult,
  tpLevels: TakeProfitLevels,
  config: BotConfig,
  constraints: SymbolConstraints,
): Promise<void> {
  if (activeTrade) {
    logger.warn('ORDER', 'Zaten aktif bir işlem var. Yeni işlem reddedildi.');
    return;
  }

  if (!posSize.isValid) {
    logger.warn('ORDER', `Pozisyon geçersiz: ${posSize.rejectReason}`);
    return;
  }

  if (!tpLevels.isValid) {
    logger.warn('ORDER', `TP seviyeleri geçersiz: ${tpLevels.rejectReason}`);
    return;
  }

  const exchange = getExchange();
  const side = signal.direction === 'LONG' ? 'buy' : 'sell';
  const quantity = posSize.quantity;
  const entryPrice = roundToTickSize(signal.entryPrice, constraints.tickSize);

  // ─── DRY-RUN Modu ────────────────────────────────────────
  if (config.dryRun) {
    logger.separator();
    logger.info('ORDER', `🧪 DRY-RUN: Emir borsaya GÖNDERİLMEDİ (simülasyon)`);
    logger.info('ORDER', `  ${side.toUpperCase()} ${quantity} @ ${logger.formatUSD(entryPrice)}`);
    logger.info('ORDER', `  SL: ${logger.formatUSD(signal.stopLoss)}`);
    logger.info('ORDER', `  TP1: ${logger.formatUSD(tpLevels.tp1Price)} (${tpLevels.tp1Quantity})`);
    logger.info('ORDER', `  TP2: ${logger.formatUSD(tpLevels.tp2Price)} (${tpLevels.tp2Quantity})`);
    logger.info('ORDER', `  Tetik: ${signal.triggerType} | Sebep: ${signal.reason}`);
    logger.separator();

    // Dry-run'da sanal active trade oluştur (döngü mantığı test edilebilsin)
    activeTrade = createVirtualTrade(signal, quantity, entryPrice, tpLevels);
    return;
  }

  // ─── LIVE: Emirleri Borsaya İlet ─────────────────────────
  try {
    logger.separator();
    logger.info('ORDER', `📤 LIMIT ${side.toUpperCase()} emri gönderiliyor...`);

    // 1. Entry emri (LIMIT)
    const entryOrder = await exchange.createLimitOrder(
      config.tradingPair,
      side,
      quantity,
      entryPrice,
    );

    const entryManaged: ManagedOrder = {
      id: entryOrder.id ?? '',
      clientOrderId: `entry_${Date.now()}`,
      type: 'ENTRY',
      side,
      price: entryPrice,
      quantity,
      filledQuantity: 0,
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    logger.info('ORDER', `✅ Entry emri yerleştirildi: ${entryOrder.id} | ` +
      `${side.toUpperCase()} ${quantity} @ ${logger.formatUSD(entryPrice)}`);

    // 2. Stop-Loss emri (STOP_LOSS_LIMIT) — aynı milisaniyede
    const slSide = signal.direction === 'LONG' ? 'sell' : 'buy';
    const slPrice = roundToTickSize(signal.stopLoss, constraints.tickSize);

    const slOrder = await exchange.createOrder(
      config.tradingPair,
      'STOP_LOSS_LIMIT',
      slSide,
      quantity,
      slPrice,
      {
        stopPrice: slPrice,
        timeInForce: 'GTC',
      },
    );

    const slManaged: ManagedOrder = {
      id: slOrder.id ?? '',
      clientOrderId: `sl_${Date.now()}`,
      type: 'STOP_LOSS',
      side: slSide,
      price: slPrice,
      quantity,
      filledQuantity: 0,
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    logger.info('ORDER', `🛡️ SL emri yerleştirildi: ${slOrder.id} | ` +
      `${slSide.toUpperCase()} ${quantity} @ ${logger.formatUSD(slPrice)}`);

    // Aktif işlemi kaydet
    activeTrade = {
      entryOrder: entryManaged,
      stopLossOrder: slManaged,
      signal,
      tp1Hit: false,
      breakEvenApplied: false,
    };

    logger.info('ORDER', `📊 İşlem açıldı. Tetik: ${signal.triggerType} | Sebep: ${signal.reason}`);
    logger.separator();

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('ORDER', `Emir gönderme hatası: ${msg}`);

    // Hata durumunda açılmış olan emirleri temizle
    await cleanupFailedOrders();
  }
}

/**
 * Entry emri dolduğunda TP emirlerini yerleştirir.
 * Kısmi dolum durumunda, TP miktarları gerçek dolum üzerinden hesaplanır.
 */
export async function placeTPOrders(
  tpLevels: TakeProfitLevels,
  filledQuantity: number,
  config: BotConfig,
  constraints: SymbolConstraints,
): Promise<void> {
  if (!activeTrade) {
    logger.error('ORDER', 'TP emirleri yerleştirilemez — aktif işlem yok.');
    return;
  }

  const exchange = getExchange();
  const signal = activeTrade.signal;
  const side = signal.direction === 'LONG' ? 'sell' : 'buy';

  // ─── Kısmi Dolum (Partial Fill) Yönetimi ──────────────────
  // TP miktarları GERÇEK dolum üzerinden hesaplanır
  let tp1Qty: number;
  let tp2Qty: number;

  if (filledQuantity < activeTrade.entryOrder.quantity) {
    // Kısmi dolum — miktarları oranla
    const fillRatio = filledQuantity / activeTrade.entryOrder.quantity;
    tp1Qty = floorToStepSize(tpLevels.tp1Quantity * fillRatio, constraints.stepSize);
    tp2Qty = floorToStepSize(filledQuantity - tp1Qty, constraints.stepSize);

    logger.warn('FILL', `Kısmi dolum algılandı: ${filledQuantity} / ${activeTrade.entryOrder.quantity} ` +
      `(${(fillRatio * 100).toFixed(1)}%)`);
    logger.info('FILL', `TP miktarları kısmi doluma göre ayarlandı: TP1=${tp1Qty} | TP2=${tp2Qty}`);
  } else {
    tp1Qty = tpLevels.tp1Quantity;
    tp2Qty = tpLevels.tp2Quantity;
  }

  // Minimum notional kontrolü
  const tp1Value = tp1Qty * tpLevels.tp1Price;
  const tp2Value = tp2Qty * tpLevels.tp2Price;
  const minNotional = Math.max(constraints.minNotional, 5);

  if (config.dryRun) {
    logger.info('ORDER', `🧪 DRY-RUN: TP emirleri simüle edildi`);
    return;
  }

  try {
    // TP1 emri
    if (tp1Qty > 0 && tp1Value >= minNotional) {
      const tp1Price = roundToTickSize(tpLevels.tp1Price, constraints.tickSize);
      const tp1Order = await exchange.createLimitOrder(
        config.tradingPair, side, tp1Qty, tp1Price,
      );

      activeTrade.tp1Order = {
        id: tp1Order.id ?? '',
        clientOrderId: `tp1_${Date.now()}`,
        type: 'TAKE_PROFIT_1',
        side,
        price: tp1Price,
        quantity: tp1Qty,
        filledQuantity: 0,
        status: 'OPEN',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      logger.info('ORDER', `🎯 TP1 yerleştirildi: ${tp1Order.id} | ` +
        `${side.toUpperCase()} ${tp1Qty} @ ${logger.formatUSD(tp1Price)}`);
    } else {
      logger.warn('ORDER', `TP1 atlandı: Miktar (${tp1Qty}) veya değer (${logger.formatUSD(tp1Value)}) yetersiz.`);
    }

    // TP2 emri
    if (tp2Qty > 0 && tp2Value >= minNotional) {
      const tp2Price = roundToTickSize(tpLevels.tp2Price, constraints.tickSize);
      const tp2Order = await exchange.createLimitOrder(
        config.tradingPair, side, tp2Qty, tp2Price,
      );

      activeTrade.tp2Order = {
        id: tp2Order.id ?? '',
        clientOrderId: `tp2_${Date.now()}`,
        type: 'TAKE_PROFIT_2',
        side,
        price: tp2Price,
        quantity: tp2Qty,
        filledQuantity: 0,
        status: 'OPEN',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      logger.info('ORDER', `🎯 TP2 yerleştirildi: ${tp2Order.id} | ` +
        `${side.toUpperCase()} ${tp2Qty} @ ${logger.formatUSD(tp2Price)}`);
    } else {
      logger.warn('ORDER', `TP2 atlandı: Miktar (${tp2Qty}) veya değer (${logger.formatUSD(tp2Value)}) yetersiz.`);
    }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('ORDER', `TP emir yerleştirme hatası: ${msg}`);
  }
}

/**
 * TP1 dolduğunda çağrılır:
 * - Eski SL emrini iptal et
 * - Yeni SL'yi Break-Even seviyesine taşı
 */
export async function applyBreakEvenStopLoss(
  config: BotConfig,
  constraints: SymbolConstraints,
): Promise<void> {
  if (!activeTrade || activeTrade.breakEvenApplied) return;

  const exchange = getExchange();
  const signal = activeTrade.signal;
  const slSide = signal.direction === 'LONG' ? 'sell' : 'buy';
  const remainingQty = activeTrade.tp2Order?.quantity ?? 0;

  if (remainingQty <= 0) {
    logger.warn('ORDER', 'Break-Even SL uygulanamıyor — kalan pozisyon yok.');
    return;
  }

  // Break-Even SL fiyatı hesapla
  const breakEvenPrice = calculateBreakEvenStopLoss(
    activeTrade.entryOrder.price,
    signal.direction,
    constraints.tickSize,
  );

  if (config.dryRun) {
    logger.info('ORDER', `🧪 DRY-RUN: SL → Break-Even simüle edildi @ ${logger.formatUSD(breakEvenPrice)}`);
    activeTrade.tp1Hit = true;
    activeTrade.breakEvenApplied = true;
    return;
  }

  try {
    // Eski SL'yi iptal et
    if (activeTrade.stopLossOrder && activeTrade.stopLossOrder.status === 'OPEN') {
      await exchange.cancelOrder(activeTrade.stopLossOrder.id, config.tradingPair);
      logger.info('CANCEL', `Eski SL iptal edildi: ${activeTrade.stopLossOrder.id}`);
    }

    // Yeni Break-Even SL yerleştir
    const newSlOrder = await exchange.createOrder(
      config.tradingPair,
      'STOP_LOSS_LIMIT',
      slSide,
      remainingQty,
      breakEvenPrice,
      {
        stopPrice: breakEvenPrice,
        timeInForce: 'GTC',
      },
    );

    activeTrade.stopLossOrder = {
      id: newSlOrder.id ?? '',
      clientOrderId: `sl_be_${Date.now()}`,
      type: 'STOP_LOSS',
      side: slSide,
      price: breakEvenPrice,
      quantity: remainingQty,
      filledQuantity: 0,
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    activeTrade.tp1Hit = true;
    activeTrade.breakEvenApplied = true;

    logger.info('ORDER', `🔄 SL → Break-Even uygulandı: ${newSlOrder.id} | ` +
      `${slSide.toUpperCase()} ${remainingQty} @ ${logger.formatUSD(breakEvenPrice)}`);

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('ORDER', `Break-Even SL hatası: ${msg}`);
  }
}

/**
 * Ghost (asılı kalan) emirleri iptal eder.
 * Fiyat setup'tan uzaklaştığında veya setup bozulduğunda çağrılır.
 */
export async function cancelGhostOrders(config: BotConfig): Promise<void> {
  if (!activeTrade) return;

  const exchange = getExchange();
  const ordersToCancel: ManagedOrder[] = [];

  // Dolmamış entry emri
  if (activeTrade.entryOrder.status === 'OPEN') {
    ordersToCancel.push(activeTrade.entryOrder);
  }

  // İlişkili SL/TP emirleri
  if (activeTrade.stopLossOrder?.status === 'OPEN') {
    ordersToCancel.push(activeTrade.stopLossOrder);
  }
  if (activeTrade.tp1Order?.status === 'OPEN') {
    ordersToCancel.push(activeTrade.tp1Order);
  }
  if (activeTrade.tp2Order?.status === 'OPEN') {
    ordersToCancel.push(activeTrade.tp2Order);
  }

  if (ordersToCancel.length === 0) {
    logger.debug('CANCEL', 'İptal edilecek ghost emir yok.');
    return;
  }

  if (config.dryRun) {
    logger.info('CANCEL', `🧪 DRY-RUN: ${ordersToCancel.length} ghost emir iptal simüle edildi.`);
    activeTrade = null;
    return;
  }

  for (const order of ordersToCancel) {
    try {
      await exchange.cancelOrder(order.id, config.tradingPair);
      logger.info('CANCEL', `🚫 Ghost emir iptal edildi: ${order.type} ${order.id}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('CANCEL', `Emir iptal edilemedi (zaten kapanmış olabilir): ${order.id} — ${msg}`);
    }
  }

  activeTrade = null;
  logger.info('CANCEL', 'Tüm ghost emirler temizlendi. Aktif işlem kapatıldı.');
}

/**
 * Açık emirlerin durumunu borsadan sorgular ve günceller.
 * Ana döngüde her tick'te çağrılır.
 */
export async function syncOrderStatuses(config: BotConfig): Promise<void> {
  if (!activeTrade) return;

  if (config.dryRun) return; // Dry-run'da sync yapılmaz

  const exchange = getExchange();

  const ordersToSync = [
    activeTrade.entryOrder,
    activeTrade.stopLossOrder,
    activeTrade.tp1Order,
    activeTrade.tp2Order,
  ].filter((o): o is ManagedOrder => o !== undefined && o.status === 'OPEN');

  for (const managedOrder of ordersToSync) {
    try {
      const liveOrder = await exchange.fetchOrder(managedOrder.id, config.tradingPair);

      const prevStatus = managedOrder.status;
      managedOrder.filledQuantity = liveOrder.filled ?? 0;
      managedOrder.updatedAt = Date.now();

      if (liveOrder.status === 'closed') {
        managedOrder.status = 'FILLED';
      } else if (liveOrder.status === 'canceled') {
        managedOrder.status = 'CANCELLED';
      } else if ((liveOrder.filled ?? 0) > 0 && liveOrder.status === 'open') {
        managedOrder.status = 'PARTIALLY_FILLED';
      }

      if (managedOrder.status !== prevStatus) {
        logger.info('FILL', `Emir durumu değişti: ${managedOrder.type} ${managedOrder.id} | ` +
          `${prevStatus} → ${managedOrder.status} | Dolum: ${managedOrder.filledQuantity}/${managedOrder.quantity}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.debug('ORDER', `Emir durumu sorgulanamadı: ${managedOrder.id} — ${msg}`);
    }
  }
}

/**
 * Aktif işlemi temizler (işlem kapandığında).
 */
export function clearActiveTrade(): void {
  activeTrade = null;
}

/**
 * Hata durumunda kısmi açılmış emirleri temizler.
 */
async function cleanupFailedOrders(): Promise<void> {
  if (!activeTrade) return;

  const exchange = getExchange();
  const pair = activeTrade.signal.direction === 'LONG' ? 'BTC/USDT' : 'BTC/USDT'; // config'den alınmalı

  try {
    const openOrders = await exchange.fetchOpenOrders(pair);
    for (const order of openOrders) {
      await exchange.cancelOrder(order.id!, pair);
      logger.info('CANCEL', `Cleanup: Emir iptal edildi ${order.id}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('ORDER', `Cleanup hatası: ${msg}`);
  }

  activeTrade = null;
}

/**
 * Dry-run modunda sanal trade oluşturur.
 */
function createVirtualTrade(
  signal: TradeSignal,
  quantity: number,
  entryPrice: number,
  tpLevels: TakeProfitLevels,
): ActiveTrade {
  return {
    entryOrder: {
      id: `dry_entry_${Date.now()}`,
      clientOrderId: `dry_entry_${Date.now()}`,
      type: 'ENTRY',
      side: signal.direction === 'LONG' ? 'buy' : 'sell',
      price: entryPrice,
      quantity,
      filledQuantity: 0,
      status: 'OPEN',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    signal,
    tp1Hit: false,
    breakEvenApplied: false,
  };
}
