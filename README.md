# ⚡ Smart Money (SMC) Trading Bot (Binance Spot & Futures)

Kurumsal seviyede algoritmik risk yönetimi ve saf **Price Action / Smart Money Concepts (SMC)** metodolojisi ile çalışan, TypeScript / Node.js tabanlı kripto alım-satım botu. 

Bu bot bir "para basma makinesi" değildir; RSI, MACD gibi gecikmeli (lagging) indikatörler **kullanmaz**. Piyasa yapısı (Market Structure), Fiyat Boşlukları (FVG - Fair Value Gap) ve Kırılım Bloklarını (Breaker Block) analiz eder. Komisyonları, kaymaları (slippage) ve borsa limitlerini milisaniyelik disiplinle hesaba katan bir risk motoruna sahiptir. Hem **Spot** hem de **Vadeli İşlemler (Futures)** piyasalarında çalışabilir.

---

## 🎯 Strateji Mantığı (Edge)

Bot, çoklu zaman dilimi (Multi-Timeframe) analizi yaparak trend yönünde işlemlere girer.

```text
[4H HTF Filtresi - Yön Tayini]
   │
   ├── EMA(20/50) + 4H Market Yapısı (Swing Pivotlar)
   ├── Fiyat yatay bantta (Range) ise → NAKİTTE BEKLE ⚪
   ├── Yükseliş Trendi (BULLISH) → Sadece LONG ara 🟢
   └── Düşüş Trendi (BEARISH) → Sadece SHORT ara 🔴
   │
[15m LTF Giriş Motoru - Tetikleyici]
   │
   ├── 1. MSS (Market Structure Shift / CHoCH) onayı şart (Trend yönünde kırılım)
   ├── 2. FVG (Fair Value Gap) ve Breaker Block tespiti
   ├── 3. Confluence (FVG + Breaker örtüşmesi) kontrolü (Güven: %85+)
   ├── 4. Fiyat pusu bölgesine (Mitigation) çekildiğinde LIMIT veya MARKET emir
   │
[Risk & Emir Yönetimi]
   │
   ├── Pozisyon Sizer: (Kasa × %Risk - Maliyetler) / SL Mesafesi
   ├── Borsa Filtreleri: LOT_SIZE, TICK_SIZE, MIN_NOTIONAL ($5 kuralı)
   ├── Kademeli TP: %50 @ 1:2 (TP1) + %50 @ 1:3 (TP2)
   ├── Break-Even (BE): TP1 Hit → Kalan pozisyonun Stop-Loss'u GİRİŞ seviyesine çekilir
   ├── Ghost Emir Koruması: Fiyat hedefe varmadan setup bozulursa pusu iptal edilir
   └── Circuit Breaker: 3 ardışık stop-loss veya %3 günlük kayıpta 24 SAAT ŞALTER İNDİRME
```

---

## 🚀 Temel Özellikler

1. **Spot & Futures Desteği:**
   - `.env` üzerinden `MARKET_TYPE=spot` veya `MARKET_TYPE=futures` seçimi.
   - Futures modunda kaldıraç (`FUTURES_LEVERAGE`) desteği ve bakiye (margin) kontrolü.

2. **Çoklu Parite (Multi-Pair) Tarama:**
   - Onlarca pariteyi eşzamanlı izler (Örn: BTC, ETH, SOL).
   - Her paritenin `stepSize` ve `tickSize` gibi borsa limitleri dinamik çekilip önbelleklenir.

