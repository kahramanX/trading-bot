import * as ccxt from 'ccxt';
import * as dotenv from 'dotenv';
import { loadConfig } from './src/config.js';
import { logger } from './src/utils/logger.js';

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
    // 1. CONFIG & BANNER
    const config = loadConfig();
    logger.banner(config);

    // Fetch API keys from .env
    const apiKey = process.env.BINANCE_API_KEY;
    const secret = process.env.BINANCE_SECRET;
    const network = config.network;

    if (!apiKey || !secret) {
        console.error(`${C.red}${C.bold}❌ ERROR: BINANCE_API_KEY or BINANCE_SECRET not found. Please check your .env file.${C.reset}`);
        process.exit(1);
    }

    const exchange = new ccxt.binance({
        apiKey: apiKey,
        secret: secret,
        enableRateLimit: true,
        options: { defaultType: 'future' }
    });

    if (network === 'testnet') {
        exchange.setSandboxMode(true);
        console.log(`\n${C.cyan}${C.bold}🔍 Connecting to Binance Testnet...${C.reset}\n`);
    } else if (network === 'demo') {
        exchange.urls.test = exchange.urls.demo;
        exchange.setSandboxMode(true);
        console.log(`\n${C.cyan}${C.bold}🔍 Connecting to Binance DEMO (Mock Trading)...${C.reset}\n`);
    } else {
        console.log(`\n${C.cyan}${C.bold}🔍 Connecting to Binance LIVE (Real Money)...${C.reset}\n`);
    }

    try {
        // 2. FUTURES BALANCE & PNL INQUIRY
        try {
            const futureBalance = await exchange.fetchBalance({ type: 'future' });
            const info = futureBalance.info;
            
            console.log(`${C.gray}==================================================${C.reset}`);
            console.log(`${C.yellow}${C.bold}📈 FUTURES ACCOUNT STATUS:${C.reset}`);
            
            const walletBalance = Number(info.totalWalletBalance || 0);
            const unPnl = Number(info.totalUnrealizedProfit || 0);
            const marginBalance = Number(info.totalMarginBalance || 0);
            
            const unPnlColor = unPnl >= 0 ? C.green : C.red;
            const pnlSign = unPnl > 0 ? '+' : '';
            
            console.log(`${C.green}💰 Wallet Balance (USDT): ${C.bold}$${walletBalance.toFixed(2)}${C.reset}`);
            console.log(`${unPnlColor}📊 Unrealized Profit/Loss (PnL): ${C.bold}${pnlSign}$${unPnl.toFixed(2)}${C.reset}`);
            console.log(`${C.cyan}⚖️  Margin Balance (USDT): ${C.bold}$${marginBalance.toFixed(2)}${C.reset}`);
            
            console.log(`\n${C.gray}Available (Free): $${(futureBalance['USDT']?.free || 0).toFixed(2)} / In Order (Used): $${(futureBalance['USDT']?.used || 0).toFixed(2)}${C.reset}`);
            console.log(`${C.gray}==================================================${C.reset}\n`);
        } catch (e: any) {
            console.log(`\n${C.yellow}${C.bold}📈 FUTURES WALLET BALANCE:${C.reset}`);
            console.log(`${C.red}❌ Failed to fetch futures balance: ${e.message.split('\n')[0]}${C.reset}`);
        }

    } catch (error) {
        console.error("❌ An error occurred:", error);
    }
}

checkAccountStatus();
