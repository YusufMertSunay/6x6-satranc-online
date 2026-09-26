// lib/gameManager.js
//
// Eşleştirme kuyruğu + aktif oyunların yönetimi: hamle doğrulama (motor
// üzerinden), saatler, teslim olma, beraberlik teklifi, oyun bitişi ve
// Elo güncellemesi. Canlı oyun sırasında oyunculara motorun değerlendirmesi
// (eval/en iyi hamle) ASLA gösterilmiyor — motor sadece "bu hamle yasal mı"
// ve "bu hamleden sonraki pozisyon ne" sorularını cevaplamak için kullanılıyor.

const crypto = require('crypto');
const { isInsufficientMaterial } = require('./rules');
const { computeNewRatings } = require('./elo');
const { moveToSan } = require('./notation');

const START_FEN = 'rbqknr/pppppp/6/6/PPPPPP/RBQKNR w Qq - 0 1';

// Her süre kontrolü bir KATEGORİYE ait (lichess/chess.com'daki gibi:
// Bullet/Blitz/Rapid/Klasik) — Elo puanı da ARTIK TEK bir sayı değil, bu
// kategoriye göre AYRI tutuluyor (bkz. store.js'deki RATING_CATEGORIES /
// user.ratings). Kategori adı, kullanıcının kolayca ayırt edebilmesi için
// etikette de gösteriliyor.
const CATEGORY_LABELS = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Klasik' };

const TIME_CONTROLS = {
  '1+0': { initialMs: 1 * 60 * 1000, incrementMs: 0, label: '1 dk (Bullet)', category: 'bullet' },
  '1+1': { initialMs: 1 * 60 * 1000, incrementMs: 1000, label: '1 dk | +1 sn (Bullet)', category: 'bullet' },
  '3+0': { initialMs: 3 * 60 * 1000, incrementMs: 0, label: '3 dk (Blitz)', category: 'blitz' },
  '3+2': { initialMs: 3 * 60 * 1000, incrementMs: 2000, label: '3 dk | +2 sn (Blitz)', category: 'blitz' },
  '5+3': { initialMs: 5 * 60 * 1000, incrementMs: 3000, label: '5 dk | +3 sn (Blitz)', category: 'blitz' },
  '5+5': { initialMs: 5 * 60 * 1000, incrementMs: 5000, label: '5 dk | +5 sn (Rapid)', category: 'rapid' },
  // NOT: "(Geliştiricinin Tavsiyesi)" etiketi kullanıcının özel isteğiyle
  // eklendi -- sadece görünen metne (label) ekleniyor, süre kontrolünün
  // kendi mantığını (initialMs/incrementMs/category) hiçbir şekilde
  // etkilemiyor.
  '5+8': { initialMs: 5 * 60 * 1000, incrementMs: 8000, label: '5 dk | +8 sn (Rapid) (Geliştiricinin Tavsiyesi)', category: 'rapid' },
  '10+0': { initialMs: 10 * 60 * 1000, incrementMs: 0, label: '10 dk (Rapid)', category: 'rapid' },
  '10+15': { initialMs: 10 * 60 * 1000, incrementMs: 15000, label: '10 dk | +15 sn (Rapid)', category: 'rapid' },
  '30+0': { initialMs: 30 * 60 * 1000, incrementMs: 0, label: '30 dk (Klasik)', category: 'classical' },
  '30+30': { initialMs: 30 * 60 * 1000, incrementMs: 30000, label: '30 dk | +30 sn (Klasik)', category: 'classical' },
};

// Eşleştirme kuyruğu artık Elo bakımından ADİL: bir oyuncu kuyruğa girince
// önce TAM KENDİ Elo'sundaki (fark = 0) rakipleri arıyor; 1 saniye içinde
// bulamazsa arama aralığı ±100'e, sonra ±200'e, sonra ±300'e genişliyor —
// her aşamanın kendi bekleme süresi var. ±300'e ulaşınca da eşleşme
// bulunamazsa döngü BAŞA SARIYOR (yine fark=0'dan) — yani aralık hiçbir
// zaman ±300'ü AŞMIYOR, sadece bu dört aşama sürekli tekrarlanıyor.
// Bir çiftin eşleşebilmesi için fark, İKİ oyuncunun da O ANKİ aşamasına
// (ikisinin en DAR olanına) uymalı — böylece kimse kendi bekleme süresi
// dolmadan geniş bir Elo farkına zorlanmıyor.
const MATCHMAKING_BANDS = [
  { maxDiff: 0, waitMs: 1000 },
  { maxDiff: 100, waitMs: 3000 },
  { maxDiff: 200, waitMs: 5000 },
  { maxDiff: 300, waitMs: 8000 },
];
const MATCHMAKING_CYCLE_MS = MATCHMAKING_BANDS.reduce((sum, b) => sum + b.waitMs, 0); // 17000

// İLK HAMLE SÜRESİ (kullanıcı isteği): bir oyun kurulduğunda BEYAZ, süre
// kontrolü KATEGORİSİNE göre değişen bir süre içinde İLK hamlesini yapmazsa
// oyun otomatik İPTAL olur (mağlubiyet/berabere değil -- oyun hiç
// oynanmamış gibi sayılır). Beyaz ilk hamlesini yaparsa, aynı süre bu kez
// SİYAH için işlemeye başlar -- siyah da kendi ilk hamlesini bu süre
// içinde yapmazsa oyun yine İPTAL olur. İKİ TARAF DA ilk hamlesini
// yaptıktan sonra oyun ARTIK ASLA bu şekilde iptal olamaz (bkz.
// _createGame/applyMove/_handleFirstMoveTimeout/_cancelGame/cancelGame).
const FIRST_MOVE_DEADLINE_MS = {
  bullet: 13 * 1000,
  blitz: 18 * 1000,
  rapid: 30 * 1000,
  classical: 43 * 1000,
};

// HIZLI EŞLEŞTİRME İPTAL SUİSTİMALİ (kullanıcı isteği): bir kullanıcı, SADECE
// hızlı eşleştirmeden (kuyruğa girip rastgele biriyle eşleşerek) kurulan
// oyunlarda -- doğrudan meydan okuma ya da yeni oyun (revanş) teklifiyle
// kurulan oyunlar SAYILMIYOR -- 90 dakika içinde (art arda olması ŞART
// DEĞİL) 3 kez "Oyunu İptal Et" butonuna basarsa, SON iptal ettiği oyunun
// ANINDAN itibaren 24 saat boyunca hızlı eşleştirmeyi (kuyruğa girmeyi)
// kullanamaz -- bu SADECE hızlı eşleştirmeyi etkiler, doğrudan meydan okuma
// hâlâ serbesttir. 90 dakikalık pencere içindeki 2. iptalde kullanıcı yazılı
// bir metinle uyarılır (bkz. _recordQuickMatchCancel).
const QUICK_MATCH_CANCEL_WINDOW_MS = 90 * 60 * 1000;
const QUICK_MATCH_CANCEL_BLOCK_MS = 24 * 60 * 60 * 1000;
const QUICK_MATCH_CANCEL_WARN_AT = 2;
const QUICK_MATCH_CANCEL_LIMIT = 3;

// BERABERLİK TEKLİFİ SINIRLARI (kullanıcı isteği): AYNI oyun içinde (hem
// hızlı eşleştirme hem doğrudan meydan okuma -- TÜM oyunlar için geçerli),
// bir kullanıcı en fazla MAX_DRAW_OFFERS_PER_GAME kez beraberlik teklif
// edebilir. Ayrıca her DRAW_OFFER_PERIOD_PLIES (6) YARI HAMLELİK (3 tam
// hamlelik) periyotta en fazla 1 kez teklif edebilir -- bu periyot sayacı
// HER KULLANICI İÇİN AYRI VE BAĞIMSIZDIR (bkz. offerDraw): bir taraf kendi
// periyodunu "kullanınca" bu, diğer tarafı HİÇ etkilemez.
const MAX_DRAW_OFFERS_PER_GAME = 5;
const DRAW_OFFER_PERIOD_PLIES = 6;

// SOHBET / SEYİRCİ ÖZELLİĞİ (kullanıcı isteği) ---------------------------
// Canlı bir oyun sırasında OYUNCU sohbeti ve SEYİRCİ sohbeti tamamen ayrı
// tutulur: seyirciler oyuncu sohbetini OKUYABİLİR ama YAZAMAZ; oyuncular
// seyirci sohbetini NE OKUYABİLİR NE DE YAZABİLİR. Oyun bitince ikisi TEK
// bir (kronolojik sıraya göre birleştirilmiş) sohbette toplanır (bkz.
// _finalizeGame) ve artık HERKES (eski oyuncular + tüm seyirciler, hatta
// daha sonra analiz tahtasını açan herkes) hem okuyabilir hem yazabilir.
//
// Art arda mesaj sınırı: bir oyuncu, RAKİBİ cevap verene kadar OYUNCU
// sohbetinde üst üste en fazla 2 mesaj atabilir; bir seyirci de, ARADA
// BAŞKA BİRİ (herhangi bir seyirci) mesaj atmadığı sürece SEYİRCİ
// sohbetinde üst üste en fazla 2 mesaj atabilir (kullanıcı isteği: seyirci
// sınırı da oyuncuyla aynı, üst üste 2). Bu, mesaj dizisinin SONUNDAN
// geriye doğru "aynı gönderen" sayılarak hesaplanıyor -- ayrı bir sayaç
// tutmaya gerek yok (bkz. _trailingStreak).
const MAX_CONSECUTIVE_PLAYER_CHAT_MSGS = 2;
const MAX_CONSECUTIVE_SPECTATOR_CHAT_MSGS = 2;
const CHAT_MESSAGE_MAX_LENGTH = 500;

// waitMs kadar süredir kuyrukta bekleyen bir oyuncunun O AN kabul ettiği
// azami Elo farkını döndürür (bkz. MATCHMAKING_BANDS açıklaması).
function currentAllowedEloDiff(waitMs) {
  let t = waitMs % MATCHMAKING_CYCLE_MS;
  for (const band of MATCHMAKING_BANDS) {
    if (t < band.waitMs) return band.maxDiff;
    t -= band.waitMs;
  }
  return MATCHMAKING_BANDS[MATCHMAKING_BANDS.length - 1].maxDiff; // güvenlik ağı
}

// ÜÇ KEZ TEKRAR (threefold repetition) kuralı için: iki pozisyonun "AYNI"
// sayılabilmesi sadece taş dizilimine değil, sırası gelen tarafa, ROK
// HAKLARINA ve EN PASSANT (geçerken alma) olasılığına da bağlıdır — FIDE
// kuralı budur. FEN'in ilk 4 alanı tam olarak bunları içerir:
//   [taş dizilimi] [sırası gelen taraf] [rok hakları] [en passant karesi]
// Son 2 alan (yarı hamle sayacı, tam hamle numarası) pozisyonun "aynı"lığını
// ETKİLEMEZ, bu yüzden onları BİLEREK dışarıda bırakıyoruz. Böylece, tahtada
// görsel olarak birebir aynı görünen ama rok hakkı kaybedilmiş ya da bir
// önceki hamlede var olan en passant hakkı artık geçerli olmayan bir
// pozisyon, YANLIŞLIKLA "aynı" sayılmaz.
function positionRepetitionKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

