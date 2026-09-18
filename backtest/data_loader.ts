import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { backtestConfig, getDataFilePath } from './backtest.config.js';
import type { Candle } from '../src/utils/types.js';

const DATA_DIR = path.resolve(process.cwd(), 'backtest/data');

export async function parseBinanceCsvs(symbol: string): Promise<Candle[]> {
  const dashFormat = symbol.replace('/', '-');
  const noSlashFormat = symbol.replace('/', '');
  
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Data directory not found at ${DATA_DIR}. Please download CSV files first.`);
  }

  // Find all matching CSV files: {sanitized}-1m-*.csv
  let targetDir = DATA_DIR;
  if (fs.existsSync(path.join(DATA_DIR, dashFormat))) {
    targetDir = path.join(DATA_DIR, dashFormat);
  } else if (fs.existsSync(path.join(DATA_DIR, noSlashFormat))) {
    targetDir = path.join(DATA_DIR, noSlashFormat);
  }

  const files = fs.readdirSync(targetDir).filter(file => 
    file.endsWith('.csv') && (file.startsWith(`${noSlashFormat}-1m-`) || file.startsWith(`${dashFormat}-1m-`))
  );

  if (files.length === 0) {
    throw new Error(`No CSV files found for ${symbol} in ${targetDir}. Ensure you downloaded Binance Vision 1m CSVs (e.g. ${noSlashFormat}-1m-2026-01.csv).`);
  }

  // Sort files just to process them in chronological order
  files.sort();
  
  const allCandles: Candle[] = [];

  for (const file of files) {
    const filePath = path.join(targetDir, file);
    console.log(`  ▸ Parsing ${file}...`);
    
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let count = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = line.split(',');
      if (cols.length < 6) continue;
      
      const timestamp = parseInt(cols[0]!, 10);
      const open = parseFloat(cols[1]!);
      const high = parseFloat(cols[2]!);
      const low = parseFloat(cols[3]!);
      const close = parseFloat(cols[4]!);
      const volume = parseFloat(cols[5]!);
      
      allCandles.push({ timestamp, open, high, low, close, volume });
      count++;
    }
  }

  console.log(`  ▸ Sorting ${allCandles.length} combined rows for ${symbol}...`);
  // Sort chronologically ascending
  allCandles.sort((a, b) => a.timestamp - b.timestamp);

  // Deduplicate
  const deduped: Candle[] = [];
  let lastTs = -1;
  for (const c of allCandles) {
    if (c.timestamp !== lastTs) {
      deduped.push(c);
      lastTs = c.timestamp;
    }
  }

  console.log(`  ▸ Final deduplicated count: ${deduped.length} rows.`);

  return deduped;
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        📥 Binance Vision CSV Data Loader                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  
  for (const symbol of backtestConfig.pairs) {
    console.log(`━━━ Processing ${symbol} ━━━`);
    const candles = await parseBinanceCsvs(symbol);
    const outPath = path.resolve(process.cwd(), getDataFilePath(symbol, '1m'));
    
    console.log(`  💾 Saving to ${path.basename(outPath)}...`);
    fs.writeFileSync(outPath, JSON.stringify(candles), 'utf-8');
    console.log(`✅ Completed ${symbol}\n`);
  }
}

// Only run main if executed directly
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === __filename) {
  main().catch(err => {
    console.error('❌ Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
