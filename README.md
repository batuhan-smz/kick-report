# Kick Report (prototip)

PUBG maçlarındaki öldürme / düşürme / ölüm anlarını bulur, aynı saatte açık olan Kick yayınını o saniyeden oynatır.

## Kurulum

1. Node.js 18 veya üstü kur.
2. https://developer.pubg.com adresinden ücretsiz bir PUBG API anahtarı al.
3. Bu klasörde:

```bash
# macOS / Linux
PUBG_API_KEY=anahtarin ADMIN_PASSWORD=yonetici-sifresi npm start

# Windows PowerShell
$env:PUBG_API_KEY="anahtarin"; $env:ADMIN_PASSWORD="yonetici-sifresi"; npm start
```

4. Tarayıcıda http://localhost:3000 adresini aç.
5. Sunucu açık kaldıkça Kick'te PUBG yayını yapan kanalları kendisi bulur ve ekler (aşağıya bak). Liste `data/streamers.json` dosyasına yazılır.

### Yönetici sayfası

Yayıncıları yönetmek için adres çubuğuna `/streamers` yaz (ör. `http://localhost:3000/streamers`). Menüde bağlantısı yok, normal kullanıcılar görmez. Sayfa şifre ister.

- Şifre `ADMIN_PASSWORD` ortam değişkeninden okunur. Verilmezse ilk açılışta rastgele bir şifre üretilir ve `data/admin-password.txt` dosyasına yazılır. Sunucu açılırken konsolda şifrenin nerede olduğu yazar.
- Doğru şifre girince tarayıcıya 7 gün geçerli, imzalı bir oturum çerezi verilir (HttpOnly, SameSite=Strict). Şifreyi değiştirirsen bütün oturumlar geçersizleşir.
- Yayıncı ekleme, silme ve otomatik bulma durumu sunucu tarafında da şifreyle korunur. Yayıncı listesinin kendisi herkese açıktır, çünkü ana sayfa ve arama onu kullanır.
- Bir IP 15 dakikada en fazla 10 yanlış şifre deneyebilir.
- Site HTTPS arkasında çalışıyorsa (vekil sunucu `X-Forwarded-Proto: https` gönderiyorsa) çerez `Secure` olarak işaretlenir.
6. Ana sayfada sadece PUBG oyuncu adını yazıp Ara'ya bas. Oyuncunun maçlarında oynayan **bütün** kayıtlı yayıncıların yayınları bulunur.

### Otomatik yayıncı bulma

`discovery.js` sunucuyla birlikte çalışır:

1. 10 dakikada bir `kick.com/stream/livestreams/all?subcategory=pubg-battlegrounds` listesinden Kick'te şu an PUBG yayını yapan bütün kanallar çekilir.
2. Her kanal için Kick kullanıcı adı ve kanal adı (ör. `F1ZYY_T`, `f1zyy-t`, `f1zyy_t`) Steam'de PUBG adı olarak aranır. Tek istekte 10 isim sorulur, çok izlenen yayınlar önce gelir.
3. Aynı adlı PUBG hesabının **yayın başladıktan sonra** oynanmış bir maçı varsa eşleşme doğrulanır ve yayıncı `source: "auto"` olarak eklenir. Maç yoksa ve yayın yeni başladıysa 10 dakika sonra tekrar bakılır. 2 saattir yayındayken hâlâ maç yoksa vazgeçilir (3 gün sonra yeniden denenir).
4. Hiçbir adı PUBG'de olmayan kanallar Yayıncılar sayfasında "PUBG adı bulunamayanlar" listesinde görünür, buradan tek tıkla elle eşleştirilebilir (7 gün sonra yeniden denenir).
5. Yanlış bir otomatik eşleşmeyi silersen o kanal bir daha otomatik eklenmez. Elle eklenen kayıt, aynı kanalın otomatik kaydının yerine geçer.

PUBG oyuncu araması dakikada 10 ile sınırlı. Otomatik bulma her dakika bunun en fazla 6'sını kullanır, 4'ü kullanıcı aramalarına kalır. Durum ve aday kanallar `data/discovery.json` dosyasında tutulur.

Ayarlar (ortam değişkenleri):

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `DISCOVERY` | açık | `0` ile kapatılır |
| `PUBG_RPM` | `10` | PUBG anahtarının dakikalık oyuncu araması limiti (daha yüksek limitli anahtarın varsa artır) |
| `DISCOVERY_RESERVE` | `4` | Her dakika kullanıcı aramalarına bırakılan istek sayısı |
| `DISCOVERY_MAX_PAGES` | `10` | Taramada okunacak sayfa sayısı (sayfa başına 24 yayın) |

