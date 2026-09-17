import * as ccxt from 'ccxt';
import * as dotenv from 'dotenv';

dotenv.config();

async function checkAccountStatus() {
    // .env dosyasından API anahtarlarını çek
    const apiKey = process.env.BINANCE_API_KEY;
    const secret = process.env.BINANCE_SECRET;
    const network = process.env.NETWORK?.trim().toLowerCase() || 'testnet';

    if (!apiKey || !secret) {
        console.error("❌ HATA: BINANCE_API_KEY veya BINANCE_SECRET bulunamadı. Lütfen .env dosyanızı kontrol edin.");
        process.exit(1);
    }

    const exchange = new ccxt.binance({
        apiKey: apiKey,
        secret: secret,
        enableRateLimit: true,
        options: { defaultType: 'spot' }
    });

    if (network === 'testnet') {
        exchange.setSandboxMode(true);
        console.log("\n🔍 Binance Testnet'e bağlanılıyor...\n");
    } else if (network === 'demo') {
        exchange.urls.test = exchange.urls.demo;
        exchange.setSandboxMode(true);
        console.log("\n🔍 Binance DEMO (Mock Trading)'e bağlanılıyor...\n");
    } else {
        console.log("\n🔍 Binance LIVE (Gerçek Para)'a bağlanılıyor...\n");
    }

    try {

        // 1. BAKİYE SORGULASI (Spot)
        const spotBalance = await exchange.fetchBalance({ type: 'spot' });
        console.log("==================================================");
        console.log("💰 SPOT CÜZDAN BAKİYESİ:");
        console.log(`USDT: ${spotBalance['USDT']?.free || 0} (Boşta) / ${spotBalance['USDT']?.used || 0} (İşlemde)`);
        console.log(`BTC:  ${spotBalance['BTC']?.free || 0} (Boşta) / ${spotBalance['BTC']?.used || 0} (İşlemde)`);
        console.log(`ETH:  ${spotBalance['ETH']?.free || 0} (Boşta) / ${spotBalance['ETH']?.used || 0} (İşlemde)`);
        
        // 2. BAKİYE SORGULASI (Futures)
        try {
            const futureBalance = await exchange.fetchBalance({ type: 'future' });
            console.log("\n📈 FUTURES (VADELİ) CÜZDAN BAKİYESİ:");
            console.log(`USDT: ${futureBalance['USDT']?.free || 0} (Boşta) / ${futureBalance['USDT']?.used || 0} (İşlemde)`);
            console.log(`BTC:  ${futureBalance['BTC']?.free || 0} (Boşta) / ${futureBalance['BTC']?.used || 0} (İşlemde)`);
            console.log(`ETH:  ${futureBalance['ETH']?.free || 0} (Boşta) / ${futureBalance['ETH']?.used || 0} (İşlemde)`);
        } catch (e: any) {
            console.log("\n📈 FUTURES (VADELİ) CÜZDAN BAKİYESİ:");
            console.log(`❌ Futures bakiyesi alınamadı (Hesap/API yetkisi yok): ${e.message.split('\n')[0]}`);
        }
        console.log("==================================================\n");

        // 2. AÇIK EMİRLER SORGULASI
        const rawPairs = process.env.TRADING_PAIRS || 'BTC/USDT,ETH/USDT';
        const pairsToCheck = rawPairs.split(',').map(p => p.trim()); 
        
        console.log(`📋 BEKLEYEN AÇIK EMİRLER (Pusu - ${pairsToCheck.length} Çift):`);
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
