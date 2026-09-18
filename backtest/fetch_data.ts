// ══════════════════════════════════════════════════════════════
// fetch_data.ts — Historical OHLCV Data Downloader
// Uses CCXT (Binance public API) to download 4H and 15m candles.
// Handles pagination, rate limiting, and saves to JSON files.
// Run: npx tsx backtest/fetch_data.ts
// ══════════════════════════════════════════════════════════════

import ccxt, { type Exchange } from 'ccxt';
import fs from 'node:fs';
import path from 'node:path';
import { backtestConfig, getDataFilePath } from './backtest.config.js';
import type { Candle } from '../src/utils/types.js';

// ─── Constants ──────────────────────────────────────────────

const BATCH_SIZE = 1000;            // CCXT max candles per request
const RATE_LIMIT_MS = 500;          // Delay between API calls (Artırıldı - IP Ban yememek için)
const DATA_DIR = path.resolve(process.cwd(), 'backtest/data');

// ─── Helpers ────────────────────────────────────────────────

function timeframeToMs(tf: string): number {
  const match = tf.match(/^(\d+)([mhdwM])$/);
  if (!match) throw new Error(`Invalid timeframe: ${tf}`);
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    'm': 60_000,
    'h': 3_600_000,
    'd': 86_400_000,
    'w': 604_800_000,
    'M': 2_592_000_000,
  };
  return value * multipliers[unit]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

// ─── OHLCV Fetcher with Pagination ─────────────────────────

async function fetchAllCandles(
  exchange: Exchange,
  symbol: string,
  timeframe: string,
  since: number,
  until: number,
): Promise<Candle[]> {
  const allCandles: Candle[] = [];
  let cursor = since;
  const tfMs = timeframeToMs(timeframe);
  let page = 0;

  while (cursor < until) {
    page++;
    process.stdout.write(`  📡 [${symbol}] ${timeframe} page ${page} — from ${formatDate(cursor)}...`);

    let rawOhlcv: any[] = [];
    let retries = 0;
    while (retries < 5) {
      try {
        rawOhlcv = await exchange.fetchOHLCV(symbol, timeframe, cursor, BATCH_SIZE);
        break; // success
      } catch (e: any) {
        retries++;
        const msg = e.message || String(e);
        console.log(`\n    ⚠️  Error fetching data (attempt ${retries}/5): ${msg}`);
        if (retries >= 5) {
          throw new Error(`Failed to fetch data after 5 retries: ${msg}`);
        }
        
        // Extract ban time if it's a 418 I'm a Teapot
        let waitMs = 5000 * Math.pow(2, retries - 1); // 5s, 10s, 20s...
        const bannedUntilMatch = msg.match(/banned until (\d+)/);
        if (bannedUntilMatch) {
          const banEnd = parseInt(bannedUntilMatch[1], 10);
          const nowMs = Date.now();
          if (banEnd > nowMs) {
            waitMs = (banEnd - nowMs) + 1000;
            console.log(`    🚨 IP Banned! Waiting until ${new Date(banEnd).toLocaleTimeString()} (${Math.ceil(waitMs/1000)}s)...`);
          }
        }
        
        console.log(`    ⏳ Retrying in ${Math.ceil(waitMs/1000)} seconds...`);
        await sleep(waitMs);
        process.stdout.write(`  📡 [${symbol}] ${timeframe} page ${page} (Retry) — from ${formatDate(cursor)}...`);
      }
    }

    if (rawOhlcv.length === 0) {
      console.log(' ⚠️ No more data.');
      break;
    }

    for (const bar of rawOhlcv) {
      const ts = bar[0] as number;
      if (ts >= until) break;

      allCandles.push({
        timestamp: ts,
        open: bar[1] as number,
        high: bar[2] as number,
        low: bar[3] as number,
        close: bar[4] as number,
        volume: bar[5] as number,
      });
    }

    console.log(` ✅ ${rawOhlcv.length} candles (total: ${allCandles.length})`);

    // Move cursor past the last fetched candle
    const lastTs = rawOhlcv[rawOhlcv.length - 1]![0] as number;
    cursor = lastTs + tfMs;

    // Respect rate limits
    await sleep(RATE_LIMIT_MS);
  }

  // Deduplicate by timestamp (safety against overlapping pages)
  const seen = new Set<number>();
  const deduped = allCandles.filter(c => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });

  // Sort chronologically
  deduped.sort((a, b) => a.timestamp - b.timestamp);

  return deduped;
}

