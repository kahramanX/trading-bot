# Trading Strategy and Operations Manual

## Part A: For Normal People (Simple Explanation)

### How the Robot Works
Imagine you have a very patient guard watching the markets for you all day and night. This guard does not panic, does not feel greedy, and strictly follows a set of safety rules before spending your money.

### Finding the Right Time to Buy or Sell
The robot looks at the big picture first. It checks if the overall market is going up or down. If the market is confusing or moving sideways, the robot simply does nothing and keeps your money safe. It only acts when there is a clear trend.

Once the general direction is clear, the robot acts like a sniper. It looks for temporary price drops in an uptrend, or temporary rises in a downtrend. It places a "trap" order exactly where the price is most likely to bounce back. If the price never hits the trap, the robot simply cancels it and moves on. It never chases the market.

### Protecting Your Money
The robot cares more about not losing money than making money. 
Before opening any trade, it calculates exactly how much money is in your wallet. It will only risk a very tiny portion (like 1%) of your money on a single trade. Even if the trade goes completely wrong, you only lose that 1%.

It also has a safety switch. If it loses 3 times in a row, or loses a total of 3% of your money in a single day, it turns itself off for 4 hours. It assumes the market is crazy that day and decides to take a break.

### Securing the Profit
When a trade goes well, the robot doesn't wait greedily for the absolute top. It splits the profit. Once it makes a decent amount, it sells half of the position to secure the profit. Immediately after that, it moves your safety net (stop loss) to your exact entry price. This means even if the market suddenly crashes, the worst thing that happens is you break even on the remaining half. You will never lose money on a trade that has already reached its first target.

## Part B: For Traders (Algorithmic & SMC Logic)

### Market Structure and Bias (HTF)
The system employs a multi-timeframe approach, establishing directional bias on the Higher Timeframe (HTF) before looking for entries. Bias is determined by the relationship between the current price and the 200 EMA, combined with the HTF swing structure. If the price is near the EMA (ranging) or if the structure contradicts the EMA direction, the system assumes a neutral stance and filters out the pair.

### Entry Criteria and Confluence (LTF)
Entries are executed strictly on the Lower Timeframe (LTF). The core trigger is a confirmed Market Structure Shift (MSS) that aligns with the established HTF bias. A valid MSS requires a candle close beyond the recent swing point.

Once MSS is confirmed, the algorithm scans for two specific liquidity footprints:
Fair Value Gaps (FVG): The system identifies unfilled imbalances and targets the midpoint for mitigation.
Breaker Blocks: The system locates failed order blocks that led to the recent liquidity sweep.

The engine requires confluence. It calculates an overlap confidence score between the FVG and the Breaker Block. Limit orders are placed only when these zones intersect, ensuring high-probability entries at optimal discounted pricing.

### Institutional Filters (Killzones & Volatility)
To maximize the probability of success, the system employs strict filters before executing any confirmed entry:
1. **Killzones (Session Filtering):** The bot strictly operates during high-volume institutional windows (London and New York sessions). It completely avoids the low-volume, choppy Asian session. Any pending limit orders that are not filled by the end of a session are automatically canceled.
2. **Volatility Gating (ADX):** A directional bias and structural shift mean nothing without momentum. The algorithm checks the Average Directional Index (ADX) to gauge market volatility. If the market is too quiet (low ADX), the entry is suppressed, protecting the capital from false breakouts (fakeouts).

### Algorithmic Risk Management
Position sizing is strictly dynamic. The system calculates the lot size based on a fixed risk percentage of the total free balance, precisely factoring in the distance to the structural Stop Loss and the estimated exchange execution costs. It automatically rounds down to meet the asset's step size constraints.

A dedicated Circuit Breaker acts as a systemic risk shield. It tracks daily realized PnL and consecutive stop-outs. If the daily drawdown exceeds the maximum threshold, or if three consecutive stop-losses occur, the system triggers a hard freeze for 4 hours, ignoring all incoming signals to avoid chop environments.

### Trade Management and True Position Sync
The exit logic utilizes a dual Take Profit (TP) model based on Risk:Reward ratios. TP1 is positioned at 1:2 R:R (closing 50% volume), and TP2 is set at 1:3 R:R. The exact moment TP1 is hit, the engine modifies the remaining Stop Loss to absolute break-even.

