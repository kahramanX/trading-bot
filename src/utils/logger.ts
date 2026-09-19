// ══════════════════════════════════════════════════════════════
// logger.ts — Winston tabanlı renkli ve yapılandırılmış loglama
// Bot ne yaptığını ve NEDEN yaptığını her an anlatır.
// ══════════════════════════════════════════════════════════════

import winston from 'winston';
import type { BotConfig } from './types.js';

// ─── Emoji Prefix'leri (modül bazlı) ────────────────────────

const MODULE_ICONS: Record<string, string> = {
  HTF:     '📊 HTF  ',
  LTF:     '🔍 LTF  ',
  FVG:     '📐 FVG  ',
  BRK:     '🧱 BRK  ',
  RISK:    '💰 RISK ',
  SIZE:    '📏 SIZE ',
  ORDER:   '✅ EMIR ',
  GUARD:   '🛡️ GUARD',
  ENGINE:  '⚙️ ENGINE',
  SYSTEM:  '🖥️ SYS  ',
  WARN:    '⚠️ UYARI',
  ERROR:   '❌ HATA ',
  CANCEL:  '🚫 İPTAL',
  FILL:    '🔔 DOLUM',
  MSS:     '🔀 MSS  ',
};

// ─── Renk Kodları ───────────────────────────────────────────

const COLORS = {
  reset:   '\x1b[0m',
  bright:  '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  red:     '\x1b[31m',
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
} as const;

// ─── Seviye Renkleri ────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  info:  COLORS.cyan,
  warn:  COLORS.yellow,
  error: COLORS.red,
  debug: COLORS.gray,
};

// ─── Otomatik Mesaj Renklendirici ───────────────────────────

function colorizeMessage(msg: string): string {
  let output = msg;
  
  // Fiyatlar ve Dolar Tutarları: $62,500.00 -> Bold Yeşil
  output = output.replace(/\$([0-9,.]+)/g, (_, val) => `${COLORS.green}${COLORS.bright}$${val}${COLORS.reset}`);
  
  // Pariteler: [BTC/USDT] -> Bold Cyan
  output = output.replace(/\[([A-Z0-9]+\/[A-Z0-9]+)\]/g, (_, val) => `[${COLORS.cyan}${COLORS.bright}${val}${COLORS.reset}]`);
  
  // Olumlu / Yükseliş: LONG, BUY, TP1, TP2, WIN -> Bold Yeşil
  output = output.replace(/\b(LONG|BUY|TP1|TP2|WIN|BULLISH)\b/g, (_, val) => `${COLORS.green}${COLORS.bright}${val}${COLORS.reset}`);
  
  // Olumsuz / Düşüş: SHORT, SELL, SL, LOSS -> Bold Kırmızı
  output = output.replace(/\b(SHORT|SELL|SL|LOSS|BEARISH)\b/g, (_, val) => `${COLORS.red}${COLORS.bright}${val}${COLORS.reset}`);
  
  // Yüzdeler: %1.00 -> Bold Sarı
  output = output.replace(/%([0-9.]+)/g, (_, val) => `${COLORS.yellow}${COLORS.bright}%${val}${COLORS.reset}`);

  return output;
}

// ─── Custom Format ──────────────────────────────────────────

const botFormat = winston.format.printf(({ level, message, timestamp, module: mod }) => {
  const time = new Date(timestamp as string).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const moduleStr = mod ? (MODULE_ICONS[mod as string] || mod) : '       ';
  const levelColor = LEVEL_COLORS[level] || COLORS.white;
  const separator = `${COLORS.dim}│${COLORS.reset}`;
  const coloredMsg = colorizeMessage(String(message));

  return `${COLORS.gray}[${time}]${COLORS.reset} ${levelColor}${moduleStr}${COLORS.reset} ${separator} ${coloredMsg}`;
});

// ─── Winston Logger Instance ────────────────────────────────

const winstonLogger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    botFormat,
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

// ─── Public API ─────────────────────────────────────────────