class GameManager {
  constructor(engine, store, hub) {
    this.engine = engine;
    this.store = store;
    this.hub = hub;
    this.queues = {}; // timeControlKey -> [{ userId, joinedAt }, ...]
    for (const key of Object.keys(TIME_CONTROLS)) this.queues[key] = [];
    this.games = new Map(); // gameId -> live game state
    this.userActiveGame = new Map(); // userId -> gameId (en fazla bir aktif oyun)

    // Doğrudan meydan okuma (belirli bir oyuncuya, kuyruk dışı davet).
    // challenges: challengeId -> { id, challengerId, targetId, timeControlKey,
    //   colorChoice ('white'|'black'|'random' — ÇAĞIRAN kişinin seçtiği renk),
    //   ranked (true/false — puanlı/puansız oyun) }.
    // Süresi YOK: kullanıcı isteği gereği bir davet, ÇAĞIRAN iptal edene ya
    // da HEDEF reddedene kadar bekler (otomatik zaman aşımı kaldırıldı).
    // outgoingChallengeByUser: bir kullanıcının aynı anda sadece TEK bir
    // bekleyen (gönderdiği) meydan okuması olabilir — karışıklığı önlemek
    // için (bkz. createChallenge: yenisi eskisinin yerini alır).
    this.challenges = new Map();
    this.outgoingChallengeByUser = new Map(); // userId -> challengeId

    // Hızlı eşleştirmede bir kullanıcının ÜST ÜSTE 3. kez AYNI renkle
    // oynamasını engellemek için (kullanıcı isteği): her kullanıcının hızlı
    // eşleştirmeden en son aldığı rengi VE bu rengin kaç kez ÜST ÜSTE
    // (ara vermeden) tekrarlandığını tutuyoruz. SADECE hızlı eşleştirme
    // için tutuluyor -- doğrudan meydan okumada kullanıcı zaten kendi rengini
    // seçebiliyor, yeni oyun (revanş) teklifinde de renkler zaten her
    // seferinde otomatik olarak tersine çevriliyor (bkz. _startGame).
    this.quickMatchColorStreak = new Map(); // userId -> { color, count }

    // Hızlı eşleştirme iptal suistimali (kullanıcı isteği, bkz.
    // QUICK_MATCH_CANCEL_* sabitleri): quickMatchCancelHistory, bir
    // kullanıcının SADECE hızlı eşleştirmeden kurulan oyunlarda "İptal Et"
    // butonuna bastığı zaman damgalarını tutar (90 dakikadan eskiler
    // sürekli budanır). quickMatchCancelBlockUntil, bu pencerede 3. iptale
    // ulaşınca o kullanıcının hızlı eşleştirmeyi tekrar kullanabileceği anı
    // (epoch ms) tutar. İkisi de kasıtlı olarak SADECE bellekte tutuluyor --
    // sunucu yeniden başlarsa sıfırlanır, bu küçük ölçekli bir proje için
    // kabul edilebilir bir basitleştirme.
    this.quickMatchCancelHistory = new Map(); // userId -> [epoch ms, ...]
    this.quickMatchCancelBlockUntil = new Map(); // userId -> epoch ms

    // SOHBET / SEYİRCİ ÖZELLİĞİ (kullanıcı isteği) -- bkz. yukarıdaki
    // MAX_CONSECUTIVE_*_CHAT_MSGS açıklaması.
    //
    // viewersByGame: gameId -> Set(userId) -- o anda o oyunun sayfasını
    // (canlı oyun EKRANI ya da bitmiş oyunun analiz tahtası) açık tutan
    // TÜM kullanıcılar (oyuncular DAHİL -- oyuncular da kendi oyunlarını
    // "izliyor" sayılır, bu sadece gerçek zamanlı sohbet yayınının kime
    // gideceğini belirleyen bir liste). watchGame/unwatchGame ile
    // güncellenir (bkz. server.js: POST /api/game/:id/watch|unwatch --
    // hem game.js hem analysis.js sayfa açılışında/kapanışında çağırır).
    // SADECE bellekte tutuluyor -- sunucu yeniden başlarsa (diğer canlı
    // durum gibi) sıfırlanır, kullanıcı sayfayı yenileyince zaten yeniden
    // "watch" çağrısı yapılır.
    this.viewersByGame = new Map();

    // Doğrudan meydan okumada (createChallenge/respondChallenge) art arda
    // 2 kez reddedilen teklifler artık (kullanıcı isteği) SADECE 24 saatlik
    // bir soğuma DEĞİL, göndereni hedefi TAMAMEN ENGELLEMİŞ sayan otomatik
    // bir işlem tetikler (bkz. respondChallenge). Bu sayaç bunun için --
    // anahtar "challengerId>targetId" (YÖNLÜ bir çift) -- kabul edilince ya da hedef rol değiştirip
    // KENDİSİ teklif gönderince sıfırlanmaz (kasıtlı: bu sadece "aynı kişi
    // aynı kişiye art arda 2 kez reddedildi mi" sorusuna bakıyor); sadece
    // bir KABUL gerçekleşirse sıfırlanır (barıştılar sayılır).
    this.challengeDeclineStreak = new Map();

    // Saat bayrağı düşüşlerini kontrol etmek için periyodik tarama.
    this._sweepInterval = setInterval(() => this._sweepClocks(), 1000);
    // Elo bantları zamanla genişlediği için (bkz. MATCHMAKING_BANDS), kimse
    // yeni katılmasa bile bekleyen oyuncuların aralığı büyüdükçe önceden
    // eşleşmesi mümkün olmayan bir çift sonradan uygun hâle gelebilir —
    // bunu yakalamak için kuyrukları sık sık (300ms'de bir) tarıyoruz.
    this._matchmakingInterval = setInterval(() => this._sweepMatchmaking(), 300);
  }

  timeControls() {
    return Object.entries(TIME_CONTROLS).map(([key, v]) => ({ key, label: v.label, category: v.category }));
  }

  // ============================================================
  // EŞLEŞTİRME
  // ============================================================

  joinQueue(userId, timeControlKey) {
    if (!TIME_CONTROLS[timeControlKey]) throw new Error('Geçersiz süre kontrolü.');
    if (this.userActiveGame.has(userId)) throw new Error('Zaten devam eden bir oyunun var.');

    // Hızlı eşleştirme iptal suistimali cezası (bkz. QUICK_MATCH_CANCEL_*
    // sabitleri / _recordQuickMatchCancel): ceza süresi dolmadan kuyruğa
    // giremez -- bu SADECE hızlı eşleştirmeyi etkiler, doğrudan meydan okuma
    // (createChallenge) bundan hiç etkilenmez.
    const cancelBlockUntil = this.quickMatchCancelBlockUntil.get(userId) || 0;
    if (cancelBlockUntil > Date.now()) {
      const err = new Error('Art arda çok fazla hızlı eşleştirme oyunu iptal ettiğin için hızlı eşleştirmeyi geçici olarak kullanamıyorsun.');
      err.code = 'QUICK_MATCH_CANCEL_BLOCKED';
      err.retryAfterMs = cancelBlockUntil - Date.now();
      throw err;
    }

    // Aynı kullanıcı iki kez kuyruğa girmesin.
    for (const q of Object.values(this.queues)) {
      const idx = q.findIndex(e => e.userId === userId);
      if (idx !== -1) q.splice(idx, 1);
    }

    this.queues[timeControlKey].push({ userId, joinedAt: Date.now() });
    this.hub.sendTo(userId, 'queued', { timeControlKey });

    // Kuyrukta zaten tam kendi Elo'sunda bekleyen biri varsa 1 saniye bile
    // beklemeden hemen eşleşsin diye anında bir deneme de yapıyoruz —
    // periyodik tarama (300ms) zaten bunu yakalar ama bu, en iyi ihtimalde
    // (aynı Elo) gecikmeyi sıfıra indiriyor.
    this._tryMatchQueue(timeControlKey);
  }

  leaveQueue(userId) {
    for (const q of Object.values(this.queues)) {
      const idx = q.findIndex(e => e.userId === userId);
      if (idx !== -1) q.splice(idx, 1);
    }
  }

  // Tüm kuyrukları tarayıp, bekleme süresi arttıkça Elo bantları genişleyen
  // (bkz. MATCHMAKING_BANDS) oyuncular arasında uygun bir çift oluşup
  // oluşmadığına bakar. Yeni biri katılmasa bile çağrılması gerekir, çünkü
  // sadece zamanın geçmesiyle (kimsenin bandı genişlemesiyle) önceden
  // geçersiz olan bir çift sonradan geçerli hâle gelebilir.
  _sweepMatchmaking() {
    for (const key of Object.keys(this.queues)) {
      this._tryMatchQueue(key);
    }
  }

  // Belirli bir süre kontrolü kuyruğunda bulunabilecek TÜM geçerli
  // eşleşmeleri (Elo bakımından adil, bkz. yukarısı) art arda kurar.
  _tryMatchQueue(timeControlKey) {
    const queue = this.queues[timeControlKey];
    if (!queue || queue.length < 2) return;
    const category = TIME_CONTROLS[timeControlKey].category;
    const now = Date.now();

    let matchedAny = true;
    while (matchedAny && queue.length >= 2) {
      matchedAny = false;

      // Her bekleyen oyuncunun ELOsunu (bu kategoriye ait) ve O ANKİ izin
      // verilen azami Elo farkını (kendi bekleme süresine göre) hesapla.
      const infos = queue.map(entry => {
        const user = this.store.getUserById(entry.userId);
        const elo = user?.ratings?.[category] ?? 1500;
        const allowedDiff = currentAllowedEloDiff(now - entry.joinedAt);
        return { entry, elo, allowedDiff };
      });

      // Geçerli (her iki tarafın da o anki bandına uyan) çiftler arasından
      // Elo farkı EN KÜÇÜK olanı seç — "önce kendi Elo'ndaki rakibi
      // önceliklendir" kuralının doğal sonucu.
      let best = null; // { i, j, diff }
      for (let i = 0; i < infos.length; i++) {
        for (let j = i + 1; j < infos.length; j++) {
          // Kullanıcı engelleme (kullanıcı isteği): iki taraftan biri
          // diğerini engellemişse (hangi yönde olursa olsun) hızlı
          // eşleştirme bu ikisini ASLA eşleştirmesin -- engelleyen kişi
          // dilerse doğrudan meydan okuyabilir (bkz. createChallenge), ama
          // hızlı eşleştirmede kesinlikle karşılaşmazlar.
          if (this.isBlockedBetween(infos[i].entry.userId, infos[j].entry.userId)) continue;
          const diff = Math.abs(infos[i].elo - infos[j].elo);
          const allowed = Math.min(infos[i].allowedDiff, infos[j].allowedDiff);
          if (diff <= allowed && (!best || diff < best.diff)) {
            best = { i, j, diff };
          }
        }
      }

      if (best) {
        const a = infos[best.i].entry;
        const b = infos[best.j].entry;
        const removeIds = new Set([a.userId, b.userId]);
        for (let k = queue.length - 1; k >= 0; k--) {
          if (removeIds.has(queue[k].userId)) queue.splice(k, 1);
        }
        this._startGame(a.userId, b.userId, timeControlKey);
        matchedAny = true;
      }
    }
  }

  // ============================================================
  // NOT (Segment E güncellemesi): İKİ OYUNCU ARASINDAKİ art arda 2 kez
  // reddedilen teklif üzerine uygulanan eski, GENEL "24 saatlik soğuma +
  // hızlı eşleşme engeli" mekanizması (canOffer/canMatch/pairRelations)
  // kaldırıldı -- yerine kullanıcının bu segmentteki isteğiyle İKİ AYRI VE
  // DAHA ÖZEL kural geldi:
  //   - Yeni oyun (revanş) teklifinde: art arda 2 ret, SADECE o bitmiş oyuna
  //     özel kalıcı bir kısıtlama getirir (bkz. offerRematch/respondRematch/
  //     rematchBlockedFor) -- başka bir oyunda bu iki kullanıcı yine
  //     teklif alışverişi yapabilir.
  //   - Doğrudan meydan okumada: art arda 2 ret, göndereni hedefi TAMAMEN
  //     ENGELLEMİŞ sayar (bkz. respondChallenge/challengeDeclineStreak) --
  //     mevcut komple engelleme (blockUser) ile AYNI (kalıcı) mekanizma,
  //     bu da zaten hem hızlı eşleşmeyi (isBlockedBetween) hem teklif
  //     göndermeyi kalıcı olarak engelliyor.
  // Eski mekanizmayı AYRICA çalıştırmaya devam etmek, "engelleyen kullanıcı
  // dilerse engellediğine yine de meydan okuyabilir" kuralını (24 saatlik
  // soğuma HER İKİ yönü de etkilediği için) bozardı -- bu yüzden tamamen
  // kaldırıldı, ikame edilmedi.
  // ============================================================

