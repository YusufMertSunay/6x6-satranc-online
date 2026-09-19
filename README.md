# 6x6 Satranç Online

Kendi 6x6 satranç varyantınızın gerçek zamanlı, internetten oynanabilir hâli
— lichess/chess.com tarzında: hesap oluşturma, rastgele rakip eşleştirme
(matchmaking), süreli oyunlar (saat), Elo puanlama sistemi ve liderlik
tablosu.

## Bu projede neler var

- **Sunucu** (`server.js` + `lib/`): Node.js'in **yerleşik modülleri dışında
  hiçbir npm paketi kullanmadan** yazılmış bir HTTP + Server-Sent Events
  (SSE) sunucusu.
- **İstemci** (`public/`): Sade HTML/CSS/JavaScript ile yazılmış lobi ve
  oyun tahtası arayüzü (herhangi bir çerçeve/framework kullanılmadı).
- **Motor** (`engine/`): Kendi 6x6 varyantınız için ayarlanmış
  `variants.ini` dosyanız ile birlikte Fairy-Stockfish motoru (Linux
  derlemesi). Motor SADECE hamle yasallığı kontrolü için kullanılıyor —
  masaüstü uygulamanızdaki ilkeyle birebir aynı şekilde, canlı oyun
  sırasında oyunculara asla bir değerlendirme (eval) ya da "en iyi hamle"
  gösterilmiyor.

## Neden hiç npm paketi yok?

Bu projeyi geliştirdiğim sandbox ortamında npm kayıt sunucusuna
(`registry.npmjs.org`) erişim organizasyon politikasıyla tamamen
engellenmişti — yani Express, Socket.io, better-sqlite3, bcrypt gibi hiçbir
paketi kuramadım. Bunun yerine tüm sunucuyu Node'un kendi yerleşik
modülleriyle yazdım:

| Normalde kullanılan  | Bunun yerine kullanılan             |
|-----------------------|--------------------------------------|
| Express               | `http` modülü + elle yönlendirme     |
| Socket.io             | Server-Sent Events (SSE)             |
| SQLite / Postgres     | Düz JSON dosyaları (`data/`)         |
| bcrypt                | `crypto.scryptSync`                  |
| JWT / express-session | Bellekte tutulan basit oturum token'ı|