To prevent hanging ghost orders caused by API conditional order discrepancies, the system employs True Position Sync. Before evaluating any active trade state, it queries the exchange for the actual live position size. If the position is zero, the engine instantly assumes external closure (via SL, liquidation, or manual intervention) and forcefully sweeps all lingering limit and trigger orders.

### High-Fidelity Backtesting Engine
The strategy's robustness is continuously validated through a custom, built-in backtesting engine (`/backtest`). Unlike basic testers, it uses highly granular 1-minute CSV data from Binance, synthesizing it into HTF and LTF representations. It simulates real-world conditions like exact exchange fees, pessimistic execution (worst-case fills), and strict TTLs (Time-To-Live) on orders, producing comprehensive yearly, monthly, and weekly PnL reports.

## Bölüm A: Normal İnsanlar İçin (Basit Anlatım)

### Robot Nasıl Çalışır
Piyasaları sizin yerinize gece gündüz izleyen çok sabırlı bir güvenlik görevliniz olduğunu hayal edin. Bu görevli asla paniğe kapılmaz, açgözlülük yapmaz ve paranızı harcamadan önce bir dizi güvenlik kuralına sıkı sıkıya uyar.

### Doğru Alım Satım Zamanını Bulmak
Robot önce büyük resme bakar. Piyasanın genel olarak yukarı mı yoksa aşağı mı gittiğini kontrol eder. Eğer piyasa kararsızsa ve yatay hareket ediyorsa, robot hiçbir şey yapmaz ve paranızı güvende tutar. Sadece net bir yön olduğunda harekete geçer.

Genel yön netleştiğinde, robot bir keskin nişancı gibi davranır. Yükselen bir piyasada geçici fiyat düşüşlerini, düşen bir piyasada ise geçici fiyat artışlarını arar. Fiyatın geri sekme ihtimalinin en yüksek olduğu noktaya bir "tuzak" emri yerleştirir. Eğer fiyat o tuzağa hiç gelmezse, robot emri iptal eder ve yeni fırsatlar arar. Asla piyasanın arkasından koşmaz.