  // Normal eşleştirme (lobiden kuyruğa girip rastgele biriyle karşılaşma):
  // renkler rastgele dağıtılıyor, ANCAK kullanıcı isteği gereği bir oyuncu
  // hızlı eşleştirmede ASLA (mümkünse) aynı renkle üst üste 3. kez
  // oynamasın diye önce bu iki oyuncudan HERHANGİ BİRİNİN "yasaklı" bir
  // rengi (yani hızlı eşleştirmede zaten üst üste 2 kez aldığı renk) olup
  // olmadığına bakılıyor (bkz. quickMatchColorStreak).
  _startGame(userA, userB, timeControlKey) {
    const streakA = this.quickMatchColorStreak.get(userA);
    const streakB = this.quickMatchColorStreak.get(userB);
    const forbiddenA = (streakA && streakA.count >= 2) ? streakA.color : null;
    const forbiddenB = (streakB && streakB.count >= 2) ? streakB.color : null;

    // İki olası atama var: (A=beyaz, B=siyah) ya da (A=siyah, B=beyaz).
    // Her biri, bir oyuncuyu KENDİ yasaklı (3. üst üste aynı) rengine
    // sokmuyorsa geçerlidir.
    const aWhiteValid = forbiddenA !== 'white' && forbiddenB !== 'black';
    const aBlackValid = forbiddenA !== 'black' && forbiddenB !== 'white';

    let whiteId;
    if (aWhiteValid && aBlackValid) {
      // İkisi de geçerli (normal durum) -- eskisi gibi rastgele seç.
      whiteId = Math.random() < 0.5 ? userA : userB;
    } else if (aWhiteValid) {
      whiteId = userA;
    } else if (aBlackValid) {
      whiteId = userB;
    } else {
      // Son derece nadir bir çakışma: İKİ oyuncu da hızlı eşleştirmede
      // AYNI rengi üst üste 2 kez almış ve şimdi birbirleriyle eşleşiyor --
      // matematiksel olarak İKİSİNİ BİRDEN tam olarak korumak imkansız
      // (biri kesinlikle o rengi 3. kez alacak). Bu durumda eskisi gibi
      // rastgele seçime geri dönülüyor.
      whiteId = Math.random() < 0.5 ? userA : userB;
    }
    const blackId = whiteId === userA ? userB : userA;

    this._recordQuickMatchColor(userA, whiteId === userA ? 'white' : 'black');
    this._recordQuickMatchColor(userB, whiteId === userB ? 'white' : 'black');

    // matchOrigin: 'queue' -- bu oyun hızlı eşleştirmeden kuruldu (kullanıcı
    // isteği: hızlı eşleştirme iptal suistimali cezası SADECE bu kökenden
    // gelen oyunları sayar, bkz. cancelGame/_recordQuickMatchCancel).
    this._createGame(whiteId, blackId, timeControlKey, true, 'queue');
  }

  _recordQuickMatchColor(userId, color) {
    const s = this.quickMatchColorStreak.get(userId);
    if (s && s.color === color) s.count += 1;
    else this.quickMatchColorStreak.set(userId, { color, count: 1 });
  }

  // Renkleri ve süre kontrolünü doğrudan belirterek yeni bir oyun kurar.
  // Revanş (yeni oyun teklifi) akışı, önceki oyundaki renkleri BİLEREK
  // TERSİNE ÇEVİRMEK için bunu doğrudan çağırıyor — böylece art arda
  // revanşlarda renkler her seferinde el değiştiriyor (1. oyunda beyaz olan
  // 2. oyunda siyah, 3. oyunda tekrar beyaz olur), rastgele değil.
  //
  // ranked=false: doğrudan meydan okumada kullanıcının seçebildiği
  // "puansız" (dostluk) oyun — bu oyunun sonucu Elo puanını (ve galibiyet/
  // mağlubiyet/beraberlik sayacını) HİÇ etkilemez (bkz. _finalizeGame).
  //
  // matchOrigin: 'queue' | 'challenge' | 'rematch' -- bu oyunun NASIL
  // kurulduğu (kullanıcı isteği: hızlı eşleştirme iptal suistimali cezası
  // SADECE 'queue' kökenli oyunları sayar, bkz. cancelGame). Varsayılan
  // 'challenge' -- doğrudan meydan okuma çağrı yeri zaten en sık kullanılan.
  _createGame(whiteId, blackId, timeControlKey, ranked = true, matchOrigin = 'challenge') {
    const id = crypto.randomUUID();
    const tc = TIME_CONTROLS[timeControlKey];

    const game = {
      id,
      whiteId,
      blackId,
      timeControlKey,
      timeControlCategory: tc.category,
      ranked,
      matchOrigin,
      startFen: START_FEN,
      movesUci: [],
      sanMoves: [], // movesUci ile paralel: her hamlenin okunabilir (SAN) hâli
      currentFen: START_FEN,
      whiteToMove: true,
      // Sırası gelen tarafın şahı tehdit altında mı? (tahtada o karenin
      // kırmızı gösterilmesi için — bkz. publicState() ve _checkGameEnd()).
      // Başlangıç pozisyonunda şah çekilmesi mümkün olmadığı için false.
      inCheck: false,
      whiteClockMs: tc.initialMs,
      blackClockMs: tc.initialMs,
      // Analiz tahtasında "o hamlede saatler ne kadardı" gösterebilmek için
      // her GERÇEK hamleden sonraki saat durumunu burada biriktiriyoruz.
      // clockHistory[k] = appliedMoves.length === k iken (yani k hamle
      // oynanmışken) geçerli olan saatler — clockHistory[0] başlangıç
      // (henüz hiç hamle yokken) saatleridir, bu yüzden uzunluğu her zaman
      // movesUci.length + 1'dir.
      clockHistory: [{ whiteClockMs: tc.initialMs, blackClockMs: tc.initialMs }],
      // Üç kez tekrar kuralı için: her pozisyonun (bkz. positionRepetitionKey)
      // şimdiye kadar kaç kez oluştuğunu sayıyoruz. Başlangıç pozisyonu da
      // (henüz hiç hamle oynanmamışken) BİR KEZ oluşmuş sayılır — aksi halde
      // oyun başlangıç pozisyonuna geri dönülen bir tekrar dizisinde üçüncü
      // tekrar yanlışlıkla ikinci sayılırdı.
      positionCounts: { [positionRepetitionKey(START_FEN)]: 1 },
      turnStartedAt: Date.now(),
      drawOfferBy: null,
      // BERABERLİK TEKLİFİ SINIRLARI (kullanıcı isteği, bkz.
      // MAX_DRAW_OFFERS_PER_GAME / DRAW_OFFER_PERIOD_PLIES / offerDraw):
      // drawOfferCount[renk], o rengin bu oyunda ŞİMDİYE KADAR kaç kez
      // beraberlik teklif ettiğini sayar (azami 5). lastDrawOfferPeriod[renk],
      // o rengin EN SON hangi "periyotta" (movesUci.length / 6'nın tam kısmı)
      // teklif ettiğini tutar -- aynı periyotta ikinci bir teklif engellenir.
      // Bu İKİ sayaç da renkler arasında TAMAMEN BAĞIMSIZDIR.
      drawOfferCount: { white: 0, black: 0 },
      lastDrawOfferPeriod: { white: null, black: null },
      rematchOfferBy: null,
      // SOHBET (kullanıcı isteği): canlı oyun sırasında oyuncu ve seyirci
      // sohbetleri TAMAMEN AYRI dizilerde tutulur (bkz. sendChat/getChat).
      // Oyun bitince ikisi TEK bir kronolojik sohbette birleştirilip kalıcı
      // depoya (store) yazılır (bkz. _finalizeGame) -- bu iki dizi o
      // andan sonra bir daha KULLANILMAZ.
      playerChat: [],
      spectatorChat: [],
      // YENİ OYUN (REVANŞ) TEKLİFİ RET SAYACI -- kullanıcı isteği: bu
      // SPESİFİK bitmiş oyun için art arda 2 kez reddedilen revanş
      // teklifinden sonra, SADECE bu oyun özelinde bir daha teklif
      // gönderilemez (bir başka oyunda bu kısıtlama HİÇ geçerli değildir --
      // bkz. offerRematch/respondRematch). rematchDeclineStreak[renk],
      // O RENGİN gönderdiği tekliflerin art arda kaç kez reddedildiğini
      // sayar; rematchBlockedFor[renk] true olunca artık o renk BİR DAHA
      // bu oyun için teklif gönderemez (kalıcı -- bu oyun bellekten silinene
      // kadar, zaten offerRematch'in kendisi de o zaman imkansız olur).
      rematchDeclineStreak: { white: 0, black: 0 },
      rematchBlockedFor: { white: false, black: false },
      status: 'active',
      resultReason: null,
      winnerColor: null,
      createdAt: new Date().toISOString(),
      // İLK HAMLE SÜRESİ (kullanıcı isteği, bkz. FIRST_MOVE_DEADLINE_MS):
      // whiteMoved/blackMoved, o rengin oyunda ŞİMDİYE KADAR EN AZ BİR
      // hamle yapıp yapmadığını tutar. firstMoveTimer, o an hangi renk
      // bekleniyorsa ONUN için kurulmuş, süresi dolunca oyunu otomatik
      // iptal edecek setTimeout referansıdır (bkz. _scheduleFirstMoveTimer/
      // _handleFirstMoveTimeout/_cancelGame). firstMoveDeadlineAt, İSTEMCİNİN
      // geri sayım gösterebilmesi için aynı zamanlayıcının dolacağı an
      // (epoch ms) -- her iki taraf da ilk hamlesini yapınca null olur ve
      // oyun bir daha ASLA bu şekilde iptal olamaz.
      whiteMoved: false,
      blackMoved: false,
      firstMoveTimer: null,
      firstMoveDeadlineAt: null,
    };

    this._scheduleFirstMoveTimer(game, 'white');

    this.games.set(id, game);
    this.userActiveGame.set(whiteId, id);
    this.userActiveGame.set(blackId, id);

    const whiteUser = this.store.getUserById(whiteId);
    const blackUser = this.store.getUserById(blackId);

    this.hub.sendTo(whiteId, 'match_found', {
      gameId: id, color: 'white', opponent: blackUser?.username, timeControl: tc,
    });
    this.hub.sendTo(blackId, 'match_found', {
      gameId: id, color: 'black', opponent: whiteUser?.username, timeControl: tc,
    });
  }

  // ============================================================
  // İLK HAMLE SÜRESİ / OYUN İPTALİ (kullanıcı isteği) — bkz.
  // FIRST_MOVE_DEADLINE_MS. Bir oyun kurulduğunda BEYAZ için, beyaz ilk
  // hamlesini yapınca da SİYAH için (sırayla, ASLA aynı anda ikisi için
  // birden) bir zamanlayıcı kurulur; süresi dolarsa oyun otomatik iptal
  // olur. İKİ TARAF DA ilk hamlesini yapmışsa (game.blackMoved === true)
  // oyun ARTIK HİÇBİR ŞEKİLDE (ne otomatik ne de elle) iptal edilemez.
  // ============================================================

