import * as ccxt from 'ccxt';
import * as dotenv from 'dotenv';

dotenv.config();

const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    red: "\x1b[31m",
    gray: "\x1b[90m"
};

async function checkAccountStatus() {
    // .env dosyasından API anahtarlarını çek
    const apiKey = process.env.BINANCE_API_KEY;
    const secret = process.env.BINANCE_SECRET;
    const network = process.env.NETWORK?.trim().toLowerCase() || 'testnet';

    if (!apiKey || !secret) {
        console.error(`${C.red}${C.bold}❌ HATA: BINANCE_API_KEY veya BINANCE_SECRET bulunamadı. Lütfen .env dosyanızı kontrol edin.${C.reset}`);
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
        console.log(`\n${C.cyan}${C.bold}🔍 Binance Testnet'e bağlanılıyor...${C.reset}\n`);
    } else if (network === 'demo') {
        exchange.urls.test = exchange.urls.demo;
        exchange.setSandboxMode(true);
        console.log(`\n${C.cyan}${C.bold}🔍 Binance DEMO (Mock Trading)'e bağlanılıyor...${C.reset}\n`);
    } else {
        console.log(`\n${C.cyan}${C.bold}🔍 Binance LIVE (Gerçek Para)'a bağlanılıyor...${C.reset}\n`);
    }

    try {
        // 1. BAKİYE SORGULASI (Spot)
        const spotBalance = await exchange.fetchBalance({ type: 'spot' });
        console.log(`${C.gray}==================================================${C.reset}`);
        console.log(`${C.yellow}${C.bold}💰 SPOT CÜZDAN BAKİYESİ:${C.reset}`);
        console.log(`${C.green}USDT: ${spotBalance['USDT']?.free || 0} ${C.gray}(Boşta) / ${C.reset}${spotBalance['USDT']?.used || 0} ${C.gray}(İşlemde)${C.reset}`);
        console.log(`${C.bold}BTC:  ${spotBalance['BTC']?.free || 0} ${C.gray}(Boşta) / ${C.reset}${spotBalance['BTC']?.used || 0} ${C.gray}(İşlemde)${C.reset}`);
        console.log(`${C.bold}ETH:  ${spotBalance['ETH']?.free || 0} ${C.gray}(Boşta) / ${C.reset}${spotBalance['ETH']?.used || 0} ${C.gray}(İşlemde)${C.reset}`);

        // 2. BAKİYE SORGULASI (Futures)
        try {
            const futureBalance = await exchange.fetchBalance({ type: 'future' });
            console.log(`\n${C.yellow}${C.bold}📈 FUTURES (VADELİ) CÜZDAN BAKİYESİ:${C.reset}`);
            console.log(`${C.green}USDT: ${futureBalance['USDT']?.free || 0} ${C.gray}(Boşta) / ${C.reset}${futureBalance['USDT']?.used || 0} ${C.gray}(İşlemde)${C.reset}`);
            console.log(`${C.bold}BTC:  ${futureBalance['BTC']?.free || 0} ${C.gray}(Boşta) / ${C.reset}${futureBalance['BTC']?.used || 0} ${C.gray}(İşlemde)${C.reset}`);
            console.log(`${C.bold}ETH:  ${futureBalance['ETH']?.free || 0} ${C.gray}(Boşta) / ${C.reset}${futureBalance['ETH']?.used || 0} ${C.gray}(İşlemde)${C.reset}`);
        } catch (e: any) {
            console.log(`\n${C.yellow}${C.bold}📈 FUTURES (VADELİ) CÜZDAN BAKİYESİ:${C.reset}`);
            console.log(`${C.red}❌ Futures bakiyesi alınamadı: ${e.message.split('\n')[0]}${C.reset}`);
        }
        console.log(`${C.gray}==================================================${C.reset}\n`);

        // 2. AÇIK EMİRLER SORGULASI
        const rawPairs = process.env.TRADING_PAIRS || 'BTC/USDT,ETH/USDT';
        const pairsToCheck = rawPairs.split(',').map(p => p.trim());

        console.log(`${C.yellow}${C.bold}📋 BEKLEYEN AÇIK EMİRLER (Pusu - ${pairsToCheck.length} Çift):${C.reset}`);
        let hasOpenOrders = false;

        for (const pair of pairsToCheck) {
            try {
                const openOrders = await exchange.fetchOpenOrders(pair);

                if (openOrders.length > 0) {
                    hasOpenOrders = true;
                    openOrders.forEach(order => {
                        const sideColor = order.side.toLowerCase() === 'buy' ? C.green : C.red;
                        console.log(`  - [${C.bold}${pair}${C.reset}] ${sideColor}${order.side.toUpperCase()}${C.reset} LIMIT | Fiyat: ${C.bold}$${order.price}${C.reset} | Miktar: ${order.amount} | Durum: ${C.cyan}${order.status}${C.reset}`);
                    });
                }
            } catch (e: any) {
                if (e.name === 'BadSymbol' || (e.message && e.message.includes('symbol'))) {
                    console.log(`  ${C.gray}* [${pair}] Bu piyasada (veya ağda) bulunamadı, atlandı.${C.reset}`);
                } else {
                    console.log(`  ${C.red}* [${pair}] Emirler alınırken hata: ${e.message.split('\n')[0]}${C.reset}`);
                }
            }
        }

        if (!hasOpenOrders) {
            console.log(`  ${C.gray}Şu an borsada bekleyen (pusuda) açık emir yok.${C.reset}`);
        }
        console.log(`\n${C.gray}==================================================${C.reset}\n`);

    } catch (error) {
        console.error("❌ Bir hata oluştu:", error);
    }
}

checkAccountStatus();
