import { exec } from 'child_process';
import { logger } from './logger.js';

export type SoundEvent = 'SIGNAL' | 'ORDER' | 'PROFIT' | 'LOSS' | 'ERROR';

// Mac yerleşik ses dosyalarının yolları
const MAC_SOUNDS: Record<SoundEvent, string> = {
  SIGNAL: '/System/Library/Sounds/Glass.aiff',
  ORDER: '/System/Library/Sounds/Ping.aiff',
  PROFIT: '/System/Library/Sounds/Hero.aiff',
  LOSS: '/System/Library/Sounds/Basso.aiff',
  ERROR: '/System/Library/Sounds/Sosumi.aiff',
};

// Windows yerleşik ses dosyalarının yolları
const WIN_SOUNDS: Record<SoundEvent, string> = {
  SIGNAL: 'C:\\Windows\\Media\\Windows Ding.wav',
  ORDER: 'C:\\Windows\\Media\\Windows Notify System Generic.wav',
  PROFIT: 'C:\\Windows\\Media\\tada.wav',
  LOSS: 'C:\\Windows\\Media\\Windows Critical Stop.wav',
  ERROR: 'C:\\Windows\\Media\\Windows Error.wav',
};

/**
 * Belirtilen olaya ait sesi asenkron olarak çalar.
 * İşletim sistemini tanıyıp kendi yerleşik seslerini kullanır.
 */
export function playSound(event: SoundEvent): void {
  // .env üzerinden ses kapatıldıysa çalma (varsayılan: true)
  if (process.env.ENABLE_SOUND === 'false') return;

  const platform = process.platform;
  let command = '';

  if (platform === 'darwin') {
    const soundPath = MAC_SOUNDS[event];
    if (soundPath) command = `afplay "${soundPath}"`;
  } else if (platform === 'win32') {
    const soundPath = WIN_SOUNDS[event];
    // PowerShell ile yerleşik bir .wav dosyasını arka planda çal
    if (soundPath) command = `powershell -c (New-Object Media.SoundPlayer '${soundPath}').PlaySync()`;
  } else {
    // Linux vb. desteklenmiyor
    return;
  }

  if (!command) return;

  // Sesi arka planda çal
  exec(command, (error) => {
    if (error) {
      // Sessizce hatayı yoksay, botun akışını bozma
      logger.debug('SYSTEM', `Ses çalınamadı: ${error.message}`);
    }
  });
}
