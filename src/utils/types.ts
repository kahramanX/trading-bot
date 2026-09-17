// ══════════════════════════════════════════════════════════════
// types.ts — Paylaşılan tipler ve interface'ler
// Tüm modüllerin ortak dili. Kara kutu yok, her tip açık.
// ══════════════════════════════════════════════════════════════

// ─── Mum Verisi ─────────────────────────────────────────────

export interface Candle {
  timestamp: number;    // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Market Structure ───────────────────────────────────────

export type SwingType = 'HIGH' | 'LOW';

export interface SwingPoint {
  type: SwingType;
  price: number;
  index: number;        // Mum dizisindeki pozisyon
  timestamp: number;
}

export type MarketBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface MarketStructure {
  bias: MarketBias;
  swingPoints: SwingPoint[];
  lastMSS?: MarketStructureShift;
}

export interface MarketStructureShift {
  type: 'BULLISH' | 'BEARISH';
  price: number;          // Kırılma seviyesi
  timestamp: number;
  confirmed: boolean;
}

// ─── Fair Value Gap ─────────────────────────────────────────

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH';
  high: number;           // FVG üst sınırı
  low: number;            // FVG alt sınırı
  midpoint: number;       // Orta nokta (giriş hedefi)
  timestamp: number;
  index: number;
  mitigated: boolean;     // Fiyat bölgeye geri çekildi mi?
  size: number;           // FVG büyüklüğü ($)
}

// ─── Breaker Block ──────────────────────────────────────────

export interface BreakerBlock {
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  timestamp: number;
  index: number;
  mitigated: boolean;
}

// ─── Trade Signal ───────────────────────────────────────────

export type TradeDirection = 'LONG' | 'SHORT';

export interface TradeSignal {
  symbol: string;           // İşlem çifti (multi-pair desteği)
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;      // TP1: R:R 1:2 (%50 pozisyon)
  takeProfit2: number;      // TP2: R:R 1:3 (kalan %50)
  htfBias: MarketBias;
  triggerType: 'FVG' | 'BREAKER_BLOCK';
  confidence: number;       // 0-1 arası güven skoru
  reason: string;           // İnsan okunur açıklama
}

// ─── Risk & Cost ────────────────────────────────────────────

export interface TradeCosts {
  entryCommission: number;      // Giriş komisyonu ($)
  exitCommission: number;       // Çıkış komisyonu ($)
  slippageCost: number;         // Tahmini kayma maliyeti ($)
  totalCost: number;            // Toplam maliyet ($)
  effectiveEntry: number;       // Gerçek giriş (komisyon+kayma sonrası)
  effectiveExit: number;        // Gerçek çıkış (komisyon+kayma sonrası)
}

export interface PositionSizeResult {
  quantity: number;             // Alınacak coin miktarı
  positionValue: number;        // Toplam pozisyon değeri ($)
  riskAmount: number;           // Risk edilen miktar ($)
  riskPercent: number;          // Kasanın yüzdesi olarak risk
  stopDistance: number;         // Giriş - SL arası mesafe ($)
  totalCosts: TradeCosts;       // Dahil edilen maliyet detayları
  isValid: boolean;             // MIN_NOTIONAL + $5 kontrolü geçti mi?
  rejectReason?: string;        // Reddedildiyse sebebi
}

// ─── Circuit Breaker ────────────────────────────────────────

export interface CircuitBreakerState {
  consecutiveLosses: number;
  dailyPnL: number;
  dailyStartBalance: number;
  dailyDate: string;            // YYYY-MM-DD (gün sıfırlaması için)
  isTripped: boolean;
  tripReason?: string;
  resumeAt?: string;            // ISO date string
  tradeHistory: TradeResult[];  // Günlük işlem geçmişi
}

export interface TradeResult {
  timestamp: number;
  symbol: string;               // Hangi çiftte işlem yapıldı
  direction: TradeDirection;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;                  // Net kar/zarar ($)
  isWin: boolean;
  exitReason: 'STOP_LOSS' | 'TAKE_PROFIT_1' | 'TAKE_PROFIT_2' | 'MANUAL' | 'GHOST_CANCEL';
}

// ─── Order Management ───────────────────────────────────────

export type OrderStatus =
  | 'PENDING'           // Henüz borsaya iletilmedi
  | 'OPEN'              // Borsada açık (limit emir bekliyor)
  | 'PARTIALLY_FILLED'  // Kısmi dolum
  | 'FILLED'            // Tamamen doldu
  | 'CANCELLED'         // İptal edildi
  | 'EXPIRED';          // Süresi doldu

export interface ManagedOrder {
  id: string;                   // ccxt order ID
  clientOrderId: string;        // Bizim internal ID'miz
  symbol: string;               // İşlem çifti
  type: 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT_1' | 'TAKE_PROFIT_2';
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  filledQuantity: number;       // Kısmi dolum takibi
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ActiveTrade {
  symbol: string;               // Hangi çiftte işlem açık
  entryOrder: ManagedOrder;
  stopLossOrder?: ManagedOrder;
  tp1Order?: ManagedOrder;
  tp2Order?: ManagedOrder;
  signal: TradeSignal;
  tp1Hit: boolean;              // TP1 doldu mu? (break-even SL için)
  breakEvenApplied: boolean;    // SL başa baş çekildi mi?
  tp1Price?: number;
  tp2Price?: number;
  tp1Quantity?: number;
  tp2Quantity?: number;
}

// ─── Exchange Info ──────────────────────────────────────────

export interface SymbolConstraints {
  symbol: string;
  minQty: number;               // LOT_SIZE minimum miktar
  maxQty: number;               // LOT_SIZE maximum miktar
  stepSize: number;             // LOT_SIZE adım büyüklüğü
  minNotional: number;          // MIN_NOTIONAL (genelde $5+)
  tickSize: number;             // PRICE_FILTER fiyat adımı
  minPrice: number;
  maxPrice: number;
}

// ─── Config ─────────────────────────────────────────────────

export interface BotConfig {
  // API
  apiKey: string;
  apiSecret: string;
  network: 'testnet' | 'live' | 'demo';
  marketType: 'spot' | 'futures';
  leverage: number;

  // Trading — Multi-Pair desteği
  tradingPairs: string[];       // Virgülle ayrılmış çift listesi

  // Risk
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;

  // R:R
  minRRRatio: number;
  tp1RR: number;
  tp2RR: number;

  // Timeframes
  htfTimeframe: string;
  ltfTimeframe: string;

  // Fees
  makerFeePct: number;
  takerFeePct: number;
  slippageTicks: number;

  // Runtime
  dryRun: boolean;
}
