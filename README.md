# ⚡ Smart Money (SMC) Trading Bot

> 📖 **Detaylı Strateji Dokümantasyonu / Strategy Documentation**
>
> Botun işleme giriş/çıkış mantığı, SMC prensipleri, risk yönetimi ve şalter (circuit breaker) mekanizmasının tüm teknik detayları için **[trading_strategy.md](./trading_strategy.md)** belgesini inceleyebilirsiniz. Dosya içeriği hem teknik olmayan okuyucular hem de trader'lar için Türkçe ve İngilizce dillerinde hazırlanmıştır.

Bu proje, duygusuz ve tamamen sistemli bir şekilde çalışan otomatik bir kripto para alım-satım asistanıdır. Temel amacı sizin yerinize piyasayı 7/24 izlemek, belirlenen kurallara harfiyen uymak ve bakiyenizi koruyarak işlem yapmaktır.

---

## 🙋‍♂️ Sıfırdan Başlayanlar İçin: Bu Sistem Ne Yapar?

Bu botu, disiplinli, kuralları olan ve asla heyecana kapılmayan profesyonel bir fon yöneticisi gibi düşünebilirsiniz. 

### Sistemin Çalışma Mantığı
Kripto piyasasında fiyatlar sürekli iner ve çıkar. İnsanlar genelde "çok düştü alayım" veya "çok yükseldi satayım" diyerek zarara uğrar. Bu bot ise ekrana bakıp yön tahmini yapmaz. Sadece "Büyük Para"nın (kurumsal yatırımcıların) ayak izlerini takip eder. 

**Nasıl İşleme Girer?**
1. **Büyük resmi kontrol eder:** Önce 4 saatlik uzun vadeli grafiğe bakar. Piyasada genel bir yön (trend) var mı? Eğer piyasa kararsızsa ve yatay gidiyorsa, **asla işleme girmez**, nakitte bekler.
2. **Pusuya yatar:** Eğer piyasada net bir yükseliş varsa, fiyatın ucuzladığı özel "fırsat bölgelerini" (fiyat boşlukları) tespit eder ve oraya bir pusu (Limit Emir) atar.
3. **Acele etmez:** Fiyat o bölgeye gelmezse arkasından koşmaz, o işlemi iptal eder ve yeni fırsat arar.

**Nasıl İşleme GİRMEZ?**
- RSI dipte, MACD kesti diye işleme girmez.
- Piyasa yataysa (range) parayı riske atmaz.
- Hedeflenen kâr, göze alınan zarara değmiyorsa (Örneğin 100 dolar riske atıp 50 dolar kazanacaksa) o masaya oturmaz. Minimum kazanç/risk oranı her zaman botun lehine olmalıdır.

