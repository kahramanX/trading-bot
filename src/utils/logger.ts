// ══════════════════════════════════════════════════════════════
// logger.ts — Winston tabanlı renkli ve yapılandırılmış loglama
// Bot ne yaptığını ve NEDEN yaptığını her an anlatır.
// ══════════════════════════════════════════════════════════════

import winston from 'winston';

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

  banner(config: { pairs: string[]; dryRun: boolean; riskPct: number }): void {
    console.log('');
    console.log(`${COLORS.bright}${COLORS.cyan}╔══════════════════════════════════════════════════════════╗${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║     ⚡ PRICE ACTION TRADING BOT — Binance Testnet ⚡    ║${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}╠══════════════════════════════════════════════════════════╣${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}  Çiftler: ${COLORS.bright}${config.pairs.length} adet${COLORS.reset}   Risk: ${COLORS.bright}%${config.riskPct}${COLORS.reset}   Mode: ${config.dryRun ? `${COLORS.yellow}DRY-RUN 🧪${COLORS.reset}` : `${COLORS.green}LIVE 🔴${COLORS.reset}`}      ${COLORS.bright}${COLORS.cyan}║${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}║${COLORS.reset}  ${COLORS.dim}${config.pairs.join(', ')}${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}╚══════════════════════════════════════════════════════════╝${COLORS.reset}`);
    console.log('');
  },

  formatUSD(amount: number): string {
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  },

  formatPct(pct: number): string {
    return `%${pct.toFixed(2)}`;
  },
};