### Sayfalar

- `/`: büyük arama kutusu ve takip edilen yayıncılar (Kick profil resmi, canlı yayın durumu)
- `/players/{platform}/{ad}`: oyuncu sayfası, paylaşılabilir. Üstte özet (maç, yayında, yayıncı, öldürme, ölüm), olay türü ve yayın filtreleri, altında maç maç video kartları. Sadece yayıncıyla birebir etkileşimler gösterilir. Her kart ya oyuncunun **Kendi yayını** ya da oyuncunun vurduğu / oyuncuyu vuran yayıncının **Rakip tepkisi**dir. Karta tıklayınca video penceresi açılır; Önceki/Sonraki (Shift + ok tuşları) ile anlar arasında gezilir, Esc kapatır.
- `/streamers`: yönetici sayfası (şifreli, menüde yok): otomatik bulma durumu, yayıncı ekleme, silme ve elle eşleştirme

**Anahtarsız deneme:** En az bir yayıncı kaydettikten sonra http://localhost:3000/?demo=1 adresini aç. İlk kayıtlı yayıncının Kick yayınları gerçek, PUBG olayları sahte olur.

## Nasıl çalışır

1. Sunucu PUBG API'den oyuncunun son maçlarını alır (PUBG maçları 14 gün saklar).
2. Her maçın katılımcı listesi kayıtlı yayıncılarla karşılaştırılır (`streamers` alanı). Oyuncunun kendisi, rakipleri veya aynı maçtaki herhangi bir yayıncı olabilir.
3. Tarayıcı, bulunan yayıncıların geçmiş yayınlarını `kick.com/api/v2/channels/{kanal}/videos` üzerinden çeker (başlangıç saati, süre ve HLS adresi). Sadece maçlarda gerçekten görünen kanallar sorgulanır.
4. Maç başlangıcı hangi yayının içine düşüyorsa eşleştirilir. En az bir yayında görünen maçların telemetrisi indirilir.
5. Telemetriden `LogPlayerMakeGroggy` (düşürme) ve `LogPlayerKillV2` (öldürme) olayları çıkarılır.
6. Her olay, olaya birebir dahil olan yayınlar için bir kart olur: **kendi yayını** (aranan oyuncu yayıncıysa) ve **rakip** (öldürülen / öldüren yayıncının yayını). Aynı maçta olup oyuncuyla çatışmayan yayıncılar gösterilmez. Kartta silah, mesafe (metre) ve maçtaki sıralama da gösterilir.
7. Videodaki saniye, kaydın segment listesindeki gerçek saatlerden (`#EXT-X-PROGRAM-DATE-TIME`) hesaplanır. Kick kayıtları bildirilen başlangıçtan birkaç saniye önce başlayabiliyor ve yayın koptuğunda arada video olmuyor. Bu yüzden basit "olay saati − yayın başlangıcı" hesabı kopmalı kayıtlarda onlarca saniye geç kalır. Liste okunamazsa yedek olarak bu basit hesap kullanılır.

Video ile oyun saati arasında birkaç saniyelik kayma olursa video penceresindeki **Senkron düzeltme** alanını kullan.

## Android uygulaması (TWA)

`android/` klasöründe sitenin Android uygulaması var. Uygulama bir Trusted Web Activity: siteyi telefondaki Chrome motoruyla, adres çubuğu olmadan tam ekran açar. Site güncellenince uygulama da kendiliğinden güncellenir, sadece ikon, ad ya da alan adı değişirse yeniden derlemek gerekir.

**Gerekenler:** Site herkese açık bir **HTTPS** alan adında yayında olmalı (`localhost` olmaz). Bilgisayarda Android Studio kurulu olmalı (JDK ve Android SDK onunla gelir).

**Derleme:**

```powershell
cd android
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Domain alanadin.com
```

Betik alan adını `android/twa.properties`'e yazar, ilk seferde imza anahtarını oluşturur ve şunları üretir:

- `android/dist/KickReport-<sürüm>.apk`: telefona doğrudan kurmak için
- `android/dist/KickReport-<sürüm>.aab`: Google Play'e yüklemek için

Sonraki derlemelerde `-Domain` vermene gerek yok. Play'e her yeni yüklemede `twa.properties` içindeki `versionCode` değerini bir artır.

