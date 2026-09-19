import type { BotConfig } from './utils/types.js';

/**
 * Ana Ticaret Stratejisi Konfigürasyonu
 * Bu dosya canlı (Live), Testnet ve Dry-Run modları için kullanılır.
 * Geliştirici kolaylığı ve tip güvenliği için .env yerine buradan yönetilir.
 */

// API anahtarları, network ve dryRun ayarları src/config.ts içerisinde .env'den alınarak birleştirilir.
export const strategyConfig: Omit<BotConfig, 'apiKey' | 'apiSecret' | 'network' | 'dryRun'> = {
  // ─── Piyasa Tipi ve Kaldıraç ──────────────────────────────
  marketType: 'futures',
  leverage: 20,

  // ─── İşlem Çiftleri ───────────────────────────────────────
  // Tier 1 + Tier 2 Majör Çiftler (Yüksek likidite, düşük spread)
  tradingPairs: [
    "BZ/USDT", "NVDA/USDT", "XAU/USDT", "XPD/USDT"
  ],

  // ─── Risk Yönetimi ────────────────────────────────────────
  riskPerTradePct: 2,               // İşlem başına kasa yüzdesi riski
  maxDailyLossPct: 3,               // Günlük maksimum kayıp yüzdesi (circuit breaker)
  maxConsecutiveLosses: 3,          // Arka arkaya maksimum stop-loss sayısı
  circuitBreakerCooldownHours: 4,   // Şalter atarsa bekleme süresi (saat)
  minSlPct: 0.008,                  // Minimum Stop-Loss yüzdesi (noise filtreleme, %0.8) - 0.008 önerilir

  // ─── R:R Hedefleri ────────────────────────────────────────
  minRRRatio: 2.0,                  // Minimum Risk:Reward oranı
  tp1RR: 2,                         // TP1 R:R seviyesi (%50 pozisyon)
  tp2RR: 3,                         // TP2 R:R seviyesi (kalan %50)

  // ─── Zaman Dilimleri (Timeframes) ─────────────────────────
  htfTimeframe: '1h',               // Yüksek zaman dilimi (trend filtresi)
  ltfTimeframe: '5m',               // Düşük zaman dilimi (giriş sinyalleri)

  // ─── Kurumsal Filtreler (Institutional Filters) ───────────
  adxPeriod: 15,                    // ADX hesaplama periyodu
  adxThreshold: 20,                 // İşleme girmek için gereken minimum ADX momentumu

  useKillzones: false,              // Kripto pazarı 7/24 açık olduğu için killzone filtrelemesi kapalı
  allowedSessions: {
    timezone: 'Europe/Istanbul',
    london: { start: '10:00', end: '13:00' },
    ny: { start: '15:30', end: '19:00' }
  },

  // ─── Komisyon ve Kayma (Slippage) ─────────────────────────
  makerFeePct: 0.02,                // Futures Maker %0.02
  takerFeePct: 0.05,                // Futures Taker %0.05
  slippageTicks: 2                  // Tahmini fiyat kayması (tick sayısı)
};