### Paranızı Korumak
Robot para kazanmaktan çok para kaybetmemeye odaklanır. 
Herhangi bir işlem açmadan önce cüzdanınızda tam olarak ne kadar para olduğunu hesaplar. Tek bir işlemde paranızın sadece sizin belirlediğiniz çok küçük bir kısmını (örneğin %1'ini) riske atar. İşlem tamamen ters gitse bile sadece o %1'i kaybedersiniz.

Ayrıca bir şalter sistemi vardır. Üst üste 3 kez zarar ederse veya tek bir günde paranızın %3'ünü kaybederse, kendini 4 saatliğine kapatır. O gün piyasanın çok dengesiz olduğunu varsayar ve dinlenmeye çekilir.

### Kârı Güvenceye Almak
Bir işlem iyi gittiğinde, robot en tepe noktayı açgözlülükle beklemez. Kârı böler. Makul bir kazanç elde ettiğinde, kârı garantilemek için pozisyonun yarısını satar. Hemen ardından, güvenlik ağınızı (zarar kesme noktasını) tam olarak giriş fiyatınıza çeker. Bu sayede piyasa aniden çökse bile, kalan yarıdan en kötü ihtimalle sıfır zararla çıkarsınız. Hedefine ulaşmış bir işlemden asla para kaybetmezsiniz.

## Bölüm B: Trader'lar İçin (Algoritmik ve SMC Mantığı)

### Market Yapısı ve Bias (HTF)
Sistem çoklu zaman dilimi (multi-timeframe) yaklaşımı kullanır ve giriş fırsatları aramadan önce Yüksek Zaman Diliminde (HTF) yön tayini (bias) yapar. Bias, mevcut fiyatın 200 EMA ile olan ilişkisinin HTF swing yapısıyla birleştirilmesiyle belirlenir. Eğer fiyat EMA'ya çok yakınsa (range) veya yapı EMA yönüyle çelişiyorsa, sistem nötr duruma geçer ve o pariteyi eler.

### Giriş Kriterleri ve Kesişim (LTF)
Giriş işlemleri kesinlikle Düşük Zaman Diliminde (LTF) yürütülür. Temel tetikleyici, HTF yönüyle uyumlu onaylanmış bir Market Structure Shift (MSS) yani yapı kırılımıdır. Geçerli bir MSS, son swing noktasının ötesinde net bir mum kapanışı gerektirir.

MSS onaylandıktan sonra, algoritma iki spesifik likidite izini tarar:
Fair Value Gap (FVG): Sistem doldurulmamış fiyat dengesizliklerini tespit eder ve orta noktasını (Mitigation) hedefler.
Breaker Block: Son likidite temizliğine yol açan kırılmış emir bloklarını bulur.

Motor bir kesişim (confluence) arar. FVG ve Breaker Block arasında bir örtüşme güven skoru hesaplar. Limit emirler sadece bu bölgeler kesiştiğinde yerleştirilir, böylece optimal indirimli fiyatlardan yüksek olasılıklı girişler sağlanır.

### Kurumsal Filtreler (Killzone ve Volatilite)
Başarı olasılığını en üst düzeye çıkarmak için, sistem onaylanmış bir girişi işleme almadan önce katı filtreler uygular:
1. **Killzones (Seans Filtreleme):** Bot kesinlikle yüksek hacimli kurumsal pencerelerde (Londra ve New York seansları) çalışır. Düşük hacimli, dalgalı (choppy) Asya seansından tamamen kaçınır. Seans sonuna kadar dolmayan (fill edilmeyen) tüm bekleyen limit emirler otomatik olarak iptal edilir.
2. **Volatilite Gating (ADX):** Yön tahmini (bias) ve yapısal kırılım (MSS), momentum olmadan hiçbir şey ifade etmez. Algoritma, piyasa volatilitesini ölçmek için ADX (Average Directional Index) indikatörünü kontrol eder. Piyasa çok durgunsa (düşük ADX), giriş işlemi iptal edilir ve sermaye sahte kırılımlardan (fakeouts) korunur.

### Algoritmik Risk Yönetimi
Pozisyon büyüklüğü tamamen dinamiktir. Sistem, toplam serbest bakiyenin sabit bir risk yüzdesini baz alarak, yapısal Stop Loss mesafesini ve tahmini borsa komisyon maliyetlerini hesaba katarak lot miktarını hesaplar. Varlığın adım boyutu (step size) kısıtlamalarına uymak için otomatik olarak aşağı yuvarlama yapar.

Özel bir Devre Kesici (Circuit Breaker) sistemik risk kalkanı olarak çalışır. Günlük gerçekleşen PnL'i ve üst üste olan stop işlemlerini takip eder. Eğer günlük düşüş maksimum sınırı aşarsa veya üst üste üç stop-loss gerçekleşirse, sistem kendini 4 saat boyunca kilitler ve dalgalı (chop) ortamlardan kaçınmak için gelen tüm sinyalleri reddeder.

### İşlem Yönetimi ve Gerçek Pozisyon Senkronizasyonu
Çıkış mantığı, Risk:Ödül (R:R) oranlarına dayalı ikili bir Take Profit (TP) modeli kullanır. TP1 1:2 R:R seviyesinde (hacmin %50'sini kapatarak) konumlandırılır, TP2 ise 1:3 R:R seviyesine ayarlanır. TP1'e ulaşıldığı an, motor kalan pozisyonun Stop Loss noktasını anında sıfır risk (break-even) seviyesine taşır.

Borsa API'lerindeki koşullu emir uyumsuzluklarından kaynaklanan hayalet emirleri (ghost orders) engellemek için sistem Gerçek Pozisyon Senkronizasyonu kullanır. Aktif bir işlemin durumunu değerlendirmeden önce borsaya bağlanıp anlık gerçek pozisyon büyüklüğünü sorgular. Eğer pozisyon sıfırsa, motor işlemin dışarıdan (SL, likidasyon veya manuel müdahale ile) kapatıldığını anında anlar ve askıda kalan tüm limit ve tetikleyici emirleri zorla temizler.

### Yüksek Hassasiyetli Backtest Motoru (High-Fidelity Backtesting)
Stratejinin sağlamlığı, özel olarak geliştirilmiş yerleşik bir backtest motoru (`/backtest`) aracılığıyla sürekli olarak doğrulanır. Basit test araçlarının aksine, Binance'den alınan son derece detaylı 1 dakikalık CSV verilerini kullanır ve bunları HTF/LTF mumlarına sentezler. Kesin borsa komisyonları, kötümser dolum (pessimistic execution - en kötü senaryoda gerçekleşme) ve emirlere uygulanan katı zaman aşımları (TTL) gibi gerçek dünya koşullarını simüle ederek kapsamlı yıllık, aylık ve haftalık PnL raporları üretir.