### Paranızı Nasıl Korur? (Risk Yönetimi)
En önemli kısım burasıdır. Bot kâr etmekten çok, elinizdeki parayı korumaya odaklanır:
- **Sabit Risk:** Kasanızda 10.000 dolarınız olsa bile, bot her işlemde kasanın sadece sizin belirlediğiniz çok ufak bir kısmını (örneğin %1'ini, yani 100 dolarını) riske atar. Fiyat aniden çakılsa bile kaybedeceğiniz miktar baştan bellidir.
- **Gizli Kesintileri Hesaba Katar:** Borsa komisyonlarını ve fiyat kaymalarını (slippage) işlem öncesinde hesaplar, sürpriz yaşatmaz.
- **Şalter Sistemi (Devre Kesici):** Üst üste 3 kere zarar ederse veya kasanız o gün %3 erirse, bot "Bugün piyasa kötü, ben dinleniyorum" der ve 24 saat boyunca kendini kilitler. İntikam işlemi (revenge trading) yapmaz.
- **Kârı Cebe Atar:** Fiyat hedefe doğru gittikçe kazancın bir kısmını garantiye alır. İlk kârı aldığında, olası zarar noktasını giriş fiyatına çeker. Yani işlem tersine dönse bile o saatten sonra zarar etmezsiniz.

---

## 📈 Trader'lar İçin: Strateji ve Teknik Detaylar (SMC)

Bu bot gecikmeli (lagging) indikatörler kullanmaz. Tamamen saf **Price Action** ve **Smart Money Concepts (SMC)** prensiplerine göre kodlanmıştır.

### Çoklu Zaman Dilimi (Multi-Timeframe) Analizi
- **Yön Tayini (HTF - 4H):** Bot, 4 saatlik grafiklerde EMA (20/50) ve Market Yapısı (Swing High/Low) analizi yaparak Bias (BULLISH, BEARISH veya NEUTRAL) belirler.
- **Tetikleyici (LTF - 15m):** Yön onaylandıktan sonra, LTF grafiğine inilir ve trend yönünde bir **MSS (Market Structure Shift / CHoCH)** gerçekleşmesi beklenir.

### Giriş (Entry) Konseptleri
Sistem, kırılım (MSS) gerçekleştikten sonra iki ana bölgeyi hedefler:
1. **FVG (Fair Value Gap):** Sert mumlarla oluşan fiyat dengesizlikleri. Bot, FVG'nin orta noktasını (Mitigation) hedefler.
2. **Breaker Block:** Kırılan eski destek/direnç blokları.
*Botun asıl gücü (Confluence), bu iki bölgenin örtüştüğü (FVG + Breaker Block) noktaları tespit etmesidir. Sadece yüksek güven skoruna sahip setup'larda limit emir ile pusu atılır.*

### Kurumsal Filtreler (Institutional Filters)
- **Killzones (İşlem Saatleri):** Bot, hacmin ve kurumsal paranın en yüksek olduğu Londra ve New York seanslarında (Killzones) aktiftir. Hacimsiz Asya seansındaki sahte hareketlerden (chop/fakeout) kaçınır. İşlem saatleri dışında yeni pozisyon aramaz ve bekleyen pusuları (limit emirleri) otomatik iptal eder.
- **ADX (Volatilite Gating):** Sadece yön bulmak (bias) yetmez, o yöndeki hareketin gücü de önemlidir. Bot, ADX (Average Directional Index) ile piyasanın momentumunu ölçer. Yeterli volatilite yoksa, mükemmel bir setup (MSS + FVG) olsa bile o masaya oturmaz.

### Emir ve Pozisyon Yönetimi
- **R:R (Risk/Reward):** Minimum R:R oranı şartı vardır. Hedefler Kademeli TP şeklindedir (TP1 %50 @ 1:2 R:R, TP2 %50 @ 1:3 R:R).
- **Break-Even (BE):** Fiyat TP1'e ulaştığında, kalan %50'lik pozisyonun Stop-Loss emri anında Entry (Giriş) fiyatına çekilir (Komisyonlar hesaba katılarak).
- **Gerçek Pozisyon Senkronizasyonu (True Position Sync):** Binance API'sinin gerçekleşen koşullu emirlerde (Stop-Loss) yaşattığı "-2013 Order does not exist" hatasını aşmak için doğrudan cüzdan/pozisyon boyutunu (`fetchPosition`) kontrol eder. Kapanan işlemleri saniyeler içinde fark edip hayalet (Ghost) emirleri güvenle temizler.
- **Ghost Order Koruması:** Limit emir beklerken piyasa yapısı tersine döner veya hedefe erken ulaşılırsa, bekleyen pusu emri anında iptal edilir.
- **Yerleşik Sesli Bildirimler:** İşleme girildiğinde, Kar (TP) alındığında, Zarar Kes (SL) çalıştığında veya sunucu hatası (Timeout) yaşandığında Windows ve Mac sistemlerinin kendi yerleşik uyarı seslerini kullanarak sizi haberdar eder. Ek dosya indirmeye gerek yoktur.
- **İngilizce Loglar:** Konsol çıktıları (loglar) uluslararası standartlara uyum için tamamen İngilizcedir (B1 seviyesi), kod içi açıklamalar ise Türkçe kalmaya devam eder.

---

## 💻 Yazılım İçin: Mimari ve Teknik Detaylar

Node.js ve TypeScript ile tamamen modüler, test edilebilir ve asenkron mimaride geliştirilmiştir. 

### Temel Modüller
- **Market Type:** Spot ve Futures (USDS-M) desteği. Futures modunda kaldıraç yönetimi ve likidasyon/margin hesaplamaları sisteme entegredir.
- **Position Sizer (`/src/risk/position_sizer.ts`):** Statik lot ataması yerine dinamik lot hesaplanır. `(Bakiye * %Risk - Maliyetler) / SL Mesafesi` formülü kullanılır. CCXT üzerinden `stepSize`, `tickSize` ve `minNotional` ($5 kuralı) filtreleri çekilip yuvarlamalar borsanın kabul edeceği kesin formata (precision) dönüştürülür.
- **Circuit Breaker (`/src/risk/circuit_breaker.ts`):** Durum makinesi (State Machine) mantığıyla çalışır. Verileri diske yazar (`circuit_breaker_state.json`), süreç Node.js crash olsa veya sunucu yeniden başlasa bile state kaybolmaz.
- **Order Manager (`/src/orders/order_manager.ts`):** Emirlerin takibi, dolum (fill) bildirimleri ve iptal süreçleri asenkron olarak yönetilir. WebSocket yerine REST API polling ile sağlam, kesintilere dayanıklı bir altyapı hedeflenmiştir.
- **Backtest Motoru (`/backtest`):** Stratejiyi izole bir şekilde test etmek için tasarlanmış yüksek hassasiyetli (High-Fidelity) yerleşik backtest altyapısıdır. Gerçekçi fiyat kaymaları, komisyonlar ve kötümser dolum (pessimistic execution) mantığı kullanır. Binance'in 1 dakikalık ham CSV verilerini indirip bunlardan kurgulanan HTF (ör. 4s) ve LTF (ör. 15dk) mumlarını sentezleyerek detaylı (yıllık, aylık, haftalık) PnL raporları (`summary.md`) ve işlem dökümleri (`trades.json`) üretir.

### Test Altyapısı (`/__tests__`)
Proje, Vitest tabanlı güçlü bir birim test (Unit Test) kalkanına sahiptir.
- Risk limitleri, lot hesaplamaları, zarar kesici mantıkları borsaya bağlanmadan sanal konfigürasyonlar (mockConfig) ile milisaniyeler içinde test edilir.
- `npm run test` komutuyla CI/CD pipeline'larında kodun bozulmadığından emin olunabilir. *(Testler gerçek .env anahtarlarını okumaz, bu bilinçli bir güvenlik kısıtlamasıdır).*

---

## ⚙️ Kurulum & Yapılandırma

### 1. Gereksinimler
- **Node.js** (v20.0.0 veya üzeri)
- **npm** (v9 veya üzeri)

### 2. Yükleme
```bash
git clone <repo-url>
cd trading-bot
npm install
```

### 3. Ayarlar (.env)
Örnek dosyayı kopyalayın:
```bash
cp .env.example .env
```
İçerisini yapılandırın:
```env
NETWORK=testnet                 # 'live', 'testnet' veya 'demo'
MARKET_TYPE=futures             # 'spot' veya 'futures'
FUTURES_LEVERAGE=5              # Kaldıraç oranı

BINANCE_API_KEY=senin_api_anahtarin
BINANCE_SECRET=senin_gizli_anahtarin

TRADING_PAIRS=BTC/USDT,ETH/USDT,SOL/USDT

RISK_PER_TRADE_PCT=1            # İşlem başına %1 risk
MAX_DAILY_LOSS_PCT=3            # Günlük %3 zarar sınırı (Şalter)
MAX_CONSECUTIVE_LOSSES=3        # 3 kere üst üste stop olursa şalter iner
```
> **GÜVENLİK UYARISI:** Binance'den API anahtarı alırken SADECE Spot veya Futures Trading yetkilerini açın. "Withdrawal (Çekim)" yetkisi ASLA AÇIK OLMAMALIDIR!

---

## 🚀 Kullanım Komutları

### Canlı Mod
Ayarlarınıza göre botu başlatır. (Demo ayarındaysa gerçek para kullanmaz)
```bash
npm run dev
```

### Dry-Run Modu
Borsaya **gerçek emir göndermeden**, canlı verilerle piyasayı tarar ve ne yapacağını loglar. Stratejiyi denemek için idealdir.
```bash
npm run dry-run
```

### Portföy Kontrol Aracı
Cüzdan bakiyenizi (Spot/Futures ayrı ayrı) ve borsadaki açık/bekleyen limit emirlerinizi hızlıca listeler:
```bash
npx tsx check_status.ts
```

### Backtest Çalıştırma
CSV verilerini indirip (1m), yüksek hassasiyetli simülasyon motorunda stratejinizi test etmek için:
```bash
npm run backtest:load    # Data hazırlığı ve sentez
npm run backtest:run     # Simülasyonu başlatır ve rapor üretir
```

### Testleri Çalıştırma
Geliştiriciler için, kodun sağlamlığını doğrular.
```bash
npm test              # Unit testler
npm run typecheck     # Tip kontrolleri
```