export const logger = {
  info(module: string, message: string): void {
    winstonLogger.info(message, { module });
  },

  warn(module: string, message: string): void {
    winstonLogger.warn(message, { module });
  },

  error(module: string, message: string): void {
    winstonLogger.error(message, { module });
  },

  debug(module: string, message: string): void {
    winstonLogger.debug(message, { module });
  },

  separator(): void {
    console.log(`${COLORS.dim}${'─'.repeat(72)}${COLORS.reset}`);
  },

  banner(config: BotConfig): void {
    const net = (config.network ?? 'demo').toUpperCase();
    const mType = (config.marketType ?? 'futures').toUpperCase();
    const levStr = config.marketType === 'futures' && config.leverage ? ` (${config.leverage}x)` : '';
    const modeStr = config.dryRun ? `${COLORS.yellow}DRY-RUN 🧪${COLORS.reset}` : `${COLORS.green}LIVE 🔴${COLORS.reset}`;
    const kzStr = config.useKillzones
      ? `${COLORS.green}Enabled${COLORS.reset} (TZ: ${config.allowedSessions.timezone} | London: ${config.allowedSessions.london.start}-${config.allowedSessions.london.end} | NY: ${config.allowedSessions.ny.start}-${config.allowedSessions.ny.end})`
      : `${COLORS.dim}Disabled (24/7 Trading)${COLORS.reset}`;

    console.log('');
    console.log(`${COLORS.bright}${COLORS.cyan}╔══════════════════════════════════════════════════════════════════════════════════╗${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║                  ⚡ PRICE ACTION TRADING BOT — CONFIGURATION ⚡                   ║${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}╠══════════════════════════════════════════════════════════════════════════════════╣${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset} ${COLORS.bright}[NETWORK & MODE]${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}   Network: ${COLORS.bright}${net}${COLORS.reset} │ Market: ${COLORS.bright}${mType}${levStr}${COLORS.reset} │ Mode: ${modeStr}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset} ${COLORS.bright}[RISK & POSITION MANAGEMENT]${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}   Risk / Trade: ${COLORS.bright}%${config.riskPerTradePct}${COLORS.reset} │ Max Daily Loss: ${COLORS.bright}%${config.maxDailyLossPct}${COLORS.reset} │ Max Cons. Losses: ${COLORS.bright}${config.maxConsecutiveLosses}${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}   CB Cooldown: ${COLORS.bright}${config.circuitBreakerCooldownHours}h${COLORS.reset} │ Min SL Distance: ${COLORS.bright}%${(config.minSlPct * 100).toFixed(2)}${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}   TP1 R:R: ${COLORS.bright}1:${config.tp1RR}${COLORS.reset} │ TP2 R:R: ${COLORS.bright}1:${config.tp2RR}${COLORS.reset} │ Min R:R Ratio: ${COLORS.bright}1:${config.minRRRatio}${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset} ${COLORS.bright}[STRATEGY & INSTITUTIONAL FILTERS]${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}   Timeframes: ${COLORS.bright}HTF ${config.htfTimeframe} / LTF ${config.ltfTimeframe}${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}   ADX Filter: ${COLORS.bright}Period ${config.adxPeriod} | Threshold ${config.adxThreshold}${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}   Killzones (Session Filter): ${kzStr}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset} ${COLORS.bright}[ACTIVE TRADING PAIRS (${config.tradingPairs.length})]${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}   ${COLORS.dim}${config.tradingPairs.join(', ')}${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}╚══════════════════════════════════════════════════════════════════════════════════╝${COLORS.reset}`);
    console.log('');
  },

  formatUSD(amount: number, maxDecimals?: number): string {
    const abs = Math.abs(amount);
    let minDec = 2;
    let maxDec = 2;
    if (maxDecimals !== undefined) {
      maxDec = maxDecimals;
      minDec = Math.min(2, maxDecimals);
    } else if (abs > 0 && abs < 0.001) {
      minDec = 4;
      maxDec = 8;
    } else if (abs > 0 && abs < 1) {
      minDec = 2;
      maxDec = 4;
    }
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: minDec, maximumFractionDigits: maxDec })}`;
  },

  formatPct(pct: number): string {
    return `%${pct.toFixed(2)}`;
  },
};
