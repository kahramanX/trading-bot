// ══════════════════════════════════════════════════════════════
// circuit_breaker.ts — Günlük Şalter (İntikam İşlemi Koruması)
// 3 ardışık SL veya günlük %3 kayıp → 24 saat uyku.
// Durum diske persist edilir (restart'a dayanıklı).
// ══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import type { CircuitBreakerState, TradeResult, BotConfig } from '../utils/types.js';
import { logger } from '../utils/logger.js';

const STATE_FILE = 'circuit_breaker_state.json';

function createDefaultState(balance: number): CircuitBreakerState {
  return {
    consecutiveLosses: 0,
    dailyPnL: 0,
    dailyStartBalance: balance,
    dailyDate: new Date().toISOString().split('T')[0]!,
    isTripped: false,
    tradeHistory: [],
  };
}

function getStatePath(): string {
  return path.resolve(process.cwd(), STATE_FILE);
}

export function loadState(currentBalance: number, _config?: BotConfig): CircuitBreakerState {
  const filePath = getStatePath();
  const bakPath = `${filePath}.bak`;
  
  let raw = '';
  let loadedFromBak = false;

  try {
    if (fs.existsSync(filePath)) {
      raw = fs.readFileSync(filePath, 'utf-8');
      JSON.parse(raw); // Parse test
    }
  } catch (err) {
    logger.warn('GUARD', 'Durum dosyası (JSON) bozuk veya okunamıyor. Yedek (.bak) dosyasına geçiliyor...');
    try {
      if (fs.existsSync(bakPath)) {
        raw = fs.readFileSync(bakPath, 'utf-8');
        loadedFromBak = true;
      }
    } catch {
      // Bak de bozuk
    }
  }

  try {
    if (raw) {
      const state = JSON.parse(raw) as CircuitBreakerState;
      if (loadedFromBak) logger.info('GUARD', 'Yedek dosyadan durum başarıyla kurtarıldı.');

      const today = new Date().toISOString().split('T')[0]!;
      if (state.dailyDate !== today) {
        logger.info('GUARD', `🌅 Yeni gün (${today}) başladı. Gece Reseti: Günlük sayaçlar ve Circuit Breaker sıfırlandı.`);
        const newState = createDefaultState(currentBalance);
        saveState(newState);
        return newState;
      }

      if (state.isTripped && state.resumeAt) {
        if (Date.now() >= new Date(state.resumeAt).getTime()) {
          logger.info('GUARD', `⏰ Cooldown süresi doldu. Circuit Breaker devreden çıkarıldı.`);
          state.isTripped = false;
          state.tripReason = undefined;
          state.resumeAt = undefined;
          state.consecutiveLosses = 0;
          saveState(state);
          return state;
        }
      }

      return state;
    }
  } catch {
    logger.warn('GUARD', 'Durum ve yedek dosyaları tamamen kurtarılamaz durumda. Varsayılan (sıfırlanmış) durum kullanılıyor. Dikkat!');
  }
  const defaultState = createDefaultState(currentBalance);
  saveState(defaultState);
  return defaultState;
}

export function saveState(state: CircuitBreakerState): void {
  const filePath = getStatePath();
  const tmpPath = `${filePath}.tmp`;
  const bakPath = `${filePath}.bak`;

  try {
    // 1. Önce geçici dosyaya (temp) yaz
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    
    // 2. Eğer asıl dosya varsa, onu yedeğe (.bak) taşı
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, bakPath);
    }

    // 3. Geçici dosyayı asıl dosyaya (.json) taşı
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('GUARD', `Durum dosyası atomic yazılamadı: ${msg}`);
  }
}