  _scheduleFirstMoveTimer(game, color) {
    const category = TIME_CONTROLS[game.timeControlKey]?.category || 'bullet';
    const deadlineMs = FIRST_MOVE_DEADLINE_MS[category] || FIRST_MOVE_DEADLINE_MS.classical;
    game.firstMoveDeadlineAt = Date.now() + deadlineMs;
    game.firstMoveTimer = setTimeout(() => this._handleFirstMoveTimeout(game.id, color), deadlineMs);
  }

  _clearFirstMoveTimer(game) {
    if (game.firstMoveTimer) {
      clearTimeout(game.firstMoveTimer);
      game.firstMoveTimer = null;
    }
    game.firstMoveDeadlineAt = null;
  }

  _handleFirstMoveTimeout(gameId, color) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'active') return;
    // Güvenlik kontrolü (yarış durumu): hamle tam zamanaşımı anında geldiyse
    // ve zaten işlendiyse, bu zamanlayıcı artık geçersizdir.
    if (color === 'white' && game.whiteMoved) return;
    if (color === 'black' && game.blackMoved) return;
    this._cancelGame(game, color === 'white' ? 'white_no_first_move' : 'black_no_first_move');
  }

  // Manuel iptal (kullanıcı isteği): iki taraf da, KENDİSİ ya da RAKİBİ
  // ilk hamlesini yapana kadar (yani game.blackMoved false olduğu sürece)
  // oyunu istediği an iptal edebilir. Siyah ilk hamlesini yapar yapmaz
  // (game.blackMoved true olur olmaz) bu kapı SONSUZA KADAR kapanır.
  cancelGame(gameId, userId) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'active') throw new Error('Oyun bulunamadı ya da zaten bitmiş.');
    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');
    if (game.blackMoved) throw new Error('Bu oyun artık iptal edilemez (her iki taraf da ilk hamlesini yaptı).');
    const wasQuickMatch = game.matchOrigin === 'queue';
    this._cancelGame(game, 'cancelled_by_player');
    // Hızlı eşleştirme iptal suistimali (kullanıcı isteği): SADECE hızlı
    // eşleştirmeden kurulan oyunlar sayılır -- doğrudan meydan okuma ya da
    // revanş ile kurulan bir oyunu iptal etmenin bu cezayla hiçbir ilgisi
    // yok. Bu iptali YAPAN kullanıcı (userId) için sayılıyor, rakibi için
    // değil. ÖNEMLİ: uyarı/engel bilgisini SSE'ye (fire-and-forget, kullanıcı
    // tam bu anda sayfadan sayfaya geçiş yaptığı için kaybolma riski var)
    // GÜVENMEK YERİNE doğrudan bu API yanıtının içinde döndürüyoruz --
    // istemci (game.js) sayfadan ayrılmadan ÖNCE bunu güvenilir şekilde
    // gösterebilsin diye (bkz. server.js: POST /api/game/:id/cancel).
    const quickMatchCancelNotice = wasQuickMatch ? this._recordQuickMatchCancel(userId) : null;
    return { ok: true, quickMatchCancelNotice };
  }

  // Bkz. QUICK_MATCH_CANCEL_* sabitleri: 90 dakikalık kayan pencerede
  // (art arda olması ŞART DEĞİL) 2. iptalde yazılı bir uyarı, 3. iptalde
  // SON iptalin ANINDAN itibaren 24 saatliğine hızlı eşleştirme engeli
  // uygular. Ceza tetiklenince sayaç sıfırlanır -- ceza süresi dolduktan
  // sonra kullanıcı temiz bir sayaçla yeniden başlar.
  //
  // Dönüş değeri ({type, blockUntil?} ya da null) BİLEREK SSE İLE DEĞİL,
  // doğrudan cancelGame()'in API yanıtının içinde döndürülüyor: kullanıcı
  // tam bu anda "İptal Et" butonuna bastıktan hemen sonra lobiye
  // yönlendiriliyor, bu kısa pencerede bir SSE olayının (fire-and-forget,
  // bkz. lib/events.js) zamanında yetişip yetişmeyeceği GARANTİ DEĞİL --
  // istemci (game.js) bu bilgiyi kaçırma riski olmayan API yanıtından okuyup
  // sayfadan ayrılmadan HEMEN ÖNCE gösteriyor.
  _recordQuickMatchCancel(userId) {
    const now = Date.now();
    let history = (this.quickMatchCancelHistory.get(userId) || [])
      .filter(ts => now - ts <= QUICK_MATCH_CANCEL_WINDOW_MS);
    history.push(now);
    this.quickMatchCancelHistory.set(userId, history);

    if (history.length >= QUICK_MATCH_CANCEL_LIMIT) {
      const blockUntil = now + QUICK_MATCH_CANCEL_BLOCK_MS;
      this.quickMatchCancelBlockUntil.set(userId, blockUntil);
      this.quickMatchCancelHistory.set(userId, []);
      return { type: 'blocked', blockUntil };
    }

    if (history.length === QUICK_MATCH_CANCEL_WARN_AT) {
      return { type: 'warning', count: history.length, limit: QUICK_MATCH_CANCEL_LIMIT };
    }

    return null;
  }

  // Ortak iptal mantığı: hem otomatik (süre dolunca) hem elle (bir oyuncu
  // "İptal Et" butonuna basınca) iptaller buradan geçer. ÖNEMLİ: iptal
  // edilen bir oyun HİÇBİR ŞEKİLDE kalıcı depoya (store) kaydedilmiyor --
  // Elo'yu, galibiyet/mağlubiyet sayacını ya da "Son Oyunların" listesini
  // HİÇ etkilemiyor; sanki hiç oynanmamış gibi tamamen siliniyor.
  _cancelGame(game, reason) {
    game.status = 'cancelled';
    game.resultReason = reason;
    game.winnerColor = null;
    this._clearFirstMoveTimer(game);

    this.userActiveGame.delete(game.whiteId);
    this.userActiveGame.delete(game.blackId);

    const payload = { gameId: game.id, reason };
    this.hub.sendTo(game.whiteId, 'game_cancelled', payload);
    this.hub.sendTo(game.blackId, 'game_cancelled', payload);

    // İptal edilen bir oyunda hiçbir zaman kalıcı bir sohbet olmayacağı
    // için (bu oyun store'a hiç kaydedilmiyor), izleyici kaydını da hemen
    // temizleyebiliriz.
    this.viewersByGame.delete(game.id);

    // Bitmiş oyunlarla aynı kısa süreli bellek-tutma politikası (bkz.
    // _finalizeGame) -- istemci son olayı kaçırırsa /api/game/:id ile
    // hâlâ (kısa bir süre) "cancelled" durumunu okuyabilsin diye.
    setTimeout(() => this.games.delete(game.id), 5 * 60 * 1000);
  }

  // ============================================================
  // OYUN DURUMU
  // ============================================================

  getGame(id) {
    return this.games.get(id) || null;
  }

  // Kullanıcının şu an devam eden bir oyunu varsa kimliğini döndürür — sayfa
  // yeniden yüklendiğinde (ör. tarayıcı yenilendiğinde) istemcinin kaldığı
  // yerden devam edebilmesi için kullanılır.
  activeGameId(userId) {
    return this.userActiveGame.get(userId) || null;
  }

  colorOf(game, userId) {
    if (game.whiteId === userId) return 'white';
    if (game.blackId === userId) return 'black';
    return null;
  }

  // Dışa açık, istemcinin görmesi güvenli olan durum (motora ait hiçbir
  // eval/PV bilgisi içermez — sadece pozisyon ve saatler).
  publicState(game) {
    return {
      id: game.id,
      whiteId: game.whiteId,
      blackId: game.blackId,
      timeControlKey: game.timeControlKey,
      timeControlCategory: game.timeControlCategory,
      ranked: game.ranked !== false,
      startFen: game.startFen,
      movesUci: game.movesUci,
      sanMoves: game.sanMoves,
      currentFen: game.currentFen,
      whiteToMove: game.whiteToMove,
      whiteClockMs: game.whiteClockMs,
      blackClockMs: game.blackClockMs,
      turnStartedAt: game.turnStartedAt,
      drawOfferBy: game.drawOfferBy,
      rematchOfferBy: game.rematchOfferBy,
      status: game.status,
      resultReason: game.resultReason,
      winnerColor: game.winnerColor,
      // İstemcinin tehdit altındaki şahın karesini kırmızı gösterebilmesi
      // için: sırası gelen tarafın şahı çekiliyor mu?
      inCheck: game.inCheck,
      // İLK HAMLE SÜRESİ (bkz. FIRST_MOVE_DEADLINE_MS): istemcinin "İptal
      // Et" butonunu ve geri sayımı doğru gösterebilmesi, beraberlik
      // teklifi/teslim ol butonlarını doğru şekilde etkin/pasif
      // yapabilmesi için.
      whiteMoved: game.whiteMoved,
      blackMoved: game.blackMoved,
      firstMoveDeadlineAt: game.firstMoveDeadlineAt,
      // BERABERLİK TEKLİFİ SINIRLARI (bkz. MAX_DRAW_OFFERS_PER_GAME):
      // istemcinin isterse "kaç teklif hakkın kaldı" gibi bir bilgi
      // gösterebilmesi için.
      drawOfferCount: game.drawOfferCount || { white: 0, black: 0 },
    };
  }

  // ============================================================
  // HAMLE UYGULAMA
  // ============================================================

  // İstemcinin, sıra kendisindeyken tıklanabilir kareleri/terfi seçeneklerini
  // gösterebilmesi için mevcut pozisyondaki TÜM yasal hamleleri döndürür.
  // Bu, bir değerlendirme (eval) ya da "en iyi hamle" ÖNERİSİ DEĞİLDİR — sadece
  // hangi hamlelerin kurallara göre mümkün olduğu bilgisidir, tıpkı lichess/
  // chess.com'daki nokta işaretleri gibi standart bir kullanıcı arayüzü
  // özelliğidir; motorun oyun sırasında oyunculara asla göstermediği şey
  // pozisyon DEĞERLENDİRMESİ ya da motorun ÖNERDİĞİ hamledir.
  async legalMoves(gameId, userId) {
    const game = this.games.get(gameId);
    if (!game) throw new Error('Oyun bulunamadı.');
    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');
    if (game.status !== 'active') return [];
    return this.engine.getLegalMoves(game.currentFen);
  }

  async applyMove(gameId, userId, from, to, promotion) {
    const game = this.games.get(gameId);
    if (!game) throw new Error('Oyun bulunamadı.');
    if (game.status !== 'active') throw new Error('Oyun zaten bitmiş.');

    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');

    const isWhiteTurn = game.whiteToMove;
    if ((color === 'white') !== isWhiteTurn) throw new Error('Sıra sende değil.');

    // İLK HAMLE SÜRESİ (kullanıcı isteği): bir tarafın kendi İLK hamlesini
    // yapana kadar saati HİÇ İŞLEMEZ (bkz. FIRST_MOVE_DEADLINE_MS) -- bunun
    // yerine ayrı, kısa bir zamanlayıcı (setTimeout, bkz.
    // _scheduleFirstMoveTimer) süre dolunca oyunu otomatik iptal eder. Bu
    // yüzden bu tarafın İLK hamlesinde, o ana kadar "düşünürken" geçen süre
    // saatinden HİÇ düşülmüyor (elapsed=0) -- sadece (varsa) hamle artışı
    // ekleniyor.
    const isFirstMoveForColor = color === 'white' ? !game.whiteMoved : !game.blackMoved;

    // --- Saat: bu hamleyi düşünürken geçen süreyi düş (ilk hamle DEĞİLSE) ---
    const now = Date.now();
    const elapsed = isFirstMoveForColor ? 0 : (now - game.turnStartedAt);
    const tc = TIME_CONTROLS[game.timeControlKey];
    const clockField = color === 'white' ? 'whiteClockMs' : 'blackClockMs';
    const remaining = game[clockField] - elapsed;

    if (remaining <= 0) {
      game[clockField] = 0;
      this._finalizeOnTimeout(game, color);
      return this.publicState(game);
    }

    // --- Hamlenin yasallığını motora sor ---
    const legal = await this.engine.getLegalMoves(game.currentFen);
    const prefix = from + to;
    const matches = legal.filter(m => m.startsWith(prefix));

    if (matches.length === 0) throw new Error('Bu hamle yasal değil.');

    let chosenMove;
    if (matches.length === 1) {
      chosenMove = matches[0];
    } else {
      // Terfi — istemcinin hangi taşı seçtiğini belirtmesi gerekiyor.
      if (!promotion) {
        const err = new Error('PROMOTION_REQUIRED');
        err.code = 'PROMOTION_REQUIRED';
        err.options = matches.map(m => m.slice(-1));
        throw err;
      }
      chosenMove = matches.find(m => m.endsWith(promotion));
      if (!chosenMove) throw new Error('Geçersiz terfi seçimi.');
    }

    // Yukarıdaki motor çağrıları ASENKRON olduğu için (küçük bir ihtimalle)
    // bu bekleme sırasında oyun ayrı bir yoldan (ör. ilk hamle süresi
    // zamanlayıcısı, saat bayrağı taraması ya da rakibin teslim olması)
    // zaten sonlanmış/iptal edilmiş olabilir -- bu durumda bu hamleyi ARTIK
    // uygulamıyoruz.
    if (game.status !== 'active') throw new Error('Oyun zaten bitmiş.');

    // --- SAN gösterimi için hamleden ÖNCEKİ pozisyonu (ve o pozisyondaki tüm
    // yasal hamleleri, belirsizlik giderme için) kullanıyoruz — bu, motora
    // sorulan hamlenin yasallığını DEĞİL, sadece nasıl YAZILACAĞINI belirler. ---
    const fenBeforeMove = game.currentFen;
    const sanBody = moveToSan(fenBeforeMove, chosenMove, legal);

    // --- Hamleyi uygula ---
    game.movesUci.push(chosenMove);
    const newFen = await this.engine.getFenAfterMoves(game.startFen, game.movesUci);
    game.currentFen = newFen;
    game.whiteToMove = newFen.includes(' w ');

    // İLK HAMLE SÜRESİ: bu, bu tarafın gerçekten İLK hamlesiyse, artık o
    // taraf için bir daha ASLA bu şekilde bir kısıtlama söz konusu değil --
    // kendi zamanlayıcısını temizleyip (varsa) SIRADAKİ tarafın (henüz ilk
    // hamlesini yapmadıysa) kendi ilk-hamle zamanlayıcısını kuruyoruz.
    if (isFirstMoveForColor) {
      if (color === 'white') {
        game.whiteMoved = true;
        this._clearFirstMoveTimer(game);
        if (!game.blackMoved) this._scheduleFirstMoveTimer(game, 'black');
      } else {
        game.blackMoved = true;
        // Siyah da ilk hamlesini yaptı -- artık İKİ TARAF DA en az bir hamle
        // yapmış oldu, bu oyun bundan böyle bu şekilde ASLA iptal edilemez
        // (ne otomatik ne de elle) -- bkz. cancelGame.
        this._clearFirstMoveTimer(game);
      }
    }

    // --- Saat: hamleyi tamamlayan tarafa artış ekle, sırayı diğer tarafa geç ---
    game[clockField] = remaining + tc.incrementMs;
    game.turnStartedAt = now;
    game.drawOfferBy = null; // yeni bir hamle önceki beraberlik teklifini geçersiz kılar

    // Analiz tahtasının "o hamlede saatler ne kadardı" gösterimi için bu
    // hamleden sonraki saat durumunu da kaydediyoruz (bkz. _createGame()'deki
    // clockHistory açıklaması).
    game.clockHistory.push({ whiteClockMs: game.whiteClockMs, blackClockMs: game.blackClockMs });

    // Üç kez tekrar sayacını güncelle (bkz. positionRepetitionKey ve
    // _createGame()'deki positionCounts açıklaması).
    const repKey = positionRepetitionKey(newFen);
    game.positionCounts[repKey] = (game.positionCounts[repKey] || 0) + 1;

    // --- Oyun bitti mi? (mat / pat / yetersiz taş) — ayrıca SAN'a "+"/"#"
    // eklemek için hamle sonrası şah durumu da burada dönüyor. ---
    const endInfo = await this._checkGameEnd(game);

    // Mat/pat/yetersiz taş oyunu zaten bitirmediyse VE bu pozisyon (rok
    // hakları ve en passant durumu dahil AYNI şekilde) üçüncü kez oluştuysa,
    // oyun OTOMATİK olarak berabere biter (lichess'teki gibi — bir tarafın
    // "talep etmesi" gerekmez).
    if (game.status === 'active' && game.positionCounts[repKey] >= 3) {
      this._finalizeGame(game, 'threefold_repetition', null);
    }

    // 50 HAMLE KURALI: son 50 hamlede (= 100 yarı hamlede) hiç taş alımı ya
    // da piyon sürülmesi olmadıysa oyun OTOMATİK berabere biter. FEN'in 5.
    // alanı (yarı hamle sayacı) motor tarafından zaten TAM OLARAK bu kurala
    // göre tutuluyor: her taş alımında ya da piyon hamlesinde 0'a dönüyor,
    // aksi hâlde her yarı hamlede 1 artıyor — bu yüzden başka bir sayaç
    // tutmamıza gerek yok, motorun FEN'inden okumak yeterli ve güvenilir.
    //
    // ÖNEMLİ (kullanıcı isteği): FIDE'de bu, oyuncunun TALEP ETMESİ gereken
    // bir kural olup 75. hamlede hakem otomatik araya girer; burada ise
    // (masaüstü hakem olmadığı için) TAM 50 hamlede otomatik bitiriyoruz.
    // Ayrıca: bu hamlenin kendisi MAT ile sonuçlandıysa yukarıdaki
    // _checkGameEnd() zaten oyunu 'checkmate' ile bitirmiş olur (game.status
    // artık 'active' değildir), bu yüzden aşağıdaki kontrol devreye hiç
    // GİRMEZ — "son hamlede mat varsa mat geçerlidir" kuralı böylece doğal
    // olarak sağlanıyor.
    if (game.status === 'active') {
      const halfmoveClock = parseInt(newFen.split(' ')[4], 10) || 0;
      if (halfmoveClock >= 100) {
        this._finalizeGame(game, 'fifty_move_rule', null);
      }
    }

    const sanSuffix = endInfo.checkmate ? '#' : (endInfo.inCheck ? '+' : '');
    game.sanMoves.push(sanBody + sanSuffix);

    // --- Rakibin tarayıcısına gerçek zamanlı olarak yeni hamleyi bildir ---
    // (Hamleyi yapan taraf zaten bu fonksiyonun dönüş değeriyle güncel
    // durumu alıyor; SSE yayını asıl RAKİBİN ekranının anında güncellenmesi
    // için gerekli — aksi halde rakip, sırası gelene kadar tahtadaki
    // değişikliği hiç göremezdi.)
    const state = this.publicState(game);
    this.hub.sendTo(game.whiteId, 'move', state);
    this.hub.sendTo(game.blackId, 'move', state);

    return state;
  }

  // Dönüş değeri { inCheck, checkmate } — oyun mantığı için değil, SAN
  // gösterimindeki "+"/"#" işaretini doğru koymak VE istemcinin tehdit
  // altındaki şahın karesini kırmızı gösterebilmesi için kullanılıyor.
  //
  // ÖNEMLİ: game.inCheck her dalda, _finalizeGame() ÇAĞRILMADAN ÖNCE
  // atanıyor — çünkü _finalizeGame() (mat durumunda) oyunu hemen store'a
  // kaydediyor (saveFinishedGame), o anda game.inCheck zaten doğru
  // (mat eden hamledeki şah durumunu yansıtan) değerde olmalı.
  async _checkGameEnd(game) {
    if (game.status !== 'active') return { inCheck: false, checkmate: false };

    const legal = await this.engine.getLegalMoves(game.currentFen);
    if (legal.length === 0) {
      const inCheck = await this.engine.isInCheck(game.currentFen);
      game.inCheck = inCheck;
      if (inCheck) {
        // Sırası gelen taraf mat oldu — diğer taraf kazandı.
        const winner = game.whiteToMove ? 'black' : 'white';
        this._finalizeGame(game, 'checkmate', winner);
        return { inCheck: true, checkmate: true };
      } else {
        this._finalizeGame(game, 'stalemate', null);
        return { inCheck: false, checkmate: false };
      }
    }

    if (isInsufficientMaterial(game.currentFen)) {
      game.inCheck = false;
      this._finalizeGame(game, 'insufficient_material', null);
      return { inCheck: false, checkmate: false };
    }

    const inCheck = await this.engine.isInCheck(game.currentFen);
    game.inCheck = inCheck;
    return { inCheck, checkmate: false };
  }

  resign(gameId, userId) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'active') throw new Error('Oyun bulunamadı ya da zaten bitmiş.');
    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');
    // Kullanıcı isteği: siyah kendi İLK hamlesini yapana kadar (yani oyun
    // henüz gerçekten "başlamamışken") HİÇBİR taraf teslim olamaz -- bu
    // dönemde tek çıkış yolu iptal (bkz. cancelGame).
    if (!game.blackMoved) throw new Error('Siyah ilk hamlesini yapana kadar teslim olunamaz.');
    this._finalizeGame(game, 'resign', color === 'white' ? 'black' : 'white');
    return this.publicState(game);
  }

  offerDraw(gameId, userId) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'active') throw new Error('Oyun bulunamadı ya da zaten bitmiş.');
    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');
    // Kullanıcı isteği: siyah kendi İLK hamlesini yapana kadar HİÇBİR taraf
    // beraberlik teklif edemez (bkz. resign() üzerindeki aynı kısıtlama).
    if (!game.blackMoved) throw new Error('Siyah ilk hamlesini yapana kadar beraberlik teklif edilemez.');

    // BERABERLİK TEKLİFİ SINIRLARI (kullanıcı isteği, bkz.
    // MAX_DRAW_OFFERS_PER_GAME / DRAW_OFFER_PERIOD_PLIES): eski (bu iki alan
    // henüz eklenmeden önce kurulmuş) canlı oyunlar için güvenlik ağı.
    if (!game.drawOfferCount) game.drawOfferCount = { white: 0, black: 0 };
    if (!game.lastDrawOfferPeriod) game.lastDrawOfferPeriod = { white: null, black: null };

    if (game.drawOfferCount[color] >= MAX_DRAW_OFFERS_PER_GAME) {
      throw new Error('Bu oyunda en fazla ' + MAX_DRAW_OFFERS_PER_GAME + ' kez beraberlik teklif edebilirsin.');
    }
    // Periyot, ŞU ANA KADAR oynanan TOPLAM yarı hamle sayısına (movesUci.length)
    // göre hesaplanır -- her DRAW_OFFER_PERIOD_PLIES (6) yarı hamle bir periyot.
    // Bu sayaç HER RENK İÇİN AYRI tutulur (bkz. game.lastDrawOfferPeriod) --
    // bir tarafın kendi periyodunu "kullanması" diğer tarafı hiç etkilemez.
    const currentPeriod = Math.floor(game.movesUci.length / DRAW_OFFER_PERIOD_PLIES);
    if (game.lastDrawOfferPeriod[color] === currentPeriod) {
      throw new Error('Her ' + (DRAW_OFFER_PERIOD_PLIES / 2) + ' hamlelik periyotta en fazla 1 kez beraberlik teklif edebilirsin.');
    }

    game.drawOfferBy = color;
    game.drawOfferCount[color] += 1;
    game.lastDrawOfferPeriod[color] = currentPeriod;
    const opponentId = color === 'white' ? game.blackId : game.whiteId;
    this.hub.sendTo(opponentId, 'draw_offered', { gameId });
    return this.publicState(game);
  }

  respondDraw(gameId, userId, accept) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'active') throw new Error('Oyun bulunamadı ya da zaten bitmiş.');
    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');
    if (!game.drawOfferBy || game.drawOfferBy === color) {
      throw new Error('Yanıtlanacak bir beraberlik teklifi yok.');
    }
    if (accept) {
      this._finalizeGame(game, 'draw_agreed', null);
    } else {
      game.drawOfferBy = null;
      const offererId = color === 'white' ? game.blackId : game.whiteId;
      this.hub.sendTo(offererId, 'draw_declined', { gameId });
    }
    return this.publicState(game);
  }

  // ============================================================
  // YENİ OYUN TEKLİFİ (REVANŞ) — biten bir oyundan sonra aynı rakiple
  // (aynı süre kontrolüyle, renkler değişmiş olarak) tekrar eşleşmek için.
  // ============================================================

  offerRematch(gameId, userId) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'finished') throw new Error('Bu oyun için yeni oyun teklif edilemez.');
    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');
    const opponentId = color === 'white' ? game.blackId : game.whiteId;
    if (this.userActiveGame.has(userId)) throw new Error('Zaten devam eden bir oyunun var.');
    if (this.userActiveGame.has(opponentId)) throw new Error('Rakip şu anda başka bir oyunda.');
    // Kullanıcı engelleme (kullanıcı isteği): rakip beni engellemişse, ona
    // yeni oyun (revanş) teklif EDEMEM -- ama o bana dilerse teklif edebilir
    // (bkz. createChallenge'daki aynı kısıtlama).
    if (this.store.isBlocked(opponentId, userId)) {
      throw new Error('Bu kullanıcı seni engellemiş, ona oyun teklifi gönderemezsin.');
    }
    // YENİ (kullanıcı isteği): bu SPESİFİK oyun için art arda 2 kez
    // reddedilen revanş teklifinden sonra, sadece bu oyun özelinde artık
    // teklif gönderilemez -- bir başka (yeni) oyunda bu kısıtlama hiç
    // geçerli değildir (bkz. respondRematch/rematchBlockedFor). NOT: revanş
    // teklifleri artık genel canOffer/pairRelations (24 saatlik) soğuma
    // mekanizmasını KULLANMIYOR -- o mekanizma YÖNSÜZ bir çift üzerinde
    // çalıştığı için "sadece bu oyuna özel" kuralıyla çelişirdi (ör. aynı
    // çift YENİ bir oyunda karşılaşınca da teklif gönderemez hâle
    // gelirlerdi, kullanıcı isteği bunun tam tersini istiyor). Doğrudan
    // meydan okuma (createChallenge/respondChallenge) hâlâ eski
    // mekanizmayı kullanmaya devam ediyor -- bkz. oradaki not.
    if (game.rematchBlockedFor && game.rematchBlockedFor[color]) {
      const err = new Error('Bu oyunda art arda 2 kez reddedildiğin için bu rakibe, bu oyuna özel olarak, artık yeni oyun teklif edemezsin.');
      err.code = 'REMATCH_BLOCKED_FOR_GAME';
      throw err;
    }
    game.rematchOfferBy = color;
    this.hub.sendTo(opponentId, 'rematch_offered', { gameId });
    return this.publicState(game);
  }

  respondRematch(gameId, userId, accept) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'finished') throw new Error('Oyun bulunamadı.');
    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');
    if (!game.rematchOfferBy || game.rematchOfferBy === color) {
      throw new Error('Yanıtlanacak bir yeni oyun teklifi yok.');
    }
    const offererId = color === 'white' ? game.blackId : game.whiteId;
    game.rematchOfferBy = null;
    if (accept) {
      if (this.userActiveGame.has(userId) || this.userActiveGame.has(offererId)) {
        throw new Error('Taraflardan biri zaten başka bir oyunda.');
      }
      // Kabul edildiği için bu oyuna özel ret sayacı da sıfırlanır (bkz.
      // rematchDeclineStreak) -- taraflar zaten yeni bir oyun kuruyor.
      if (game.rematchDeclineStreak) game.rematchDeclineStreak[color === 'white' ? 'black' : 'white'] = 0;
      // Renkleri BİLEREK tersine çevir: bu oyunda beyaz olan yeni oyunda
      // siyah olsun (rastgele değil) — kullanıcı isteği bu.
      const newWhiteId = game.blackId;
      const newBlackId = game.whiteId;
      // Önceki oyun puansızsa yeni oyun (revanş) da puansız kalır —
      // aksi halde bir dostluk maçının revanşı sürpriz şekilde puanlı
      // oynanmış olurdu.
      this._createGame(newWhiteId, newBlackId, game.timeControlKey, game.ranked !== false, 'rematch');
    } else {
      // YENİ (kullanıcı isteği): bu oyuna özel art arda ret sayacı --
      // offererColor, teklifi GÖNDERENİN rengi (yanıtlayanın rengi olan
      // "color"ın tersi). 2'ye ulaşınca bu oyun için (SADECE bu oyun için)
      // bir daha teklif gönderemez (bkz. offerRematch).
      const offererColor = color === 'white' ? 'black' : 'white';
      if (!game.rematchDeclineStreak) game.rematchDeclineStreak = { white: 0, black: 0 };
      if (!game.rematchBlockedFor) game.rematchBlockedFor = { white: false, black: false };
      game.rematchDeclineStreak[offererColor] += 1;
      if (game.rematchDeclineStreak[offererColor] >= 2) {
        game.rematchBlockedFor[offererColor] = true;
      }
      this.hub.sendTo(offererId, 'rematch_declined', { gameId });
    }
    return this.publicState(game);
  }

  // ============================================================
  // DOĞRUDAN MEYDAN OKUMA — belirli bir (o an ÇEVRİMİÇİ olan) oyuncuya,
  // kuyruk dışı, kendi seçtiğin renk ve süre kontrolüyle davet gönderme.
  // Kabul edilirse aynı _createGame() ile (renkler ÇAĞIRANIN seçimine göre
  // belirlenerek) yeni bir oyun kurulur — normal eşleştirmeden TEK farkı
  // renklerin rastgele değil, çağıranın isteğiyle atanmasıdır.
  // ============================================================

  _clearChallenge(challengeId) {
    const ch = this.challenges.get(challengeId);
    if (!ch) return;
    this.challenges.delete(challengeId);
    if (this.outgoingChallengeByUser.get(ch.challengerId) === challengeId) {
      this.outgoingChallengeByUser.delete(ch.challengerId);
    }
  }

  // ranked: true (varsayılan, puanlı) ya da false (puansız/dostluk oyunu —
  // kabul edilirse sonucu Elo puanını hiç etkilemez, bkz. _finalizeGame).
  createChallenge(challengerId, targetUsername, timeControlKey, colorChoice, ranked) {
    if (!TIME_CONTROLS[timeControlKey]) throw new Error('Geçersiz süre kontrolü.');
    if (colorChoice !== 'white' && colorChoice !== 'black' && colorChoice !== 'random') {
      throw new Error('Geçersiz renk seçimi.');
    }
    const target = this.store.getUserByUsername(String(targetUsername || '').trim());
    if (!target) throw new Error('Oyuncu bulunamadı.');
    if (target.id === challengerId) throw new Error('Kendine meydan okuyamazsın.');
    // Kullanıcı engelleme (kullanıcı isteği): hedef, ÇAĞIRANI engellemişse
    // çağıran ona hiçbir şekilde meydan okuyamaz. TERSİ SERBEST: çağıran
    // hedefi engellemiş olsa bile (dilerse) meydan okuyabilir -- engel
    // sadece TEK YÖNLÜ olarak engellenen tarafın teklif göndermesini
    // engeller (bkz. offerRematch'teki aynı kısıtlama, blockUser/store.isBlocked).
    if (this.store.isBlocked(target.id, challengerId)) {
      throw new Error('Bu kullanıcı seni engellemiş, ona oyun teklifi gönderemezsin.');
    }
    // "Sadece o an sitede olanlar" — kullanıcının kendi tercihi (bkz. proje
    // notları): meydan okunabilmesi için hedefin AKTİF bir SSE bağlantısı
    // (yani sitede açık bir sekmesi) olması gerekiyor.
    if (!this.hub.isOnline(target.id)) throw new Error('Oyuncu şu anda çevrimiçi değil.');
    if (this.userActiveGame.has(challengerId)) throw new Error('Zaten devam eden bir oyunun var.');
    if (this.userActiveGame.has(target.id)) throw new Error('Rakip şu anda başka bir oyunda.');

    // NOT: doğrudan meydan okuma ARTIK genel canOffer/pairRelations (24
    // saatlik soğuma) mekanizmasını KULLANMIYOR -- kullanıcı isteğiyle bu,
    // art arda 2. reddedilişte SADECE 24 saatlik bir soğuma yerine, göndereni
    // hedefi TAMAMEN ENGELLEMİŞ sayan (kalıcı) bir işlemle DEĞİŞTİRİLDİ (bkz.
    // respondChallenge/challengeDeclineStreak). Eski mekanizmayı burada da
    // AYRICA çalıştırmaya devam etseydik, "engelleyen kullanıcı dilerse
    // engellediğine yine de meydan okuyabilir" kuralı (bkz. blockUser'ın
    // üzerindeki açıklama) bu 24 saatlik soğuma yüzünden bozulurdu.

    // Aynı kişinin aynı anda birden fazla bekleyen daveti olmasın — yenisi
    // eskisinin (varsa) yerini alır ve eski hedefe iptal bildirimi gider.
    const previousId = this.outgoingChallengeByUser.get(challengerId);
    if (previousId) {
      const prev = this.challenges.get(previousId);
      this._clearChallenge(previousId);
      if (prev) this.hub.sendTo(prev.targetId, 'challenge_cancelled', { challengeId: previousId });
    }

    const id = crypto.randomUUID();
    const rankedFlag = ranked !== false;
    const challenge = { id, challengerId, targetId: target.id, timeControlKey, colorChoice, ranked: rankedFlag };
    this.challenges.set(id, challenge);
    this.outgoingChallengeByUser.set(challengerId, id);

    const challenger = this.store.getUserById(challengerId);
    // Hedefin bakış açısından kendi rengi: çağıran beyazı seçtiyse hedef
    // siyah oynayacak demektir (ve tersi); "rastgele" ise hedef için de
    // rastgele kalır.
    const colorForTarget = colorChoice === 'white' ? 'black' : colorChoice === 'black' ? 'white' : 'random';
    this.hub.sendTo(target.id, 'challenge_received', {
      challengeId: id,
      fromUsername: challenger?.username || '?',
      timeControlKey,
      colorForTarget,
      ranked: rankedFlag,
    });

    return { challengeId: id };
  }

  respondChallenge(challengeId, userId, accept) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new Error('Bu meydan okuma artık geçerli değil.');
    if (challenge.targetId !== userId) throw new Error('Bu meydan okumayı yanıtlama yetkin yok.');

    this._clearChallenge(challengeId);

    if (!accept) {
      this.hub.sendTo(challenge.challengerId, 'challenge_declined', { challengeId });
      // YENİ (kullanıcı isteği): aynı kullanıcıya (challengerId'den userId'ye)
      // art arda 2. kez reddedilen doğrudan meydan okumadan sonra, gönderen
      // (challengerId) artık hedefi (userId) TAMAMEN ENGELLEMİŞ sayılır --
      // mevcut komple engelleme özelliğiyle (blockUser) AYNI mekanizma.
      // Yönlü bir sayaç (rol değişimi/kabul dışında sıfırlanmaz -- bkz.
      // constructor'daki challengeDeclineStreak açıklaması).
      const streakKey = challenge.challengerId + '>' + userId;
      const streak = (this.challengeDeclineStreak.get(streakKey) || 0) + 1;
      if (streak >= 2) {
        this.challengeDeclineStreak.set(streakKey, 0);
        const targetUser = this.store.getUserById(userId);
        if (targetUser && !this.store.isBlocked(challenge.challengerId, userId)) {
          try { this.blockUser(challenge.challengerId, targetUser.username); } catch { /* önemsiz -- zaten engellenmiş olabilir */ }
        }
      } else {
        this.challengeDeclineStreak.set(streakKey, streak);
      }
      return { ok: true };
    }

    // Kabul edildi -- taraflar "barıştı" sayılır, ret zinciri sıfırlanır.
    this.challengeDeclineStreak.set(challenge.challengerId + '>' + userId, 0);

    if (this.userActiveGame.has(challenge.challengerId) || this.userActiveGame.has(userId)) {
      this.hub.sendTo(challenge.challengerId, 'challenge_declined', { challengeId });
      throw new Error('Taraflardan biri zaten başka bir oyunda.');
    }

    let whiteId, blackId;
    if (challenge.colorChoice === 'white') {
      whiteId = challenge.challengerId; blackId = userId;
    } else if (challenge.colorChoice === 'black') {
      whiteId = userId; blackId = challenge.challengerId;
    } else {
      whiteId = Math.random() < 0.5 ? challenge.challengerId : userId;
      blackId = whiteId === challenge.challengerId ? userId : challenge.challengerId;
    }
    this._createGame(whiteId, blackId, challenge.timeControlKey, challenge.ranked, 'challenge');
    return { ok: true };
  }

  cancelChallenge(challengeId, userId) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return { ok: true }; // zaten süresi dolmuş/iptal edilmiş olabilir, sorun değil
    if (challenge.challengerId !== userId) throw new Error('Bu meydan okumayı iptal etme yetkin yok.');
    this._clearChallenge(challengeId);
    this.hub.sendTo(challenge.targetId, 'challenge_cancelled', { challengeId });
    return { ok: true };
  }

  // ============================================================
  // KULLANICI ENGELLEME (kullanıcı isteği) — bir kullanıcı, istediği başka
  // bir kullanıcıyı TAMAMEN engelleyebilir:
  //   - Engellenen kullanıcı, engelleyene HİÇBİR ŞEKİLDE oyun teklifi
  //     (doğrudan meydan okuma ya da yeni oyun/revanş teklifi) gönderemez
  //     (bkz. createChallenge/offerRematch).
  //   - İki taraf da hızlı eşleştirmede ASLA birbirleriyle eşleştirilmez
  //     (bkz. _tryMatchQueue/isBlockedBetween) -- yön fark etmez.
  //   - AMA engelleyen kullanıcı, dilerse engellediği kullanıcıya doğrudan
  //     meydan okuyabilir -- kabul ederse özel eşleştirmede oynayabilirler.
  //     Bu şekilde birlikte oynamaları (ya da engellenenin teklifi kabul
  //     etmesi) engeli KALDIRMAZ -- engellenen taraf hâlâ teklif gönderemez,
  //     ta ki engelleyen kullanıcı engeli kendi isteğiyle kaldırana kadar.
  // Kalıcı olarak saklanır (bkz. store.js: users[id].blockedUserIds) --
  // sunucu yeniden başlasa bile engeller kaybolmaz (pairRelations/
  // quickMatchCancel* gibi geçici cezalardan FARKLI olarak, bu kullanıcının
  // BİLİNÇLİ bir tercihi).
  // ============================================================

  blockUser(blockerId, targetUsername) {
    const target = this.store.getUserByUsername(String(targetUsername || '').trim());
    if (!target) throw new Error('Oyuncu bulunamadı.');
    if (target.id === blockerId) throw new Error('Kendini engelleyemezsin.');
    this.store.blockUser(blockerId, target.id);

    // Engellenen kullanıcının, engelleyene göndermiş olduğu (varsa) bekleyen
    // bir meydan okuması artık geçersiz -- iptal edip karşı tarafa (engellenen
    // kullanıcıya) bildiriyoruz.
    const pendingId = this.outgoingChallengeByUser.get(target.id);
    if (pendingId) {
      const pending = this.challenges.get(pendingId);
      if (pending && pending.targetId === blockerId) {
        this._clearChallenge(pendingId);
        this.hub.sendTo(target.id, 'challenge_cancelled', { challengeId: pendingId });
      }
    }

    return { ok: true, username: target.username };
  }

  unblockUser(blockerId, targetUsername) {
    const target = this.store.getUserByUsername(String(targetUsername || '').trim());
    if (!target) throw new Error('Oyuncu bulunamadı.');
    this.store.unblockUser(blockerId, target.id);
    return { ok: true, username: target.username };
  }

  listBlockedUsers(blockerId) {
    return this.store.getBlockedUsernames(blockerId);
  }

  // İki kullanıcıdan HERHANGİ BİRİ diğerini engellemiş mi (yön fark etmez)?
  // SADECE hızlı eşleştirmeyi engellemek için kullanılıyor (bkz. _tryMatchQueue) --
  // doğrudan meydan okumadaki TEK YÖNLÜ kural için store.isBlocked() doğrudan
  // kullanılıyor (bkz. createChallenge/offerRematch).
  isBlockedBetween(aId, bId) {
    return this.store.isBlocked(aId, bId) || this.store.isBlocked(bId, aId);
  }

  // ============================================================
  // MESAJ SUSTURMA (kullanıcı isteği) — komple engellemeden (yukarısı)
  // TAMAMEN AYRI, çok daha hafif bir özellik: bir kullanıcı, başka bir
  // kullanıcının SADECE MESAJLARINI (oyuncu/seyirci/birleşik sohbetin
  // HERHANGİ birinde) kendisi için gizleyebilir -- teklif gönderme/alma,
  // hızlı eşleştirmede karşılaşma gibi HİÇBİR ŞEYİ etkilemez. Kalıcıdır:
  // ileride başka bir oyunda tekrar karşılaşsalar bile susturulan
  // kullanıcının mesajları susturana ulaşmaz (bkz. store.js: mutedUserIds).
  // ============================================================

  muteUser(muterId, targetUsername) {
    const target = this.store.getUserByUsername(String(targetUsername || '').trim());
    if (!target) throw new Error('Oyuncu bulunamadı.');
    if (target.id === muterId) throw new Error('Kendini susturamazsın.');
    this.store.muteUser(muterId, target.id);
    return { ok: true, username: target.username };
  }

  unmuteUser(muterId, targetUsername) {
    const target = this.store.getUserByUsername(String(targetUsername || '').trim());
    if (!target) throw new Error('Oyuncu bulunamadı.');
    this.store.unmuteUser(muterId, target.id);
    return { ok: true, username: target.username };
  }

  listMutedUsers(muterId) {
    return this.store.getMutedUsernames(muterId);
  }

  // Bir mesajın göndereni (senderId), belirli bir izleyici (viewerId) için
  // gizli sayılır mı? Komple engelleme (blockUser) VEYA sadece-mesaj
  // susturma (muteUser) -- ikisi de aynı şekilde mesajı gizler, ikisi de
  // TEK YÖNLÜDÜR (sadece viewerId'nin bakış açısından).
  _isMessageHiddenFor(viewerId, senderId) {
    if (viewerId === senderId) return false;
    return this.store.isBlocked(viewerId, senderId) || this.store.isMuted(viewerId, senderId);
  }

  // ============================================================
  // SEYİRCİ KAYDI (kullanıcı isteği) — o an bir oyunun sayfasını (canlı
  // oyun ekranı ya da bitmiş oyunun analiz tahtası) açık tutan kullanıcılar.
  // Bu proje bilerek TAMAMEN AÇIK bir izleme modeli kullanıyor: giriş yapmış
  // HERHANGİ bir kullanıcı, linkini bilerek bir oyunun sayfasını açarsa
  // (canlı ya da bitmiş fark etmez) izleyebilir -- tıpkı /api/game/:id'nin
  // zaten oyuncu olmayan biri için de kısıtlama getirmemesi gibi. Lobiden
  // "rastgele bir oyunu izle" gibi bir keşif listesi bu istekte hiç
  // istenmedi, bu yüzden eklenmedi.
  // ============================================================

  watchGame(gameId, userId) {
    const live = this.games.get(gameId);
    const persisted = live ? null : this.store.getGame(gameId);
    if (!live && !persisted) throw new Error('Oyun bulunamadı.');
    if (!this.viewersByGame.has(gameId)) this.viewersByGame.set(gameId, new Set());
    this.viewersByGame.get(gameId).add(userId);
  }

  unwatchGame(gameId, userId) {
    const set = this.viewersByGame.get(gameId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) this.viewersByGame.delete(gameId);
  }

  _viewerIds(gameId) {
    return this.viewersByGame.get(gameId) || new Set();
  }

  // Bir mesaj dizisinin SONUNDAN geriye doğru, aynı gönderenin kaç mesajı
  // ÜST ÜSTE (arada başka biri hiç yazmadan) durduğunu sayar -- art arda
  // mesaj sınırlarının (bkz. MAX_CONSECUTIVE_*_CHAT_MSGS) TEK dayanağı bu:
  // ayrı bir sayaç tutmaya hiç gerek yok, mesajların kendisi zaten yeterli.
  _trailingStreak(arr, senderId) {
    let count = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].senderId === senderId) count++;
      else break;
    }
    return count;
  }

  // Yeni bir sohbet mesajını, ALICI BAZINDA (engel/susturma filtrelenerek)
  // ilgili kullanıcılara gerçek zamanlı olarak (SSE) iletir.
  //   channel 'player'    -> canlı oyun sırasında: HER İKİ oyuncuya VE tüm
  //                          izleyicilere (seyirciler oyuncu sohbetini
  //                          OKUYABİLİR -- bkz. dosya başındaki açıklama).
  //   channel 'spectator' -> canlı oyun sırasında: SADECE izleyicilere
  //                          (oyuncular seyirci sohbetini hiç göremez) --
  //                          oyuncuların kendisi izleyici listesine dahil
  //                          olsa bile burada AÇIKÇA hariç tutuluyor.
  //   channel 'merged'    -> oyun bittikten sonra: oyuncular + tüm
  //                          izleyiciler (artık herkes eşit).
  _broadcastChat(gameId, { whiteId, blackId }, msg, channel) {
    const recipients = new Set(this._viewerIds(gameId));
    recipients.add(whiteId);
    recipients.add(blackId);
    if (channel === 'spectator') {
      recipients.delete(whiteId);
      recipients.delete(blackId);
    }
    for (const uid of recipients) {
      if (this._isMessageHiddenFor(uid, msg.senderId)) continue;
      this.hub.sendTo(uid, 'chat_message', { gameId, channel, message: msg });
    }
  }

  _publicChatMessage(m) {
    return { id: m.id, senderId: m.senderId, senderUsername: m.senderUsername, text: m.text, sentAt: m.sentAt, channel: m.channel };
  }

  // Bir kullanıcının bu oyun için görebileceği sohbet(ler)ini döndürür.
  // Canlı VE aktif bir oyunsa: oyuncuya SADECE oyuncu sohbeti (spectatorChat:
  // null -- arayüz bunu "bu sohbeti hiç görmüyorsun" olarak yorumlar),
  // izleyiciye HEM oyuncu (salt okunur) HEM seyirci sohbeti. Oyun bitmiş
  // (ya da artık bellekte bile olmayıp sadece kalıcı depoda) ise TEK bir
  // birleşik (merged) sohbet döner -- bkz. _finalizeGame.
  getChat(gameId, userId) {
    const live = this.games.get(gameId);
    if (live && live.status === 'active') {
      const color = this.colorOf(live, userId);
      const playerChat = live.playerChat
        .filter(m => !this._isMessageHiddenFor(userId, m.senderId))
        .map(m => this._publicChatMessage(m));
      const spectatorChat = color ? null : live.spectatorChat
        .filter(m => !this._isMessageHiddenFor(userId, m.senderId))
        .map(m => this._publicChatMessage(m));
      return { phase: 'live', isPlayer: !!color, playerChat, spectatorChat };
    }
    const rec = this.store.getGame(gameId);
    if (!rec) throw new Error('Oyun bulunamadı.');
    const merged = (rec.chat || [])
      .filter(m => !this._isMessageHiddenFor(userId, m.senderId))
      .map(m => this._publicChatMessage(m));
    return { phase: 'finished', isPlayer: rec.whiteId === userId || rec.blackId === userId, merged };
  }

  // Yeni bir sohbet mesajı gönderir -- hangi sohbete (oyuncu/seyirci/
  // birleşik) gideceğini, oyunun durumuna VE gönderenin bu oyundaki rolüne
  // bakarak KENDİSİ belirler (istemci bunu seçemez -- güvenlik + tutarlılık
  // için).
  sendChat(gameId, userId, text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) throw new Error('Mesaj boş olamaz.');
    if (raw.length > CHAT_MESSAGE_MAX_LENGTH) throw new Error('Mesaj çok uzun (en fazla 500 karakter).');
    const sender = this.store.getUserById(userId);
    const senderUsername = sender?.username || '?';

    const live = this.games.get(gameId);
    if (live && live.status === 'active') {
      const color = this.colorOf(live, userId);
      if (color) {
        if (this._trailingStreak(live.playerChat, userId) >= MAX_CONSECUTIVE_PLAYER_CHAT_MSGS) {
          const err = new Error('Rakibin cevap verene kadar art arda en fazla 2 mesaj gönderebilirsin.');
          err.code = 'CHAT_PLAYER_RATE_LIMIT';
          throw err;
        }
        const msg = { id: crypto.randomUUID(), senderId: userId, senderUsername, text: raw, sentAt: Date.now(), channel: 'player' };
        live.playerChat.push(msg);
        this._broadcastChat(gameId, live, msg, 'player');
        return { message: this._publicChatMessage(msg) };
      }
      if (this._trailingStreak(live.spectatorChat, userId) >= MAX_CONSECUTIVE_SPECTATOR_CHAT_MSGS) {
        const err = new Error('Başka biri araya mesaj yazana kadar üst üste en fazla 2 mesaj gönderebilirsin.');
        err.code = 'CHAT_SPECTATOR_RATE_LIMIT';
        throw err;
      }
      const msg = { id: crypto.randomUUID(), senderId: userId, senderUsername, text: raw, sentAt: Date.now(), channel: 'spectator' };
      live.spectatorChat.push(msg);
      this._broadcastChat(gameId, live, msg, 'spectator');
      return { message: this._publicChatMessage(msg) };
    }

    // Oyun bitmiş (ya da bellekten silinmiş, sadece kalıcı depoda) --
    // birleşik sohbete yazılıyor. Kullanıcı isteği: art arda mesaj sınırı
    // burada da (canlı oyuncu sohbetiyle AYNI şekilde) geçerli olsun --
    // birleşik sohbette de bir kişi karşı taraf/başkası yazana kadar üst
    // üste en fazla 2 mesaj gönderebilir.
    const rec = this.store.getGame(gameId);
    if (!rec) throw new Error('Oyun bulunamadı.');
    if (this._trailingStreak(rec.chat || [], userId) >= MAX_CONSECUTIVE_PLAYER_CHAT_MSGS) {
      const err = new Error('Karşı taraf cevap verene kadar art arda en fazla 2 mesaj gönderebilirsin.');
      err.code = 'CHAT_PLAYER_RATE_LIMIT';
      throw err;
    }
    const msg = { id: crypto.randomUUID(), senderId: userId, senderUsername, text: raw, sentAt: Date.now(), channel: 'merged' };
    this.store.appendChatMessage(gameId, msg);
    this._broadcastChat(gameId, { whiteId: rec.whiteId, blackId: rec.blackId }, msg, 'merged');
    return { message: this._publicChatMessage(msg) };
  }

  // Klasik satranç kuralı: bayrak düşse bile rakipte mat kuracak yeterli taş
  // yoksa sonuç beraberedir, mağlubiyet değil.
  _finalizeOnTimeout(game, flaggedColor) {
    if (isInsufficientMaterial(game.currentFen)) {
      this._finalizeGame(game, 'timeout_insufficient_material', null);
    } else {
      this._finalizeGame(game, 'timeout', flaggedColor === 'white' ? 'black' : 'white');
    }
  }

  _finalizeGame(game, reason, winnerColor) {
    game.status = 'finished';
    game.resultReason = reason;
    game.winnerColor = winnerColor;
    // Son derece nadir bir uç durum (ör. daha SİYAH hiç oynamadan beyazın
    // 1. hamlede mat etmesi) dışında normalde zaten boş olur, ama olası bir
    // bekleyen ilk-hamle-süresi zamanlayıcısının oyunu bittikten SONRA
    // yanlışlıkla "iptal etmeye" çalışmaması için burada da temizliyoruz.
    this._clearFirstMoveTimer(game);

    const whiteUser = this.store.getUserById(game.whiteId);
    const blackUser = this.store.getUserById(game.blackId);

    // Elo puanı süre kontrolü KATEGORİSİNE göre ayrı tutuluyor (bkz.
    // store.js) — bu yüzden sadece bu oyunun kategorisindeki (ör. "bullet")
    // puanlar okunup güncelleniyor, oyuncunun diğer üç kategorideki puanı
    // hiç etkilenmiyor.
    const category = TIME_CONTROLS[game.timeControlKey]?.category || 'bullet';

    let scoreWhite = 0.5;
    if (winnerColor === 'white') scoreWhite = 1;
    else if (winnerColor === 'black') scoreWhite = 0;

    const whiteRatingBefore = whiteUser?.ratings?.[category] ?? 1500;
    const blackRatingBefore = blackUser?.ratings?.[category] ?? 1500;
    let newWhiteRating = whiteRatingBefore;
    let newBlackRating = blackRatingBefore;
    const isRanked = game.ranked !== false;

    // Puansız (dostluk) oyunlarda Elo hiç hesaplanmıyor/güncellenmiyor —
    // kullanıcı isteği: doğrudan meydan okumada "puansız" seçilebilsin.
    if (isRanked && whiteUser && blackUser) {
      const result = computeNewRatings(whiteRatingBefore, blackRatingBefore, scoreWhite);
      newWhiteRating = result.newWhite;
      newBlackRating = result.newBlack;
      this.store.updateUserRating(
        whiteUser.id, category, newWhiteRating,
        scoreWhite === 1 ? 'win' : scoreWhite === 0 ? 'loss' : 'draw'
      );
      this.store.updateUserRating(
        blackUser.id, category, newBlackRating,
        scoreWhite === 0 ? 'win' : scoreWhite === 1 ? 'loss' : 'draw'
      );
    }

    this.store.saveFinishedGame(game.id, {
      whiteId: game.whiteId,
      blackId: game.blackId,
      whiteUsername: whiteUser?.username,
      blackUsername: blackUser?.username,
      timeControlKey: game.timeControlKey,
      timeControlCategory: category,
      ranked: isRanked,
      startFen: game.startFen,
      currentFen: game.currentFen,
      movesUci: game.movesUci,
      sanMoves: game.sanMoves,
      resultReason: reason,
      winnerColor,
      whiteRatingAfter: newWhiteRating,
      blackRatingAfter: newBlackRating,
      // Oyun bittiği andaki saatler de kaydediliyor — aksi halde oyuncu
      // analiz tahtasından oyun ekranına geri döndüğünde (ya da sayfayı
      // yenilediğinde) saatler "NaN:NaN" görünüyordu, çünkü kalıcı
      // (store'a yazılmış, artık canlı olmayan) oyun kaydında bu alanlar
      // hiç yoktu.
      whiteClockMs: game.whiteClockMs,
      blackClockMs: game.blackClockMs,
      // Mat ile bitmişse, matı alan şahın karesinin analiz/oyun ekranında
      // kırmızı gösterilmeye devam edebilmesi için bu bilgi de kaydediliyor.
      inCheck: game.inCheck,
      // Analiz tahtasında her pozisyonda "o anki" saatleri gösterebilmek için.
      clockHistory: game.clockHistory,
      // İstemcinin (bkz. game.js) eski/yeni kayıtları ayırt etmeden doğru
      // varsayılan davranışı seçebilmesi için (bkz. FIRST_MOVE_DEADLINE_MS).
      whiteMoved: game.whiteMoved,
      blackMoved: game.blackMoved,
      endedAt: new Date().toISOString(),
      // SOHBET BİRLEŞTİRME (kullanıcı isteği): oyuncu ve seyirci
      // sohbetlerinde o ana kadar yazılmış TÜM mesajlar, kimin hangi
      // sohbette yazdığına bakılmaksızın, GERÇEK GÖNDERİLME ZAMANINA göre
      // tek bir diziye SIRALANIR -- bundan sonra (analiz tahtasında) yazılan
      // her yeni mesaj da bu diziye eklenir (bkz. sendChat/getChat). Her
      // mesaj hangi sohbetten geldiğini ("channel": 'player' | 'spectator')
      // hatırlıyor, ama birleşik görünümde bu ARTIK hiçbir kısıtlama
      // getirmiyor -- sadece bilgi amaçlı.
      chat: [...(game.playerChat || []), ...(game.spectatorChat || [])]
        .sort((a, b) => a.sentAt - b.sentAt),
    });

    this.userActiveGame.delete(game.whiteId);
    this.userActiveGame.delete(game.blackId);

    const payload = {
      gameId: game.id, reason, winnerColor, ranked: isRanked,
      whiteRatingAfter: newWhiteRating, blackRatingAfter: newBlackRating,
    };
    this.hub.sendTo(game.whiteId, 'game_over', payload);
    this.hub.sendTo(game.blackId, 'game_over', payload);

    // Bellekten hemen silmiyoruz — istemci son "move"/"game_over" olayını
    // kaçırırsa /api/game/:id ile hâlâ okuyabilsin diye bir süre saklıyoruz.
    setTimeout(() => this.games.delete(game.id), 5 * 60 * 1000);
  }

  _sweepClocks() {
    const now = Date.now();
    for (const game of this.games.values()) {
      if (game.status !== 'active') continue;
      // İLK HAMLE SÜRESİ: sırası gelen taraf henüz kendi İLK hamlesini hiç
      // yapmadıysa, saati zaten HİÇ İŞLEMİYOR (bkz. applyMove) -- bu yüzden
      // burada da normal "bayrak düştü" kontrolünü ATLIYORUZ; o tarafın
      // süresi ayrı bir zamanlayıcı ile (bkz. _scheduleFirstMoveTimer)
      // takip ediliyor ve dolarsa oyun MAĞLUBİYET değil İPTAL olarak biter.
      const waitingForFirstMove = game.whiteToMove ? !game.whiteMoved : !game.blackMoved;
      if (waitingForFirstMove) continue;
      const clockField = game.whiteToMove ? 'whiteClockMs' : 'blackClockMs';
      const elapsed = now - game.turnStartedAt;
      const remaining = game[clockField] - elapsed;
      if (remaining <= 0) {
        game[clockField] = 0;
        const flaggedColor = game.whiteToMove ? 'white' : 'black';
        this._finalizeOnTimeout(game, flaggedColor);
      }
    }
  }
}

module.exports = { GameManager, TIME_CONTROLS, START_FEN, CATEGORY_LABELS };
