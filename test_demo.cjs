const ccxt = require('ccxt');
require('dotenv').config();

async function testDemo() {
    const exchange = new ccxt.binance({
        apiKey: process.env.BINANCE_API_KEY,
        secret: process.env.BINANCE_SECRET,
        options: { defaultType: 'spot' }
    });

    exchange.urls.test = exchange.urls.demo;
    exchange.setSandboxMode(true);

    try {
        const balance = await exchange.fetchBalance({ type: 'spot' });
        console.log("BAKIYE:", balance.USDT);
    } catch (e) {
        console.error("HATA:", e);
    }
}

testDemo();