**Adres çubuğunun görünmemesi için (Digital Asset Links):** Android, uygulamayı tam ekran açmadan önce `https://alanadin.com/.well-known/assetlinks.json` adresinde uygulamanın imza parmak izini arar. Sunucu bu dosyayı kendisi verir: parmak izini `android/keystore/sha256.txt` dosyasından ya da `TWA_SHA256` ortam değişkeninden okur. Sunucuyu `android/` klasörünün olmadığı bir yerde çalıştırıyorsan `TWA_SHA256` ver. Uygulamayı Google Play'e yüklersen Play kendi anahtarıyla yeniden imzalar: Play Console > Uygulama bütünlüğü > Uygulama imzalama sayfasındaki SHA-256 değerini de virgülle ekle:

```powershell
$env:TWA_SHA256="<yerel parmak izi>,<Play parmak izi>"; npm start
```

`build.ps1` derlemenin sonunda sitedeki dosyayı kontrol eder ve uygulamayla eşleşip eşleşmediğini söyler.

**İmza anahtarı:** `android/keystore/` klasörü (anahtar + şifresi) uygulamanın kimliğidir. **Yedekle ve kimseyle paylaşma.** Kaybolursa aynı paket adıyla güncelleme yayınlanamaz (Play App Signing kullanıyorsan Google'dan yükleme anahtarı sıfırlaması istenebilir).

Site ayrıca bir PWA: `manifest.webmanifest`, `sw.js` (bağlantı yokken son açılan sayfa ve `offline.html`) ve ikonlar. İkonları değiştirmek için `tools/make-icons.js` içindeki tasarımı düzenleyip `PW_CHANNEL=msedge node tools/make-icons.js` çalıştır; web ve Android ikonları birlikte yeniden çizilir.

## Dosyalar

- `server.js`: PUBG API vekili, telemetri ayrıştırma, yayıncı kaydı, yönetici girişi, `assetlinks.json` ve statik dosyalar (bağımlılık yok)
- `discovery.js`: otomatik yayıncı bulma
- `public/`: arayüz (`index.html`, `app.js`, `style.css`), PWA dosyaları (`manifest.webmanifest`, `sw.js`, `offline.html`, `icons/`)
- `android/`: TWA Android projesi (`build.ps1` ile derlenir)
- `tools/make-icons.js`: web ve Android ikonlarını tek tasarımdan üretir
- `test/discovery.js`: sahte Kick + PUBG ile otomatik bulma testi (`npm run test:discovery`, ek paket gerekmez)
- `test/e2e.js`: sahte PUBG API ile uçtan uca tarayıcı testi (Playwright gerekir; `PW_CHANNEL=msedge` ile sistemdeki Edge kullanılabilir)

## Bilinen sınırlar

- Kick VOD uç noktası resmi değil ve her an değişebilir.
- Varsayılan PUBG anahtarı dakikada 10 istekle sınırlı. Maç ve telemetri istekleri bu limite sayılmaz, oyuncu araması sayılır.
- Otomatik bulma sadece **canlı** PUBG yayınlarını görür. Liste, sunucu açık kaldıkça zamanla dolar. Oyunda farklı ad kullanan yayıncılar elle eşleştirilmeli.
- Otomatik bulma sadece Steam'de arar. Kakao ve konsol yayıncıları elle eklenmeli.
- Kick'in canlı yayın listesi de resmi olmayan bir uç nokta. Kick sunucu isteklerini engellerse Yayıncılar sayfasında "Son hata" olarak görünür.
- Tek bir yönetici şifresi var, kullanıcı hesabı yok. Siteyi internete açacaksan HTTPS arkasında çalıştır, yoksa şifre ağda açık metin gider.
- Önbellek bellekte tutuluyor, sunucu yeniden başlayınca siliniyor.

## Büyütmek için yapılacaklar

1. **Yayıncı kaydı:** Kick OAuth (resmi API) ile yayıncılar kendileri giriş yapıp PUBG hesaplarını bağlar (şu an elle ekleniyor).
2. **Arka plan işçisi:** Kayıtlı yayıncıların maçlarını düzenli tarar ve olayları veritabanına yazar (Postgres + bir kuyruk).
3. **Tepkiler (reactions):** Tüm kayıtlı yayıncıların olayları tek tabloda tutulur. "A, B'yi öldürdü" olayında iki tarafın videosu da gösterilir.
4. **Canlı yayın desteği:** Kick webhook'larıyla yayın başlangıcı anında kaydedilir. Böylece VOD henüz oluşmadan eşleştirme yapılabilir.
5. **Kalıcı önbellek:** Telemetri dosyaları büyük (birkaç MB), sadece çıkarılan olaylar saklanır.
6. **Hukuki taraf:** Kick ile iletişime geçip VOD gösterimi için izin alınır ve PUBG API kullanım şartlarına uyulur.
7. **Yayın:** Herhangi bir Node sunucusunda (Railway, Fly.io, VPS) ya da Vercel/Supabase ile çalıştırılabilir.
