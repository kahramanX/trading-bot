// ══════════════════════════════════════════════════════════════
// candle_utils.ts — Mum verisi dönüşüm ve hesaplama yardımcıları
// ccxt'nin ham OHLCV dizilerini tipli Candle objelerine çevirir
// ══════════════════════════════════════════════════════════════

import type { Candle } from './types.js';

/**
 * ccxt OHLCV dizisini tipli Candle objesine dönüştürür.
 * ccxt formatı: [timestamp, open, high, low, close, volume]
 */
export function ohlcvToCandle(ohlcv: number[]): Candle {
  return {
    timestamp: ohlcv[0]!,
    open:      ohlcv[1]!,
    high:      ohlcv[2]!,
    low:       ohlcv[3]!,
    close:     ohlcv[4]!,
    volume:    ohlcv[5]!,
  };
}

/**
 * ccxt OHLCV dizisini toplu Candle dizisine dönüştürür.
 */
export function ohlcvArrayToCandles(ohlcvArray: number[][]): Candle[] {
  return ohlcvArray.map(ohlcvToCandle);
}

/**
 * ATR (Average True Range) hesaplar.
 * Price Action'da volatilite bazlı SL mesafesi için kullanılır.
 *
 * @param candles  - Mum dizisi (en az period+1 mum gerekir)
 * @param period   - ATR periyodu (varsayılan 14)
 * @returns ATR değeri veya yetersiz veri varsa null
 */
export function calculateATR(candles: Candle[], period: number = 14): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  // True Range hesapla
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const previous = candles[i - 1]!;

    const tr = Math.max(
      current.high - current.low,                      // Güncel mum aralığı
      Math.abs(current.high - previous.close),         // Güncel high - önceki close
      Math.abs(current.low - previous.close),          // Güncel low - önceki close
    );
    trueRanges.push(tr);
  }

  // Son 'period' True Range'in ortalaması (SMA-based ATR)
  const recentTRs = trueRanges.slice(-period);
  const atr = recentTRs.reduce((sum, tr) => sum + tr, 0) / period;

  return atr;
}

/**
 * EMA (Exponential Moving Average) hesaplar.
 * Sadece HTF trend filtresi (EMA 200) için kullanılır.
 *
 * @param candles - Mum dizisi
 * @param period  - EMA periyodu (varsayılan 200)
 * @returns EMA değerleri dizisi (son candles.length - period + 1 eleman)
 */
export function calculateEMA(candles: Candle[], period: number = 200): number[] {
  if (candles.length < 10) {
    return [];
  }

  // Testnet ortamlarında mum sayısı 200'den az olabilir.
  // Bu durumda mevcut geçmişe göre uyarlanmış periyot kullanılır.
  const effectivePeriod = Math.min(period, Math.max(10, Math.floor(candles.length * 0.8)));
  const multiplier = 2 / (effectivePeriod + 1);
  const emaValues: number[] = [];

  // İlk EMA = ilk 'effectivePeriod' mumun SMA'sı
  let sum = 0;
  for (let i = 0; i < effectivePeriod; i++) {
    sum += candles[i]!.close;
  }
  let ema = sum / effectivePeriod;
  emaValues.push(ema);

  // Geri kalan mumlar için EMA hesapla
  for (let i = effectivePeriod; i < candles.length; i++) {
    ema = (candles[i]!.close - ema) * multiplier + ema;
    emaValues.push(ema);
  }

  return emaValues;
}

/**
 * Bir zaman diliminin milisaniye cinsinden süresini döndürür.
 * ccxt timeframe formatını destekler: '1m', '5m', '15m', '1h', '4h', '1d'
 */
export function timeframeToMs(timeframe: string): number {
  const match = timeframe.match(/^(\d+)([mhdwM])$/);
  if (!match) {
    throw new Error(`Geçersiz zaman dilimi: ${timeframe}`);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  const multipliers: Record<string, number> = {
    'm': 60 * 1000,
    'h': 60 * 60 * 1000,
    'd': 24 * 60 * 60 * 1000,
    'w': 7 * 24 * 60 * 60 * 1000,
    'M': 30 * 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit]!;
}

/**
 * Bir sonraki mum kapanışına kalan süreyi milisaniye olarak hesaplar.
 * Bot döngüsünü mum kapanışına senkronize etmek için kullanılır.
 *
 * @param timeframe - ccxt zaman dilimi formatı (örn: '15m')
 * @returns Bir sonraki mum kapanışına kalan ms
 */
export function msUntilNextCandleClose(timeframe: string): number {
  const intervalMs = timeframeToMs(timeframe);
  const now = Date.now();
  const currentCandleStart = Math.floor(now / intervalMs) * intervalMs;
  const nextCandleClose = currentCandleStart + intervalMs;

  // Kapanıştan 2 saniye sonra çalış (mum verisi yerleşsin)
  return (nextCandleClose - now) + 2000;
}

/**
 * Fiyatı belirtilen tick size'a yuvarlar.
 * Binance PRICE_FILTER uyumu için gerekli.
 */
export function roundToTickSize(price: number, tickSize: number): number {
  const precision = countDecimals(tickSize);
  return parseFloat((Math.round(price / tickSize) * tickSize).toFixed(precision));
}

/**
 * Miktarı belirtilen step size'a yuvarlar (aşağı).
 * Binance LOT_SIZE uyumu için gerekli.
 */
export function floorToStepSize(quantity: number, stepSize: number): number {
  const precision = countDecimals(stepSize);
  return parseFloat((Math.floor(quantity / stepSize) * stepSize).toFixed(precision));
}

/**
 * Ondalık basamak sayısını hesaplar.
 */
function countDecimals(value: number): number {
  const str = value.toString();
  if (str.includes('.')) {
    return str.split('.')[1]!.length;
  }
  return 0;
}