**Önemli:** Kendi sunucunuzda (Render, Railway, kendi VPS'iniz) böyle bir
kısıtlama OLMAYACAK. Yani bu haliyle de tamamen çalışır durumda, ama
isterseniz ileride yukarıdaki tabloyu "gerçek" sürümleriyle
değiştirebilirsiniz (örn. `npm install express socket.io better-sqlite3
bcrypt` ve kodu buna göre uyarlamak). Küçük/orta ölçekli bir oyun sitesi
için mevcut haliyle de gayet sağlam ve yeterlidir; birkaç yüz/bin
kullanıcıya kadar sorunsuz çalışır.

## Yerelde çalıştırma

```bash
cd web-chess
node server.js
```

Tarayıcıda `http://localhost:3000` adresini açın. Node.js 18 ya da üzeri
gerekir (yerleşik `fetch`/`EventSource` API'leri kullanılmıyor sunucu
tarafında, ama Node 18+ önerilir).

İki farklı tarayıcı sekmesinde (ya da biri gizli pencerede) iki farklı
hesapla giriş yaparak kendi kendinize test edebilirsiniz.

## Kalıcı olarak internete yayınlama (deploy)

### Seçenek 1: Render.com (önerilen, kolay ve ücretsiz katmanı var)

1. Bu klasörü bir GitHub deposuna yükleyin (`git init`, `git add .`,
   `git commit`, ardından GitHub'da yeni bir depo oluşturup push edin).
2. [render.com](https://render.com) üzerinde ücretsiz hesap açın, **"New +
   Web Service"** deyip GitHub deponuzu bağlayın.
3. Ayarlar:
   - **Environment:** Node
   - **Build Command:** `chmod +x engine/fairy-stockfish`
   - **Start Command:** `node server.js`
4. Deploy edin. Render size `https://sizin-adiniz.onrender.com` gibi bir
   adres verecek — oyun artık herkese açık bir bağlantı ile oynanabilir.

**Dikkat:** Render'ın ücretsiz katmanındaki dosya sistemi her yeniden
başlatmada (deploy, uyanma vb.) sıfırlanır — yani `data/` klasöründeki
kullanıcılar/oyunlar zamanla silinebilir. Kalıcı veri istiyorsanız Render'ın
ücretli "Persistent Disk" özelliğini `data/` klasörüne bağlayın, ya da
ileride gerçek bir veritabanına (Postgres gibi, Render'da ücretsiz katmanı
da var) geçin.

### Seçenek 2: Railway.app

Render'a çok benzer bir akış: GitHub deposunu bağlayın, start command
olarak `node server.js` verin. Railway'de de kalıcı disk için ek ayar
gerekir.

### Seçenek 3: Kendi VPS'iniz (DigitalOcean, Hetzner, vb.)

En kalıcı ve esnek seçenek budur — dosya sisteminiz sıfırlanmaz.

```bash
git clone <sizin-repo-adresiniz>
cd web-chess
chmod +x engine/fairy-stockfish
npm install -g pm2          # sunucuyu arka planda ayakta tutmak için
pm2 start server.js --name satranc
pm2 save
```

Kendi alan adınızı bağlamak ve HTTPS eklemek için önüne bir **nginx**
ters vekil (reverse proxy) koyup **certbot** ile ücretsiz SSL sertifikası
alabilirsiniz.

## Telif hakkı ve lisanslama hakkında

Sorduğunuz "telif hakkı almam gerekir mi" sorusuna dair notlar:

- **Kendi kodunuz için:** Türkiye'de (ve çoğu ülkede) bir eseri
  oluşturduğunuz anda telif hakkı otomatik olarak sizindir — ayrıca bir
  tescil/başvuru yapmanız ŞART DEĞİL. Ancak projeye bir `LICENSE` dosyası
  eklemek (bu depoya `LICENSE` olarak ekledim, "tüm hakları saklıdır"
  şeklinde) başkalarının kodunuzu izinsiz kopyalayıp kullanamayacağını
  açıkça belirtir ve olası bir anlaşmazlıkta elinizi güçlendirir. Daha
  resmi bir koruma isterseniz Kültür ve Turizm Bakanlığı'nın telif hakları
  kayıt sistemine (isteğe bağlı) başvurabilirsiniz — bu genellikle bir
  ihlal durumunda dava açarken işinizi kolaylaştırır ama şart değildir.
- **Fairy-Stockfish için:** Bu motor GPLv3 lisansı ile dağıtılıyor ve siz
  onun derlenmiş hâlini (binary) projenizle birlikte dağıtıyorsunuz. GPLv3,
  motoru OLDUĞU GİBİ (kendi kodunuza gömmeden, ayrı bir alt süreç olarak)
  kullandığınız sürece bunu yapmanıza izin verir — tıpkı lichess.org'un
  kendisinin de Stockfish'i bu şekilde kullanması gibi. Sadece şu şartlara
  uymanız gerekiyor: (1) GPLv3 lisans metnini projenizde bulundurmak
  (`LICENSE-THIRDPARTY.md` olarak ekledim), (2) Fairy-Stockfish'in kaynak
  koduna nereden ulaşılabileceğini belirtmek (zaten herkese açık:
  https://github.com/fairy-stockfish/Fairy-Stockfish). Motorun kendi iç
  kodunu değiştirmediğiniz sürece (siz sadece `variants.ini` ile
  yapılandırıyorsunuz, kaynak kodunu değiştirmiyorsunuz), kendi oyun
  kodunuzu GPL'e tabi tutmanız gerekmez — kendi kodunuz için istediğiniz
  lisansı (ya da "tüm hakları saklıdır") seçebilirsiniz.

## Proje yapısı

```
web-chess/
├── server.js              # HTTP + SSE sunucusu, tüm API uçları
├── engine/
│   ├── fairy-stockfish     # Motor (Linux binary)
│   └── variants.ini        # 6x6 varyant tanımınız
├── lib/
│   ├── engine.js           # UCI motor sarmalayıcı
│   ├── gameManager.js      # Eşleştirme, hamle uygulama, oyun bitişi, Elo
│   ├── store.js            # JSON dosya tabanlı veri deposu
│   ├── auth.js             # Parola hash'leme + oturum yönetimi
│   ├── events.js           # SSE (gerçek zamanlı bildirim) merkezi
│   ├── elo.js              # Elo puan hesaplama
│   └── rules.js            # Yetersiz taş / kare-koordinat yardımcıları
├── public/
│   ├── index.html          # Giriş/kayıt + lobi
│   ├── game.html           # Oyun tahtası sayfası
│   ├── css/style.css
│   └── js/
│       ├── app.js           # Lobi mantığı
│       └── game.js          # Oyun tahtası mantığı
└── data/                   # Çalışma zamanında oluşan JSON veri dosyaları
```

## Şu an desteklenen özellikler

- Kayıt / giriş (kullanıcı adı + parola)
- Süre kontrolü seçimi (3+2, 5+8, 10+0) ve rastgele rakip eşleştirme
- Gerçek zamanlı hamle senkronizasyonu (SSE üzerinden, sayfa yenilemeye
  gerek yok)
- Tıkla-taşı ile oynama, yasal hedef karelerin işaretlenmesi
- Terfi (promosyon) seçim penceresi
- Şah mat / pat / yetersiz taş / süre dolması / teslim olma / anlaşmalı
  beraberlik — tüm bitiş türleri motor üzerinden doğru şekilde tespit
  ediliyor
- Elo puanlama sistemi ve liderlik tablosu
- Devam eden oyuna geri dönme (sayfa yenilense bile)
- Son oynanan oyunların geçmişi

## Sonraki adım olarak eklenebilecekler (henüz yok)

- Oyun sonrası analiz tahtası (masaüstü uygulamanızdaki gibi eval barı,
  hamle gezinme) — bu bilinçli olarak bu ilk sürüme dahil edilmedi, önce
  temel çevrimiçi oynanışın sizin için sorunsuz çalıştığını doğrulamak
  istedim. İsterseniz bir sonraki adımda ekleyebiliriz.
- Sohbet/emoji, arkadaş listesi, turnuvalar gibi sosyal özellikler
- Gerçek bir veritabanına geçiş (kalıcılığı garantilemek için)
