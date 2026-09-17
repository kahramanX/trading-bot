// ══════════════════════════════════════════════════════════════
// config.ts — Tip-güvenli konfigürasyon yönetimi (Multi-Pair)
// .env dosyasından okur, doğrular, ve BotConfig döndürür.
// ══════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
import type { BotConfig } from './utils/types.js';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(
      `❌ Eksik ortam değişkeni: ${key}\n` +
      `   .env dosyanızı kontrol edin. Örnek: .env.example`
    );
  }
  return value.trim();
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) throw new Error(`❌ Geçersiz sayı değeri: ${key}=${raw}`);
  return parsed;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`❌ Geçersiz tam sayı değeri: ${key}=${raw}`);
  return parsed;
}

/**
 * Virgülle ayrılmış işlem çiftlerini parse eder.
 * Boşlukları temizler, büyük harfe çevirir, '/' kontrolü yapar.
 */
function parseTradingPairs(raw: string): string[] {
  const pairs = raw
    .split(',')
    .map(p => p.trim().toUpperCase())
    .filter(p => p.length > 0);

  if (pairs.length === 0) {
    throw new Error('❌ En az bir işlem çifti belirtilmeli: TRADING_PAIRS=BTC/USDT,ETH/USDT');
  }

  for (const pair of pairs) {
    if (!pair.includes('/')) {
      throw new Error(`❌ Geçersiz çift formatı: "${pair}" — doğru format: BTC/USDT`);
    }
  }

  // Duplike kontrolü
  const unique = [...new Set(pairs)];
  if (unique.length !== pairs.length) {
    throw new Error(`❌ Tekrarlanan çiftler tespit edildi: ${raw}`);
  }

  return pairs;
}

export function loadConfig(): BotConfig {
  // ─── Multi-Pair: virgülle ayrılmış liste ─────────────────
  const rawPairs = requireEnv('TRADING_PAIRS');
  const tradingPairs = parseTradingPairs(rawPairs);

  const config: BotConfig = {
    apiKey:    requireEnv('BINANCE_TESTNET_API_KEY'),
    apiSecret: requireEnv('BINANCE_TESTNET_SECRET'),

    tradingPairs,

    riskPerTradePct:       envFloat('RISK_PER_TRADE_PCT', 1),
    maxDailyLossPct:       envFloat('MAX_DAILY_LOSS_PCT', 3),
    maxConsecutiveLosses:  envInt('MAX_CONSECUTIVE_LOSSES', 3),

    minRRRatio: envFloat('MIN_RR_RATIO', 2.5),
    tp1RR:      envFloat('TP1_RR', 2),
    tp2RR:      envFloat('TP2_RR', 3),

    htfTimeframe: process.env['HTF_TIMEFRAME']?.trim() || '4h',
    ltfTimeframe: process.env['LTF_TIMEFRAME']?.trim() || '15m',

    makerFeePct:   envFloat('MAKER_FEE_PCT', 0.1),
    takerFeePct:   envFloat('TAKER_FEE_PCT', 0.1),
    slippageTicks: envInt('SLIPPAGE_TICKS', 2),

    dryRun: process.argv.includes('--dry-run'),
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: BotConfig): void {
  const errors: string[] = [];

  if (config.riskPerTradePct <= 0 || config.riskPerTradePct > 5) {
    errors.push(`riskPerTradePct = %${config.riskPerTradePct} — %0-%5 arasında olmalı`);
  }
  if (config.maxDailyLossPct <= 0 || config.maxDailyLossPct > 10) {
    errors.push(`maxDailyLossPct = %${config.maxDailyLossPct} — %0-%10 arasında olmalı`);
  }
  if (config.maxConsecutiveLosses < 1 || config.maxConsecutiveLosses > 10) {
    errors.push(`maxConsecutiveLosses = ${config.maxConsecutiveLosses} — 1-10 arasında olmalı`);
  }
  if (config.minRRRatio < 1) {
    errors.push(`minRRRatio = ${config.minRRRatio} — minimum 1:1 olmalı`);
  }
  if (config.tp1RR >= config.tp2RR) {
    errors.push(`tp1RR (${config.tp1RR}) tp2RR'den (${config.tp2RR}) küçük olmalı`);
  }
  if (config.makerFeePct < 0 || config.takerFeePct < 0) {
    errors.push('Komisyon oranları negatif olamaz');
  }

  const validTF = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];
  if (!validTF.includes(config.htfTimeframe)) {
    errors.push(`htfTimeframe = "${config.htfTimeframe}" — geçerli değil`);
  }
  if (!validTF.includes(config.ltfTimeframe)) {
    errors.push(`ltfTimeframe = "${config.ltfTimeframe}" — geçerli değil`);
  }

  if (config.tradingPairs.length > 20) {
    errors.push(`Çok fazla çift: ${config.tradingPairs.length} — maksimum 20`);
  }

  if (errors.length > 0) {
    throw new Error(`❌ Konfigürasyon hatası:\n${errors.map(e => `   • ${e}`).join('\n')}`);
  }
}