3. **Kusursuz Risk Yönetimi (`position_sizer`):**
   - İşlem başına sabit risk (Örn: Kasanın %1'i).
   - Sabit lot yerine; Stop mesafesi, Maker/Taker komisyonları ve Fiyat kayması (Slippage) düşülerek net pozisyon büyüklüğü hesaplanır.
   - Eğer hesaplanan miktar borsanın $5 veya minNotional sınırının altındaysa zarifçe reddedilir, bot çökmez.

4. **Kademeli Kar Al & Otomatik Başa Baş:**
   - İşlem hedefine ulaştıkça kısmi kâr alınır (TP1 ve TP2).
   - TP1 gerçekleştiğinde, kalan pozisyon risksiz hale getirilir (Stop noktası giriş fiyatına taşınır).

5. **Devre Kesici (Circuit Breaker - Şalter Sistemi):**
   - İntikam işlemlerini (Revenge Trading) önlemek için; arka arkaya 3 stop veya günlük %3 kasa kaybında bot kendini kilitler ve 24 saat işlem yapmaz. 
   - Durum diske yazılır (`circuit_breaker_state.json`); bot yeniden başlatılsa bile süre dolmadan işlem açmaz.

6. **Durum Kontrol Aracı (`check_status.ts`):**
   - Cüzdan bakiyesini (Spot/Futures ayrı ayrı) ve piyasada pusuya yatmış bekleyen açık emirlerinizi kolayca listeleyebilirsiniz.

---

## 📁 Proje Yapısı

```
trading-bot/
├── src/
│   ├── config.ts                     # Ortam değişkenleri ve doğrulama
│   ├── index.ts                      # Ana döngü (Daemon)
│   ├── exchange/
│   │   └── binance_client.ts         # CCXT Binance API entegrasyonu
│   ├── strategy/
│   │   ├── htf_filter.ts             # 4H Trend Filtresi
│   │   ├── market_structure.ts       # Swing Pivotlar, MSS (CHoCH)
│   │   ├── fair_value_gap.ts         # FVG tespiti
│   │   ├── breaker_block.ts          # Breaker Block tespiti
│   │   └── entry_engine.ts           # Tüm şartları birleştirip sinyal üreten motor
│   ├── risk/
│   │   ├── position_sizer.ts         # Lot ve margin hesaplama
│   │   ├── stop_loss.ts              # Swing Low/High SL ve Break-Even hesaplama
│   │   ├── take_profit.ts            # Kademeli TP hesaplama
│   │   └── circuit_breaker.ts        # Günlük zarar ve ardışık stop koruması
│   ├── orders/
│   │   └── order_manager.ts          # Emir iletimi, takibi ve iptali
│   ├── utils/
│   │   ├── logger.ts                 # Renkli terminal logları
│   │   └── types.ts                  # TypeScript arayüzleri
├── check_status.ts                   # Bakiye ve açık emir kontrol scripti
├── .env.example
├── package.json
└── README.md
```

---

## ⚙️ Kurulum & Yapılandırma

### 1. Gereksinimler
- **Node.js** (v20.0.0 veya üzeri önerilir)
- **npm** (v9 veya üzeri)

### 2. İndirme ve Yükleme
```bash
npm install
```

### 3. Ortam Değişkenleri (.env) Ayarı
`.env.example` dosyasının adını `.env` olarak değiştirin veya kopyalayın:
```bash
cp .env.example .env
```
İçerisini kendi stratejinize ve API anahtarlarınıza göre düzenleyin:
```env
NETWORK=testnet                 # 'live', 'testnet' veya 'demo'
MARKET_TYPE=futures             # 'spot' veya 'futures'
FUTURES_LEVERAGE=5              # Kaldıraç oranı

BINANCE_API_KEY=senin_api_anahtarin
BINANCE_SECRET=senin_gizli_anahtarin

TRADING_PAIRS=BTC/USDT,ETH/USDT,SOL/USDT

RISK_PER_TRADE_PCT=1            # İşlem başına kasa yüzdesi riski (Max %5)
MAX_DAILY_LOSS_PCT=3            # Günlük maksimum kayıp yüzdesi (Şalter)
MAX_CONSECUTIVE_LOSSES=3        # Peş peşe maksimum stop olma sınırı

HTF_TIMEFRAME=4h
LTF_TIMEFRAME=15m
```
> **ÖNEMLİ:** API anahtarı alırken güvenliğiniz için yalnızca botun kullanacağı modlara (Spot veya Futures Trading) izin verin. **Withdrawal (Çekim)** yetkisini ASLA açmayın.

---

## 💻 Kullanım Komutları

### 🚀 Botu Başlatma (Canlı Çalışma)
`.env` dosyasındaki ağ (Testnet/Live) ve piyasa (Spot/Futures) ayarlarınıza göre çalışır.
```bash
npm run dev
```

### 🧪 Kuru Çalıştırma (Dry-Run Modu)
Borsaya **gerçek emir göndermeden**, sadece canlı piyasa verileri üzerinde stratejiyi simüle etmek için kullanılır. Sinyalleri ve risk hesaplamalarını terminalde test etmek için harikadır.
```bash
npm run dry-run
```

### 🔎 Bakiye ve Açık Emirleri Kontrol Etme
Bot çalışırken veya kapalıyken, güncel kasanızı (Spot ve Vadeli) ve borsada bekleyen (Pusu) limit/stop emirlerinizi listelemek için kullanın:
```bash
npx tsx check_status.ts
```

### 🩺 Testler ve Tip Kontrolü
```bash
npm test              # Vitest ile unit testleri çalıştırır
npm run typecheck     # TypeScript hatalarını tarar
```

---

## 🛡️ Risk & Güvenlik Kalkanı (Özet)

| Kural | Ne İşe Yarar? |
|---|---|
| **Dinamik Lot** | İşlem başına sabit $ veya Sabit Lot riski ALMAZ. Stop mesafesine göre lotu küçültür/büyütür. Kasanın %1'inden fazlasını asla riske etmez. |
| **Görünmeyen Maliyetler** | Borsaya ödeyeceğiniz Maker/Taker komisyonunu ve fiyat kaymasını (Slippage) baştan kâr/zarar hesabına katar. |
| **Otomatik Başa Baş (BE)** | İşlem kâra geçip TP1 hedefine ulaştığında, stop noktasını giriş maliyetinize çeker. Kazanan işlem kayba dönüşmez. |
| **Devre Kesici (Şalter)** | Ters giden bir piyasada arka arkaya stop olursanız (Örn: 3 kere) veya kasanız o gün %3 erirse, bot fişi çeker ve 24 saat işlem yapmaz. |
| **$5 Min. Koruması** | Riskiniz veya stop aralığınız çok küçükse ve hesaplanan emir boyutu $5 altında kalırsa, Binance hatası almak yerine işlemi zarifçe reddeder. |
