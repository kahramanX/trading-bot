// Verify position sizer and TP levels with corrected config
// Run from project root: npx tsx backtest/scratch/verify_possize.ts
import { calculatePositionSize } from '../../src/risk/position_sizer.js';
import { calculateTakeProfitLevels } from '../../src/risk/take_profit.js';
import { buildBotConfig, backtestConfig, getDefaultConstraints } from '../backtest.config.js';

process.stdout.write('\n');

const bot = buildBotConfig(backtestConfig);
console.log('=== BotConfig ===');
console.log(`  leverage:   ${bot.leverage}x`);
console.log(`  makerFee:   ${bot.makerFeePct}%`);
console.log(`  takerFee:   ${bot.takerFeePct}%`);
console.log(`  tp1RR:      ${bot.tp1RR}`);
console.log(`  tp2RR:      ${bot.tp2RR}`);
console.log(`  minRRRatio: ${bot.minRRRatio}`);
console.log('');

const tests: Array<[string, number, number, 'LONG'|'SHORT', string]> = [
  ['BTC LONG  (SL 0.5%)', 100_000, 99_500, 'LONG',  'BTC/USDT'],
  ['BTC LONG  (SL 0.2%)', 100_000, 99_800, 'LONG',  'BTC/USDT'],
  ['BTC SHORT (SL 0.5%)', 100_000, 100_500, 'SHORT', 'BTC/USDT'],
  ['ETH LONG  (SL 0.5%)', 2_500,   2_487.5, 'LONG',  'ETH/USDT'],
  ['ETH SHORT (SL 1.0%)', 2_500,   2_525,   'SHORT', 'ETH/USDT'],
];

let ok = 0; let fail = 0;
for (const [name, entry, sl, dir, sym] of tests) {
  const c = getDefaultConstraints(sym);
  const p = calculatePositionSize(5000, entry, sl, dir, bot, c);
  if (!p.isValid) {
    console.log(`❌ ${name} — ${p.rejectReason}`);
    fail++; continue;
  }
  const t = calculateTakeProfitLevels(entry, sl, p.quantity, dir, bot, c);
  if (!t.isValid) {
    console.log(`⚠️  ${name} — size OK, TP rejected: ${t.rejectReason}`);
    fail++; continue;
  }
  const margin = (p.positionValue / bot.leverage).toFixed(0);
  console.log(`✅ ${name}`);
  console.log(`   qty=${p.quantity} notional=$${p.positionValue.toFixed(0)} margin=$${margin} TP1=$${t.tp1Price} TP2=$${t.tp2Price} RR=${((t.riskRewardTP1+t.riskRewardTP2)/2).toFixed(2)}`);
  ok++;
}
console.log(`\n${ok} passed / ${fail} failed`);