// ─── Save to JSON ───────────────────────────────────────────

function saveCandles(symbol: string, timeframe: string, candles: Candle[]): string {
  const filePath = path.resolve(process.cwd(), getDataFilePath(symbol, timeframe));
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(candles, null, 2), 'utf-8');
  return filePath;
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     📥 SMC Backtest — Historical Data Fetcher           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const { pairs, days, htfTimeframe, ltfTimeframe, warmupCandles } = backtestConfig;

  // Calculate how far back we need data
  // Extra warmup candles for EMA200 calculation on HTF
  const ltfMs = timeframeToMs(ltfTimeframe);
  const htfMs = timeframeToMs(htfTimeframe);
  const warmupMs = Math.max(warmupCandles * htfMs, warmupCandles * ltfMs);
  const now = Date.now();
  const since = now - (days * 86_400_000) - warmupMs;
  const until = now;

  console.log(`  Config:`);
  console.log(`    Pairs:    ${pairs.join(', ')}`);
  console.log(`    Period:   ${days} days + ${warmupCandles} warmup candles`);
  console.log(`    From:     ${formatDate(since)}`);
  console.log(`    Until:    ${formatDate(until)}`);
  console.log(`    HTF:      ${htfTimeframe}`);
  console.log(`    LTF:      ${ltfTimeframe}`);
  console.log('');

  // Initialize Binance (public API — no auth needed)
  const exchange = new ccxt.binance({
    enableRateLimit: true,
    options: { defaultType: 'future' },
  });

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const summary: { symbol: string; timeframe: string; count: number; file: string }[] = [];

  for (const symbol of pairs) {
    console.log(`━━━ Fetching ${symbol} ━━━`);

    // Fetch HTF (4H) candles
    console.log(`\n  ▸ ${htfTimeframe} candles:`);
    const htfCandles = await fetchAllCandles(exchange, symbol, htfTimeframe, since, until);
    const htfPath = saveCandles(symbol, htfTimeframe, htfCandles);
    summary.push({ symbol, timeframe: htfTimeframe, count: htfCandles.length, file: htfPath });
    console.log(`  💾 Saved ${htfCandles.length} ${htfTimeframe} candles → ${path.basename(htfPath)}`);

    // Fetch LTF (15m) candles
    console.log(`\n  ▸ ${ltfTimeframe} candles:`);
    const ltfCandles = await fetchAllCandles(exchange, symbol, ltfTimeframe, since, until);
    const ltfPath = saveCandles(symbol, ltfTimeframe, ltfCandles);
    summary.push({ symbol, timeframe: ltfTimeframe, count: ltfCandles.length, file: ltfPath });
    console.log(`  💾 Saved ${ltfCandles.length} ${ltfTimeframe} candles → ${path.basename(ltfPath)}`);

    console.log('');
  }

  // Final summary
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                    📊 Download Summary                  ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  for (const item of summary) {
    const padSymbol = item.symbol.padEnd(10);
    const padTf = item.timeframe.padEnd(4);
    const padCount = String(item.count).padStart(7);
    console.log(`║  ${padSymbol} ${padTf}  ${padCount} candles                       ║`);
  }
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('✅ Data fetch complete. Run: npx tsx backtest/backtest_runner.ts');
  console.log('');
}

main().catch(err => {
  console.error('❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