export function isCircuitBreakerTripped(state: CircuitBreakerState): boolean {
  if (!state.isTripped) return false;

  const resumeAt = state.resumeAt ? new Date(state.resumeAt) : null;
  const remaining = resumeAt ? Math.max(0, resumeAt.getTime() - Date.now()) : 0;
  const hours = (remaining / (1000 * 60 * 60)).toFixed(1);

  logger.warn('GUARD', `🚫 Circuit Breaker AKTİF! Sebep: ${state.tripReason}`);
  logger.warn('GUARD', `   Kalan: ${hours} saat | Devam: ${resumeAt?.toLocaleTimeString('tr-TR') ?? '?'}`);
  return true;
}

export function recordTradeResult(
  state: CircuitBreakerState,
  result: TradeResult,
  config: BotConfig,
): CircuitBreakerState {
  const newState: CircuitBreakerState = { ...state, tradeHistory: [...state.tradeHistory] };

  newState.tradeHistory.push(result);
  newState.dailyPnL += result.pnl;

  // C-05 FIX: Ghost cancel bir gerçek işlem değil — consecutiveLosses'ı etkilememeli
  if (result.exitReason === 'GHOST_CANCEL') {
    // Sadece tradeHistory'ye kaydedildi, sayaçlara dokunulmadı
    logger.info('GUARD', `⚪ [${result.symbol}] Ghost cancel kaydedildi (sayaçları etkilemez).`);
    saveState(newState);
    return newState;
  }

  if (!result.isWin) {
    newState.consecutiveLosses += 1;
  } else {
    newState.consecutiveLosses = 0;
  }

  const emoji = result.isWin ? '🟢' : '🔴';
  logger.info('GUARD', `${emoji} [${result.symbol}] P&L ${logger.formatUSD(result.pnl)} | ` +
    `Ardışık kayıp: ${newState.consecutiveLosses}/${config.maxConsecutiveLosses} | ` +
    `Günlük P&L: ${logger.formatUSD(newState.dailyPnL)}`);

  if (newState.consecutiveLosses >= config.maxConsecutiveLosses) {
    return tripCircuitBreaker(newState, `${config.maxConsecutiveLosses} ardışık stop-loss.`, config);
  }

  const dailyLossPct = (Math.abs(newState.dailyPnL) / newState.dailyStartBalance) * 100;
  if (newState.dailyPnL < 0 && dailyLossPct >= config.maxDailyLossPct) {
    return tripCircuitBreaker(newState, `Günlük kayıp ${logger.formatPct(dailyLossPct)} ≥ ${logger.formatPct(config.maxDailyLossPct)}`, config);
  }

  saveState(newState);
  return newState;
}

function tripCircuitBreaker(state: CircuitBreakerState, reason: string, config?: BotConfig): CircuitBreakerState {
  const cooldownHours = config?.circuitBreakerCooldownHours ?? 4;
  const resumeAt = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);
  state.isTripped = true;
  state.tripReason = reason;
  state.resumeAt = resumeAt.toISOString();

  logger.separator();
  logger.warn('GUARD', `🚨 CIRCUIT BREAKER TETİKLENDİ!`);
  logger.warn('GUARD', `   Sebep: ${reason}`);
  logger.warn('GUARD', `   ${cooldownHours} saat cooldown. Devam: ${resumeAt.toLocaleString('tr-TR')}`);
  logger.warn('GUARD', `   Piyasa oturana kadar yeni işlem durduruldu. 🛡️`);
  logger.separator();

  saveState(state);
  return state;
}

export function logCircuitBreakerStatus(state: CircuitBreakerState, config: BotConfig): void {
  if (state.isTripped) { isCircuitBreakerTripped(state); return; }

  const dailyLossPct = state.dailyStartBalance > 0
    ? (Math.abs(state.dailyPnL) / state.dailyStartBalance) * 100 : 0;

  logger.info('GUARD', `Circuit Breaker: OK | ` +
    `Kayıp: ${state.consecutiveLosses}/${config.maxConsecutiveLosses} | ` +
    `Günlük P&L: ${logger.formatUSD(state.dailyPnL)} (${logger.formatPct(dailyLossPct)}/${logger.formatPct(config.maxDailyLossPct)})`);
}
