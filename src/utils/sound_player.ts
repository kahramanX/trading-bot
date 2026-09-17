import { exec } from 'child_process';
import { logger } from './logger.js';

export type SoundEvent = 'SIGNAL' | 'ORDER' | 'PROFIT' | 'LOSS';

// Mac yerleşik ses dosyalarının yolları
const SOUNDS: Record<SoundEvent, string> = {
  SIGNAL: '/System/Library/Sounds/Glass.aiff',
  ORDER: '/System/Library/Sounds/Ping.aiff',
  PROFIT: '/System/Library/Sounds/Hero.aiff',
  LOSS: '/System/Library/Sounds/Basso.aiff',
};

/**
 * Belirtilen olaya ait sesi (Mac afplay ile) asenkron olarak çalar.
 */
export function playSound(event: SoundEvent): void {
  // Sadece Mac'te çalıştığını varsayıyoruz
  if (process.platform !== 'darwin') return;

  const soundPath = SOUNDS[event];
  if (!soundPath) return;

  // Sesi arka planda çal
  exec(`afplay ${soundPath}`, (error) => {
    if (error) {
      // Sessizce hatayı yoksay, botun akışını bozma
      logger.debug('SYSTEM', `Ses çalınamadı: ${error.message}`);
    }
  });
}
