import ccxt from 'ccxt';
import dotenv from 'dotenv';
dotenv.config({ path: '/Users/musti/Documents/PersonalGithub/trading-bot/.env' });

async function testFetch() {
  const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
    enableRateLimit: true,
    options: { defaultType: 'future' }
  });

  exchange.urls.test = exchange.urls.demo;
  exchange.setSandboxMode(true);

  try {
    const symbol = 'SYN/USDT';
    const id = '1000000207815534';
    console.log(`Fetching order ${id} for ${symbol}...`);
    const order = await exchange.fetchOrder(id, symbol);
    console.log('Order found:', order);
  } catch (e: any) {
    console.error('Error fetching order:', e.message);
  }
}

testFetch();
