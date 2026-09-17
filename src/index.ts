// ══════════════════════════════════════════════════════════════
// index.ts — Ana Giriş Noktası (Multi-Pair Daemon)
// Her 15m mum kapanışında tüm çiftleri sırayla tarar.
// --dry-run ile emir göndermeden çalışır.
// ══════════════════════════════════════════════════════════════

import { loadConfig } from './config.js';
import { initExchange, getFreeBalance, fetchCandles, getSymbolConstraints } from './exchange/binance_client.js';
import { loadState, isCircuitBreakerTripped, logCircuitBreakerStatus } from './risk/circuit_breaker.js';
import { runEntryEngine } from './strategy/entry_engine.js';
import { calculatePositionSize } from './risk/position_sizer.js';
import { calculateTakeProfitLevels } from './risk/take_profit.js';
import { hasActiveTrade, openTrade, manageActiveTrade, initActiveTrades } from './orders/order_manager.js';
import type { CircuitBreakerState } from './utils/types.js';
import { logger } from './utils/logger.js';
import { msUntilNextCandleClose } from './utils/candle_utils.js';

let isRunning = true;
let currentTimer: ReturnType<typeof setTimeout> | null = null;

async function mainLoop(): Promise<void> {
  const config = loadConfig();

  // ─── Banner ───────────────────────────────────────────────
  logger.banner({
    pairs: config.tradingPairs,
    dryRun: config.dryRun,
    riskPct: config.riskPerTradePct,
  });

  if (config.dryRun) {
    logger.warn('SYSTEM', '🧪 DRY-RUN modu aktif. Borsaya emir GÖNDERİLMEYECEK.');
    logger.separator();
  }

  // ─── Exchange Bağlantısı (tüm çiftlerin constraints'leri yüklenir) ─
  await initExchange(config);

  // ─── C-01 FIX: Diskten aktif işlemleri yükle (restart dayanıklılığı) ─
  initActiveTrades();

  // ─── Daemon Döngüsü ──────────────────────────────────────
  while (isRunning) {
    try {
      await executeCycle(config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('SYSTEM', `Döngü hatası: ${msg}`);
    }

    if (!isRunning) break;

    const waitMs = msUntilNextCandleClose(config.ltfTimeframe);
    const waitMin = (waitMs / 1000 / 60).toFixed(1);
    logger.info('SYSTEM', `⏳ Sonraki ${config.ltfTimeframe} mum kapanışına ${waitMin} dk. Bekleniyor...`);
    logger.separator();

    await sleep(waitMs);
  }

  logger.info('SYSTEM', '👋 Bot kapatıldı.');
}

/**
 * Tek döngü — tüm çiftleri sırayla tarar.
 * Rate limit'e takılmamak için çiftler arası 1s bekleme.
 */
async function executeCycle(config: ReturnType<typeof loadConfig>): Promise<void> {
  logger.separator();
  logger.info('ENGINE', `🔄 Yeni döngü — ${new Date().toLocaleString('tr-TR')}`);

  // ─── 1. Kasa ─────────────────────────────────────────────
  const balance = await getFreeBalance('USDT');
  logger.info('RISK', `Kasa: ${logger.formatUSD(balance)} USDT`);

  if (balance < 5) {
    logger.warn('RISK', `Kasa çok düşük (${logger.formatUSD(balance)} < $5). Döngü atlandı.`);
    return;
  }

  // ─── 2. Circuit Breaker ──────────────────────────────────
  const cbState = loadState(balance, config);
  if (isCircuitBreakerTripped(cbState)) return;
  logCircuitBreakerStatus(cbState, config);

  // ─── 3. Tüm Çiftleri Tara ────────────────────────────────
  for (const symbol of config.tradingPairs) {
    if (!isRunning) break;

    logger.separator();
    logger.info('SYSTEM', `📡 [${symbol}] Analiz ediliyor...`);

    try {
      await analyzeSymbol(symbol, balance, config, cbState);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('SYSTEM', `[${symbol}] Hata: ${msg}`);
    }

    // Rate limit koruması — çiftler arası 1 saniye bekle
    if (config.tradingPairs.indexOf(symbol) < config.tradingPairs.length - 1) {
      await sleep(1000);
    }
  }

  logger.info('ENGINE', `✅ ${config.tradingPairs.length} çift tarandı.`);
}

/**
 * Tek bir sembol için tam analiz ve giriş döngüsü.
 */
async function analyzeSymbol(
  symbol: string,
  balance: number,
  config: ReturnType<typeof loadConfig>,
  cbState: CircuitBreakerState,
): Promise<void> {
  // Constraints al (cache'ten gelir)
  const constraints = await getSymbolConstraints(symbol);

  // Mum verileri çek
  // L-04 FIX: Son mumu (henüz kapanmamış) çıkar — unstable veri ile karar verme
  const htfCandlesRaw = await fetchCandles(symbol, config.htfTimeframe, 251);
  const ltfCandlesRaw = await fetchCandles(symbol, config.ltfTimeframe, 201);
  const htfCandles = htfCandlesRaw.slice(0, -1);  // Kapanmamış mumu çıkar
  const ltfCandles = ltfCandlesRaw.slice(0, -1);  // Kapanmamış mumu çıkar

  if (htfCandles.length < 20) {
    logger.warn('SYSTEM', `[${symbol}] HTF veri yetersiz: ${htfCandles.length}/20`);
    return;
  }
  if (ltfCandles.length < 50) {
    logger.warn('SYSTEM', `[${symbol}] LTF veri yetersiz: ${ltfCandles.length}/50`);
    return;
  }

  // Zaten aktif işlem varsa emir durumlarını senkronize et / yönet
  if (hasActiveTrade(symbol)) {
    logger.info('ENGINE', `[${symbol}] Aktif işlem yönetiliyor...`);
    await manageActiveTrade(symbol, htfCandles, ltfCandles, config, constraints, cbState);
    return;
  }

  // ─── Strateji Motoru ──────────────────────────────────────
  const result = runEntryEngine(symbol, htfCandles, ltfCandles, config, constraints);

  if (!result.signal) {
    logger.debug('ENGINE', `[${symbol}] Sinyal yok (${result.step}): ${result.reason}`);
    return;
  }

  // ─── Risk Hesaplama ───────────────────────────────────────
  const posSize = calculatePositionSize(
    balance,
    result.signal.entryPrice,
    result.signal.stopLoss,
    result.signal.direction,
    config,
    constraints,
  );

  if (!posSize.isValid) {
    logger.warn('ENGINE', `[${symbol}] Pozisyon geçersiz: ${posSize.rejectReason}`);
    return;
  }

  // ─── TP Seviyeleri ────────────────────────────────────────
  const tpLevels = calculateTakeProfitLevels(
    result.signal.entryPrice,
    result.signal.stopLoss,
    posSize.quantity,
    result.signal.direction,
    config,
    constraints,
  );

  if (!tpLevels.isValid) {
    logger.warn('ENGINE', `[${symbol}] TP seviyeleri geçersiz: ${tpLevels.rejectReason}`);
    return;
  }

  // ─── Emir Aç ─────────────────────────────────────────────
  await openTrade(result.signal, posSize, tpLevels, config, constraints);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    currentTimer = setTimeout(resolve, ms);
  });
}

function setupGracefulShutdown(): void {
  const shutdown = (sig: string) => {
    logger.separator();
    logger.info('SYSTEM', `⛔ ${sig} alındı. Bot güvenli kapanıyor...`);
    isRunning = false;
    if (currentTimer) clearTimeout(currentTimer);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

setupGracefulShutdown();
mainLoop().catch(err => {
  logger.error('SYSTEM', `Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
