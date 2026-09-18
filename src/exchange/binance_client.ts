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
 * R-05 FIX: Exponential backoff retry wrapper.
 * Sadece okuma (read) işlemlerinde kullanılır.
 * Yaz (write) işlemlerinde (emir gönderme) ÇİFT EMİR riski nedeniyle KULLANILMAZ.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries: number = 3,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        logger.warn('SYSTEM', `${label} failed (attempt ${attempt}/${maxRetries}): ${lastError.message}. Retrying in ${waitMs / 1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  throw lastError!;
}

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
      defaultType: config.marketType === 'futures' ? 'future' : 'spot',
      adjustForTimeDifference: true,
    },
  });

  if (config.network === 'testnet') {
    exchange.setSandboxMode(true);
    logger.info('SYSTEM', `Connecting to Binance Spot Testnet...`);
  } else if (config.network === 'demo') {
    exchange.urls.test = exchange.urls.demo;
    exchange.setSandboxMode(true);
    logger.info('SYSTEM', `Connecting to Binance Spot DEMO (Mock Trading)...`);
  } else {
    logger.info('SYSTEM', `Connecting to Binance Spot LIVE (Real Money)...`);
  }

  // ─── loadMarkets() zorunlu — tüm sembol bilgilerini yükle ─
  await exchange.loadMarkets();
  logger.info('SYSTEM', `✅ Market data loaded: ${Object.keys(exchange.markets ?? {}).length} symbols`);

  // ─── Futures ayarları: Margin ve Kaldıraç ─────────────────
  if (config.marketType === 'futures') {
    logger.info('SYSTEM', `⚙️ Configuring Futures... Margin: Isolated | Leverage: ${config.leverage}x`);
    for (const symbol of config.tradingPairs) {
      try {
        await exchange.setMarginMode('isolated', symbol);
      } catch (e: any) {
        const errorMsg = e.message || '';
        const isHarmless = errorMsg.includes('No need to change margin type') || 
                           errorMsg.includes('-4067') || 
                           errorMsg.includes('Position side cannot be changed');
        if (!isHarmless) {
          logger.warn('SYSTEM', `  ⚠️ ${symbol} failed to set margin mode: ${errorMsg}`);
        }
      }
      try {
        await exchange.setLeverage(config.leverage, symbol);
      } catch (e: any) {
        logger.warn('SYSTEM', `  ⚠️ ${symbol} failed to set leverage: ${e.message}`);
      }
    }
  }

  // ─── Bağlantı Testi ──────────────────────────────────────
  try {
    const balance = await exchange.fetchBalance();
    const usdtBalance = balance['USDT'];
    const free = usdtBalance?.free ?? 0;
    const total = usdtBalance?.total ?? 0;
    logger.info('SYSTEM', `✅ Connection successful! Balance: ${logger.formatUSD(Number(free))} free / ${logger.formatUSD(Number(total))} total USDT`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`❌ Binance bağlantı hatası: ${msg}`);
  }

  // ─── Tüm konfigüre edilmiş çiftlerin constraints'lerini preload et
  for (const symbol of config.tradingPairs) {
    try {
      await getSymbolConstraints(symbol);
      logger.info('SYSTEM', `  📋 ${symbol} — constraints loaded`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('SYSTEM', `  ⚠️ ${symbol} — failed to load constraints: ${msg}`);
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

  logger.debug('SYSTEM', `${symbol} constraints: ` +
    `minQty=${constraints.minQty} stepSize=${constraints.stepSize} ` +
    `minNotional=$${constraints.minNotional} tickSize=${constraints.tickSize}`);

  return constraints;
}

/**
 * OHLCV mum verisi çeker. R-05 FIX: Retry mekanizması dahil.
 */
export async function fetchCandles(
  symbol: string,
  timeframe: string,
  limit: number = 200,
): Promise<Candle[]> {
  const ex = getExchange();
  const ohlcv = await withRetry(
    () => ex.fetchOHLCV(symbol, timeframe, undefined, limit),
    `fetchCandles(${symbol}, ${timeframe})`,
  );

  if (!ohlcv || ohlcv.length === 0) {
    logger.warn('SYSTEM', `Failed to fetch candle data: ${symbol} ${timeframe}`);
    return [];
  }

  return ohlcvArrayToCandles(ohlcv as number[][]);
}

export async function getFreeBalance(asset: string = 'USDT'): Promise<number> {
  const ex = getExchange();
  const balance = await withRetry(
    () => ex.fetchBalance(),
    `getFreeBalance(${asset})`,
  );
  return Number(balance[asset]?.free ?? 0);
}

export async function getTotalBalance(asset: string = 'USDT'): Promise<number> {
  const ex = getExchange();
  const balance = await withRetry(
    () => ex.fetchBalance(),
    `getTotalBalance(${asset})`,
  );
  return Number(balance[asset]?.total ?? 0);
}

export async function getCurrentPrice(symbol: string): Promise<number> {
  const ex = getExchange();
  const ticker = await withRetry(
    () => ex.fetchTicker(symbol),
    `getCurrentPrice(${symbol})`,
  );
  return ticker.last ?? 0;
}

/**
 * Gets the actual position size from Binance for a specific symbol.
 * Returns the absolute quantity held. If no position, returns 0.
 */
export async function fetchPosition(symbol: string, marketType: 'spot' | 'futures'): Promise<number> {
  const ex = getExchange();
  try {
    if (marketType === 'futures') {
      const positions = await withRetry(
        () => ex.fetchPositions([symbol]),
        `fetchPositions(${symbol})`
      );
      if (positions && positions.length > 0) {
        return Math.abs(positions[0].contracts || 0); // ccxt unified size
      }
      return 0;
    } else {
      // For spot, find the base currency (e.g. BTC from BTC/USDT)
      const baseAsset = symbol.split('/')[0];
      if (!baseAsset) return 0;
      
      const balance = await withRetry(
        () => ex.fetchBalance(),
        `fetchBalance(${baseAsset})`
      );
      
      return Number(balance[baseAsset]?.total ?? 0);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('SYSTEM', `Failed to fetch position for ${symbol}: ${msg}`);
    return 0; // On error, we assume 0 or handle it gracefully
  }
}
