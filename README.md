# ⚡ Price Action Trading Bot (Binance Spot Testnet)

Kurumsal seviyede algoritmik risk yönetimi ve saf **Price Action** metodolojisi ile çalışan, TypeScript / Node.js tabanlı kripto alım-satım botu.

Bu bot bir "para basma makinesi" değildir; gecikmeli ve aşırı uyarlanmış (overfitting) indikatörler (RSI, MACD vb.) **kullanmaz**. Komisyonları, kaymaları (slippage), piyasa rejimini (range/trend) ve borsa kurallarını milisaniyelik disiplinle hesaba katan bir quant risk motorudur.

---

## 🎯 Strateji Mantığı (Edge)

```
[4H HTF Filtresi]
   │
   ├── EMA(200) + 4H Market Yapısı (HH/HL vs LH/LL)
   ├── Fiyat EMA bandında sıkışmışsa veya çelişki varsa → Range → NAKİTTE BEKLE ⚪
   ├── Yükseliş Trendi → Sadece LONG ara 🟢
   └── Düşüş Trendi → Sadece SHORT ara 🔴
   │
[15m LTF Giriş Motoru]
   │
   ├── 1. MSS (Market Structure Shift / CHoCH) onayı şart
   ├── 2. FVG (Fair Value Gap) ve Breaker Block tespiti
   ├── 3. Confluence (FVG + Breaker örtüşmesi) kontrolü
   ├── 4. Fiyat pusu bölgesine çekildiğinde LIMIT emir
   │
[Risk & Emir Yönetimi]
   │
   ├── Pozisyon Sizer: (Kasa × %1 Risk - Maliyetler) / SL Mesafesi
   ├── Borsa Filtreleri: LOT_SIZE, PRICE_FILTER, MIN_NOTIONAL ($5 kuralı)
   ├── Kademeli TP: %50 @ 1:2 (TP1) + %50 @ 1:3 (TP2)
   ├── TP1 Hit → Kalan pozisyonun Stop-Loss'u BREAK-EVEN (giriş) seviyesine çekilir
   ├── Ghost Emir Koruması: Pusu dolmadan trend veya MSS yön değiştirirse emir derhal İPTAL
   └── Circuit Breaker: 3 ardışık stop-loss veya %3 günlük kayıpta 24 SAAT ŞALTER İNDİRME
```

---

## 🚀 Temel Özellikler

1. **Multi-Pair Desteği**:
   - `TRADING_PAIRS=BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,AVAX/USDT,LINK/USDT`
   - Borsa filtreleri (tickSize, stepSize, minNotional) her çift için dinamik olarak çekilir ve önbelleğe alınır.

2. **Görünmeyen Maliyet Motoru (`cost_calculator`)**:
   - Giriş limit komisyonu (Maker) + çıkış stop komisyonu (Taker) + slippage (fiyat kayması) peşinen riskten düşülür.
   - Efektif R:R gerçek maliyetler dahil hesaplanır.

3. **$5 Hard Minimum & Lot Filtresi (`position_sizer`)**:
   - Pozisyon büyüklüğü Binance'in $5 veya minNotional sınırının altındaysa sistem patlamaz (throw yok); zarifçe reddedilir ve sebep loglanır.

4. **Kademeli TP & Otomatik Başa Baş (`order_manager`)**:
   - TP1 (%50) gerçekleştiğinde, TP2 bekleyen kısmın SL emri borsada anında Break-Even fiyatına revize edilir.
   - Kısmi dolum (partial fill) durumunda TP miktarları oransal olarak yeniden hesaplanır.

5. **Ghost Emir İptali**:
   - Fiyat henüz FVG / Breaker pusu bölgesine varmadan önce 15m'de ters yönde yeni bir MSS oluşursa veya 4H trend yönü bozulursa, tahtada bekleyen gerçekleşmemiş limit emir derhal iptal edilir.

6. **Circuit Breaker (İntikam İşlemi Koruması)**:
   - 3 ardışık stop-loss veya %3 günlük kayıp durumunda bot 24 saat uykuya geçer.
   - Durum `circuit_breaker_state.json` dosyasına diske kaydedilir; bot yeniden başlatılsa dahi uyku durumu korunur.

7. **Şeffaf Terminal Loglaması (`logger`)**:
   - Winston tabanlı renkli terminal logları. Her analiz adımı, kasa durumu, tetiklenme nedenleri ve ret gerekçeleri açıkça ekrana basılır. "Kara kutu" yoktur.

8. **Çift Çalışma Modu**:
   - `--dry-run`: Borsaya gerçek emir göndermeden canlı piyasa verileri üzerinde simülasyon.
   - Canlı Mod: Testnet API anahtarlarıyla gerçek limit / stop emirleri.

---

## 📁 Proje Yapısı

