import * as ccxt from 'ccxt';
import * as dotenv from 'dotenv';

dotenv.config();

async function checkAccountStatus() {
    // .env dosyasından API anahtarlarını çek
    const apiKey = process.env.BINANCE_TESTNET_API_KEY;
    const secret = process.env.BINANCE_TESTNET_SECRET;

    if (!apiKey || !secret) {
        console.error("❌ HATA: BINANCE_TESTNET_API_KEY veya BINANCE_TESTNET_SECRET bulunamadı. Lütfen .env dosyanızı kontrol edin.");
        process.exit(1);
    }

    const exchange = new ccxt.binance({
        apiKey: apiKey,
        secret: secret,
        enableRateLimit: true,
        options: { defaultType: 'spot' }
    });

    // Testnet Sandbox modunu aktifleştir
    exchange.setSandboxMode(true);

    try {
        console.log("\n🔍 Binance Spot Testnet'e bağlanılıyor...\n");

        // 1. BAKİYE SORGULASI
        const balance = await exchange.fetchBalance();
        console.log("==================================================");
        console.log("💰 SANAL CÜZDAN BAKİYESİ:");
        console.log(`USDT: ${balance['USDT']?.free || 0} (Boşta) / ${balance['USDT']?.used || 0} (İşlemde)`);
        console.log(`BTC:  ${balance['BTC']?.free || 0} (Boşta) / ${balance['BTC']?.used || 0} (İşlemde)`);
        console.log(`ETH:  ${balance['ETH']?.free || 0} (Boşta) / ${balance['ETH']?.used || 0} (İşlemde)`);
        console.log("==================================================\n");

        // 2. AÇIK EMİRLER SORGULASI
        const pairsToCheck = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'AVAX/USDT', 'LINK/USDT']; 
        
        console.log("📋 BEKLEYEN AÇIK EMİRLER (Pusu):");
        let hasOpenOrders = false;

        for (const pair of pairsToCheck) {
            const openOrders = await exchange.fetchOpenOrders(pair);
            
            if (openOrders.length > 0) {
                hasOpenOrders = true;
                openOrders.forEach(order => {
                    console.log(`- [${pair}] ${order.side.toUpperCase()} LIMIT | Fiyat: $${order.price} | Miktar: ${order.amount} | Durum: ${order.status}`);
                });
            }
        }

        if (!hasOpenOrders) {
            console.log("  Şu an borsada bekleyen (pusuda) açık emir yok.");
        }
        console.log("\n==================================================\n");

    } catch (error) {
        console.error("❌ Bir hata oluştu:", error);
    }
}

checkAccountStatus();
