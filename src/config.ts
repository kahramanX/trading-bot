// ══════════════════════════════════════════════════════════════
// config.ts — Tip-güvenli konfigürasyon yönetimi (Multi-Pair)
// .env dosyasından okur, doğrular, ve BotConfig döndürür.
// ══════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
import type { BotConfig } from './utils/types.js';
import { strategyConfig } from './bot.config.js';

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

export function loadConfig(): BotConfig {
  const config: BotConfig = {
    ...strategyConfig,
    apiKey:    requireEnv('BINANCE_API_KEY'),
    apiSecret: requireEnv('BINANCE_SECRET'),
    network:   (['live', 'demo'].includes(process.env['NETWORK']?.trim().toLowerCase() || '') ? process.env['NETWORK']?.trim().toLowerCase() as 'live' | 'demo' : 'testnet'),
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
  if (config.circuitBreakerCooldownHours <= 0 || config.circuitBreakerCooldownHours > 72) {
    errors.push(`circuitBreakerCooldownHours = ${config.circuitBreakerCooldownHours} — 0-72 saat arasında olmalı`);
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

  // R-04 FIX: Ağırlıklı RR'ın minRRRatio'yu geçip geçemeyeceğini baştan kontrol et
  const weightedRR = (config.tp1RR * 0.5) + (config.tp2RR * 0.5);
  if (weightedRR < config.minRRRatio) {
    errors.push(`Ağırlıklı R:R (${weightedRR.toFixed(2)}) < minRRRatio (${config.minRRRatio}) — tüm sinyaller reddedilecek!`);
  }

  // C-02 FIX: Spot piyasada SHORT desteklenmez — uyarı
  if (config.marketType === 'spot') {
    // Hata fırlatma, sadece bilgilendirme (strateji motorunda engellenecek)
    console.warn('⚠️  Spot piyasada SHORT sinyalleri desteklenmez. Sadece LONG sinyalleri işlenecektir.');
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