```
trading-bot/
├── src/
│   ├── config.ts                     # .env okuma, tip-güvenli validasyon
│   ├── index.ts                      # Multi-pair daemon ana döngüsü
│   ├── exchange/
│   │   └── binance_client.ts         # ccxt Binance Spot Testnet, constraints cache
│   ├── strategy/
│   │   ├── htf_filter.ts             # 4H EMA(200) + Range/Trend filtresi
│   │   ├── market_structure.ts       # Swing High/Low pivotlar, MSS (CHoCH) tespiti
│   │   ├── fair_value_gap.ts         # 3 mumluk FVG tespiti ve mitigation takibi
│   │   ├── breaker_block.ts          # Kırılan bloklar ve FVG ile Confluence
│   │   └── entry_engine.ts           # Tüm strateji adımlarını birleştiren orkestratör
│   ├── risk/
│   │   ├── cost_calculator.ts        # Komisyon + slippage maliyet analizi
│   │   ├── position_sizer.ts         # Dinamik pozisyon boyutlandırma ($5 koruması)
│   │   ├── stop_loss.ts              # Swing Low/High ve Break-Even SL
│   │   ├── take_profit.ts            # Kademeli TP (%50 @ 1:2, %50 @ 1:3) & Efektif R:R
│   │   └── circuit_breaker.ts        # 3 kayıp / %3 günlük sınır şalteri (disk persist)
│   ├── orders/
│   │   └── order_manager.ts          # Emir yaşam döngüsü, ghost cancel, BE SL taşıma
│   ├── utils/
│   │   ├── candle_utils.ts           # ATR, EMA, yuvarlama ve mum yardımcıları
│   │   ├── logger.ts                 # Renkli modüler konsol loglayıcı
│   │   └── types.ts                  # TypeScript interface ve tipleri
│   └── __tests__/                    # Vitest kapsamlı unit test paketi (29 test)
│       ├── cost_calculator.test.ts
│       ├── position_sizer.test.ts
│       ├── circuit_breaker.test.ts
│       ├── stop_loss.test.ts
│       ├── take_profit.test.ts
│       ├── market_structure.test.ts
│       ├── fair_value_gap.test.ts
│       ├── breaker_block.test.ts
│       └── htf_filter.test.ts
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## ⚙️ Kurulum & Yapılandırma

### 1. Gereksinimler
- Node.js >= 20.0.0
- npm >= 9.0.0

### 2. Bağımlılıkları Yükle
```bash
npm install
```

### 3. Ortam Değişkenlerini Ayarla
`.env.example` dosyasını `.env` olarak kopyala:
```bash
cp .env.example .env
```

`.env` dosyasını Binance Spot Testnet anahtarlarınla düzenle:
```env
# Binance Spot Testnet API Credentials (https://testnet.binance.vision)
BINANCE_TESTNET_API_KEY=your_api_key_here
BINANCE_TESTNET_SECRET=your_secret_here

# Çoklu İşlem Çiftleri (Virgülle ayrılmış liste)
TRADING_PAIRS=BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,AVAX/USDT,LINK/USDT

# Risk Yönetimi
RISK_PER_TRADE_PCT=1            # İşlem başına kasa yüzdesi riski
MAX_DAILY_LOSS_PCT=3            # Günlük maksimum kayıp yüzdesi (şalter)
MAX_CONSECUTIVE_LOSSES=3        # Arka arkaya maksimum stop-loss sayısı

# R:R Hedefleri
MIN_RR_RATIO=2.5                # Minimum Risk:Reward oranı
TP1_RR=2                        # TP1 R:R seviyesi (%50 pozisyon)
TP2_RR=3                        # TP2 R:R seviyesi (kalan %50)

# Zaman Dilimleri
HTF_TIMEFRAME=4h                # Yüksek zaman dilimi (trend filtresi)
LTF_TIMEFRAME=15m               # Düşük zaman dilimi (giriş sinyalleri)

# Maliyet Parametreleri
MAKER_FEE_PCT=0.1               # Binance Maker komisyonu (%)
TAKER_FEE_PCT=0.1               # Binance Taker komisyonu (%)
SLIPPAGE_TICKS=2                # Tahmini fiyat kayması (tick sayısı)
```

---

## 💻 Kullanım Komutları

### 🧪 Simülasyon (Dry-Run Modu — Önerilen Başlangıç)
Borsaya emir göndermeden canlı testnet verisi üzerinde tüm stratejiyi çalıştırır:
```bash
npm run dry-run
```

### 🚀 Canlı Testnet Modu
Testnet üzerinde gerçek emirleri açar, stop-loss ve TP'leri borsaya iletir:
```bash
npm run dev
```

### 🧪 Unit Testleri Çalıştır
Tüm risk, matematik ve strateji fonksiyonlarını Vitest ile test eder:
```bash
npm test
```

### 🔍 TypeScript Tip Kontrolü
```bash
npm run typecheck
```

---

## 🛡️ Risk & Güvenlik Kalkanı

| Kural | Davranış | Kod Konumu |
|---|---|---|
| **$5 MIN_NOTIONAL** | Pozisyon < $5 ise işlem reddedilir, bot çökmez | `src/risk/position_sizer.ts` |
| **Görünmeyen Maliyetler** | Komisyon + kayma peşinen risk bütçesinden düşülür | `src/risk/cost_calculator.ts` |
| **Kademeli TP1 & BE** | TP1 dolunca SL otomatik başa baş seviyesine çekilir | `src/orders/order_manager.ts` |
| **Ghost Emir İptali** | Fiyat pusuya gelmeden setup bozulursa emir silinir | `src/orders/order_manager.ts` |
| **Devre Kesici (Circuit Breaker)** | 3 ardışık stop veya %3 günlük kayıpta 24s uyku | `src/risk/circuit_breaker.ts` |
| **İntikam İşlemi Koruması** | Şalter durumu diske yazılır; restart ile sıfırlanmaz | `circuit_breaker_state.json` |

---

## 📄 Lisans
MIT License — Kişisel ve ticari kullanım için özgürce geliştirilebilir.
