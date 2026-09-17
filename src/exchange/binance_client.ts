// ══════════════════════════════════════════════════════════════
// binance_client.ts — ccxt ile Binance Spot Testnet (Multi-Pair)
// Tüm çiftler için constraints cache'lenir, loadMarkets() zorunlu.
// ══════════════════════════════════════════════════════════════

import { binance as BinanceExchange } from 'ccxt';
import type { BotConfig, SymbolConstraints, Candle } from '../utils/types.js';
import { ohlcvArrayToCandles } from '../utils/candle_utils.js';
import { logger } from '../utils/logger.js';

let exchange: BinanceExchange | null = null;
const constraintsCache = new Map<string, SymbolConstraints>();

/**
 * Binance Testnet exchange instance'ını başlatır.
 * loadMarkets() ile tüm piyasa bilgilerini yükler.
 */
export async function initExchange(config: BotConfig): Promise<BinanceExchange> {
  if (exchange) return exchange;

  exchange = new BinanceExchange({
    apiKey: config.apiKey,
    secret: config.apiSecret,
    enableRateLimit: true,
    options: {
      defaultType: 'spot',
      adjustForTimeDifference: true,
    },
  });

  exchange.setSandboxMode(true);
  logger.info('SYSTEM', `Binance Spot Testnet bağlantısı kuruluyor...`);

  // ─── loadMarkets() zorunlu — tüm sembol bilgilerini yükle ─
  await exchange.loadMarkets();
  logger.info('SYSTEM', `✅ Piyasa bilgileri yüklendi: ${Object.keys(exchange.markets ?? {}).length} sembol`);

  // ─── Bağlantı Testi ──────────────────────────────────────
  try {
    const balance = await exchange.fetchBalance();
    const usdtBalance = balance['USDT'];
    const free = usdtBalance?.free ?? 0;
    const total = usdtBalance?.total ?? 0;
    logger.info('SYSTEM', `✅ Bağlantı başarılı! Kasa: ${logger.formatUSD(Number(free))} serbest / ${logger.formatUSD(Number(total))} toplam USDT`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`❌ Binance Testnet bağlantı hatası: ${msg}`);
  }

  // ─── Tüm konfigüre edilmiş çiftlerin constraints'lerini preload et
  for (const symbol of config.tradingPairs) {
    try {
      await getSymbolConstraints(symbol);
      logger.info('SYSTEM', `  📋 ${symbol} — kısıtlamalar yüklendi`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('SYSTEM', `  ⚠️ ${symbol} — kısıtlamalar alınamadı: ${msg}`);
    }
  }

  return exchange;
}

export function getExchange(): BinanceExchange {
  if (!exchange) {
    throw new Error('Exchange henüz başlatılmadı. Önce initExchange() çağırın.');
  }
  return exchange;
}

/**
 * Belirtilen sembol için borsa kısıtlamalarını döndürür.
 * İlk çağrıda exchangeInfo'dan okur, sonraki çağrılarda cache'ten döner.
 */
export async function getSymbolConstraints(symbol: string): Promise<SymbolConstraints> {
  const cached = constraintsCache.get(symbol);
  if (cached) return cached;

  const ex = getExchange();

  if (!ex.markets || Object.keys(ex.markets).length === 0) {
    await ex.loadMarkets();
  }

  const market = ex.market(symbol);
  if (!market) {
    throw new Error(`❌ Sembol bulunamadı: ${symbol}`);
  }

  let minQty = market.limits.amount?.min ?? 0.00001;
  let maxQty = market.limits.amount?.max ?? 9999999;
  let stepSize = 0.00001;
  let tickSize = 0.01;
  let minNotional = market.limits.cost?.min ?? 5;

  // 1. Binance native filters (en güvenilir kaynak)
  const filters = (market.info as Record<string, unknown> | undefined)?.filters;
  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (typeof f === 'object' && f !== null) {
        const filter = f as Record<string, string>;
        if (filter.filterType === 'LOT_SIZE') {
          if (filter.minQty) minQty = parseFloat(filter.minQty);
          if (filter.maxQty) maxQty = parseFloat(filter.maxQty);
          if (filter.stepSize) stepSize = parseFloat(filter.stepSize);
        } else if (filter.filterType === 'PRICE_FILTER') {
          if (filter.tickSize) tickSize = parseFloat(filter.tickSize);
        } else if (filter.filterType === 'MIN_NOTIONAL' || filter.filterType === 'NOTIONAL') {
          if (filter.minNotional) minNotional = parseFloat(filter.minNotional);
        }
      }
    }
  } else {
    // 2. ccxt precision fallback
    if (market.precision.amount != null) {
      const p = Number(market.precision.amount);
      stepSize = p < 1 ? p : 1 / Math.pow(10, p);
    }
    if (market.precision.price != null) {
      const p = Number(market.precision.price);
      tickSize = p < 1 ? p : 1 / Math.pow(10, p);
    }
  }

  const constraints: SymbolConstraints = {
    symbol,
    minQty,
    maxQty,
    stepSize,
    minNotional,
    tickSize,
    minPrice:    market.limits.price?.min ?? 0.01,
    maxPrice:    market.limits.price?.max ?? 999999,
  };

  constraintsCache.set(symbol, constraints);

  logger.debug('SYSTEM', `${symbol} kısıtlamaları: ` +
    `minQty=${constraints.minQty} stepSize=${constraints.stepSize} ` +
    `minNotional=$${constraints.minNotional} tickSize=${constraints.tickSize}`);

  return constraints;
}

/**
 * OHLCV mum verisi çeker. Rate limit ccxt tarafından yönetilir.
 */
export async function fetchCandles(
  symbol: string,
  timeframe: string,
  limit: number = 200,
): Promise<Candle[]> {
  const ex = getExchange();
  const ohlcv = await ex.fetchOHLCV(symbol, timeframe, undefined, limit);

  if (!ohlcv || ohlcv.length === 0) {
    logger.warn('SYSTEM', `Mum verisi alınamadı: ${symbol} ${timeframe}`);
    return [];
  }

  return ohlcvArrayToCandles(ohlcv as number[][]);
}

export async function getFreeBalance(asset: string = 'USDT'): Promise<number> {
  const ex = getExchange();
  const balance = await ex.fetchBalance();
  return Number(balance[asset]?.free ?? 0);
}

export async function getTotalBalance(asset: string = 'USDT'): Promise<number> {
  const ex = getExchange();
  const balance = await ex.fetchBalance();
  return Number(balance[asset]?.total ?? 0);
}

export async function getCurrentPrice(symbol: string): Promise<number> {
  const ex = getExchange();
  const ticker = await ex.fetchTicker(symbol);
  return ticker.last ?? 0;
}
