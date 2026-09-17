// ══════════════════════════════════════════════════════════════
// trade_persistence.ts — Aktif İşlem Durumu Disk Persistansı
// Bot restart'ında açık pozisyonların kaybolmasını engeller.
// Atomic write: tmp → bak → rename (veri kaybına dayanıklı).
// ══════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import type { ActiveTrade } from '../utils/types.js';
import { logger } from '../utils/logger.js';

const STATE_FILE = 'active_trades_state.json';

function getStatePath(): string {
  return path.resolve(process.cwd(), STATE_FILE);
}

/**
 * Aktif işlemleri diske yazar (atomic write).
 * Her activeTrades değişikliğinde çağrılmalı.
 */
export function saveActiveTrades(trades: Map<string, ActiveTrade>): void {
  const filePath = getStatePath();
  const tmpPath = `${filePath}.tmp`;
  const bakPath = `${filePath}.bak`;

  try {
    const data = Object.fromEntries(trades);
    const json = JSON.stringify(data, null, 2);

    // 1. Geçici dosyaya yaz
    fs.writeFileSync(tmpPath, json, 'utf-8');

    // 2. Mevcut dosyayı yedeğe taşı
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, bakPath);
    }

    // 3. Geçici dosyayı asıl dosyaya taşı
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('ORDER', `Aktif işlem durumu diske yazılamadı: ${msg}`);
  }
}

/**
 * Aktif işlemleri diskten yükler (başlangıçta).
 * Dosya yoksa veya bozuksa boş Map döner.
 */
export function loadActiveTrades(): Map<string, ActiveTrade> {
  const filePath = getStatePath();
  const bakPath = `${filePath}.bak`;

  let raw = '';
  let loadedFromBak = false;

  // Ana dosyayı oku
  try {
    if (fs.existsSync(filePath)) {
      raw = fs.readFileSync(filePath, 'utf-8');
      JSON.parse(raw); // Parse test
    }
  } catch {
    logger.warn('ORDER', 'Aktif işlem dosyası bozuk. Yedek (.bak) dosyasına geçiliyor...');
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
      const data = JSON.parse(raw) as Record<string, ActiveTrade>;
      const map = new Map<string, ActiveTrade>(Object.entries(data));

      if (loadedFromBak) {
        logger.info('ORDER', 'Aktif işlemler yedek dosyadan kurtarıldı.');
      }

      if (map.size > 0) {
        logger.info('ORDER', `📂 Diskten ${map.size} aktif işlem yüklendi: ${[...map.keys()].join(', ')}`);
      }

      return map;
    }
  } catch {
    logger.warn('ORDER', 'Aktif işlem durumu dosyaları kurtarılamaz. Boş başlatılıyor.');
  }

  return new Map();
}

/**
 * Aktif işlem dosyasını temizler (tüm işlemler kapandığında).
 */
export function clearActiveTradesFile(): void {
  const filePath = getStatePath();
  try {
    if (fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '{}', 'utf-8');
    }
  } catch {
    // Sessiz
  }
}
