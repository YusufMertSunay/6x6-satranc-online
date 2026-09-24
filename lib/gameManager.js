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
  '3+2': { initialMs: 3 * 60 * 1000, incrementMs: 2000, label: '3 dk | +2 sn (Blitz)', category: 'blitz' },
  '5+8': { initialMs: 5 * 60 * 1000, incrementMs: 8000, label: '5 dk | +8 sn (Rapid)', category: 'rapid' },
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

// İki oyuncu arasında art arda reddedilen tekliflerden sonra uygulanan
// "soğuma" ve "tam engel" sürelerinin uzunluğu (bkz. aşağıdaki
// canOffer/canMatch/_recordOfferDeclined ve kullanıcı isteği).
const PAIR_BLOCK_MS = 24 * 60 * 60 * 1000;

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

    // İki kullanıcı arasındaki "ilişki" durumu — art arda reddedilen
    // meydan okuma/yeni oyun tekliflerinden doğan geçici kısıtlamaları
    // izlemek için (bkz. canOffer/canMatch ve kullanıcı isteği). Anahtar:
    // _pairKey(userIdA, userIdB) (sıralanmış, yönsüz çift).
    this.pairRelations = new Map();

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
          // Art arda reddedilen tekliflerden dolayı bu iki oyuncu arasında
          // geçici bir eşleşme engeli varsa (bkz. canMatch), kuyrukta ne
          // kadar süredir bekliyor olurlarsa olsunlar hızlı eşleşme bu
          // ikisini ASLA (tesadüfen dahi) eşleştirmesin.
          if (!this.canMatch(infos[i].entry.userId, infos[j].entry.userId)) continue;
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
  // İKİ OYUNCU ARASINDAKİ "İLİŞKİ" DURUMU — kullanıcı isteği (düzeltilmiş
  // hâliyle): bir kullanıcı aynı hedefe art arda 2 kez teklif gönderip
  // İKİSİ DE reddedilirse, SADECE O KULLANICI (teklifi gönderen), O ANDAN
  // itibaren 24 saat boyunca o hedefe yeni teklif gönderemez. Bu, HER
  // KULLANICI İÇİN AYRI VE BAĞIMSIZ bir sayaçtır — biri bloklanınca
  // diğerinin (varsa) kendi bloğu ETKİLENMEZ/UZAMAZ/SIFIRLANMAZ; her biri
  // sadece KENDİ 2. art arda reddedilişinin üzerinden 24 saat geçince
  // kalkar. Örnek: A, B'ye art arda 2 kez reddedilir (A artık 24 saat B'ye
  // teklif edemez). B, bu 24 saatin 22. saatinde A'ya kendi teklifini
  // gönderir (rol değişimi) ve bu da art arda 2 kez reddedilirse, B ARTIK
  // KENDİ 24 saatini (bu 2. reddedilişin ANINDAN başlayarak) işletir --
  // A'nın süresi bundan ETKİLENMEZ, kendi 24 saati dolunca (B'ninkinden
  // ÖNCE) A yeniden teklif gönderebilir hâle gelir.
  //
  // Hızlı eşleşme: art arda 2 reddedilişten sonra (kim olursa olsun) çift
  // ayrıca 24 saatliğine hızlı eşleşmede de eşleştirilmez -- ama HEDEF
  // kendi isteğiyle bir teklif gönderirse (rolleri değiştirirse) bu engel
  // hemen kalkar (gönderenin kendi 24 saatlik "teklif gönderememe" cezası
  // bundan ETKİLENMEDEN aynen devam eder). Taraflar bu sırada eşleşip
  // (birbirinin teklifini kabul edip) oynasalar bile, halihazırda işlemekte
  // olan "teklif gönderememe" cezaları kendi sürelerini dolana kadar AYNEN
  // devam eder (kullanıcının açıkça belirttiği istisna).
  //
  // NOT: bu durum kasıtlı olarak SADECE bellekte tutuluyor (kuyruklar/
  // meydan okumalar gibi) — sunucu yeniden başlarsa sıfırlanır, bu küçük
  // ölçekli bir proje için kabul edilebilir bir basitleştirme.
  // ============================================================

  _pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  _getPairRelation(a, b) {
    const key = this._pairKey(a, b);
    let rel = this.pairRelations.get(key);
    if (!rel) {
      // lastDeclinedBy/declineStreak: en son art arda kimin teklifi
      // reddediliyor ve kaç kez üst üste (rol değiştikçe sıfırlanır).
      // offerCooldownUntil: userId -> "bu tarihe kadar BU hedefe teklif
      // gönderemez" (HER kullanıcı için ayrı, birbirinden bağımsız).
      // matchBlockUntil: çift için PAYLAŞILAN, hızlı eşleşmeyi engelleyen
      // tek bir zaman damgası (rol değişince erken temizlenebilir).
      rel = { lastDeclinedBy: null, declineStreak: 0, offerCooldownUntil: {}, matchBlockUntil: 0 };
      this.pairRelations.set(key, rel);
    }
    return rel;
  }

  // Kullanıcı A, kullanıcı B'ye (özel meydan okuma ya da yeni oyun teklifi
  // olarak) yeni bir teklif gönderebilir mi? Gönderemezse sebebini (kod +
  // ne kadar süre sonra tekrar deneyebileceğini) döndürür.
  canOffer(fromId, toId) {
    const rel = this._getPairRelation(fromId, toId);
    const now = Date.now();
    const cooldownUntil = rel.offerCooldownUntil[fromId] || 0;
    if (cooldownUntil > now) return { ok: false, code: 'OFFER_ON_COOLDOWN', retryAfterMs: cooldownUntil - now };
    return { ok: true };
  }

  // İki kullanıcı hızlı eşleşme kuyruğunda birbirleriyle eşleştirilebilir mi?
  canMatch(aId, bId) {
    const rel = this._getPairRelation(aId, bId);
    return !(rel.matchBlockUntil > Date.now());
  }

  // Bir teklif (meydan okuma ya da yeni oyun teklifi) gönderildiğinde
  // çağrılır. Tek işi: eğer roller DEĞİŞTİYSE (hedef, daha önce kendisine
  // teklif göndereni kabul/ret ETMEK yerine kendisi bir teklif gönderiyorsa)
  // VE o anda geçici bir hızlı-eşleşme engeli varsa, bunu KALDIRMAK —
  // (istisna kuralı: "reddeden kullanıcı kendisi teklif yaparsa eşleşme
  // yasağı kalksın"). Karşı tarafın kendi 24 saatlik "teklif gönderememe"
  // cezası buradan ETKİLENMEZ, kendi süresi dolana kadar aynen devam eder.
  _recordOfferSent(fromId, toId) {
    const rel = this._getPairRelation(fromId, toId);
    if (rel.lastDeclinedBy && rel.lastDeclinedBy !== fromId && rel.matchBlockUntil) {
      rel.matchBlockUntil = 0;
    }
  }

  // Kullanıcı "fromId"nin kullanıcı "toId"ye gönderdiği teklif reddedildiğinde
  // çağrılır. Art arda (aynı gönderenden) 2. reddedilişte cezayı uygular --
  // bu, HER SEFERİNDE aynı şekilde işler (özel bir "ikinci tur/daha ağır
  // ceza" YOKTUR): sadece o anki gönderen kişi kendi 24 saatlik cezasını
  // alır, daha önce (varsa) karşı tarafa uygulanmış olan ceza bundan
  // etkilenmez.
  _recordOfferDeclined(fromId, toId) {
    const rel = this._getPairRelation(fromId, toId);
    if (rel.lastDeclinedBy === fromId) {
      rel.declineStreak += 1;
    } else {
      rel.lastDeclinedBy = fromId;
      rel.declineStreak = 1;
    }

    if (rel.declineStreak >= 2) {
      const now = Date.now();
      // SADECE gönderen kişi (fromId), bu hedefe (toId) 24 saat boyunca
      // yeni teklif gönderemez -- bu zaman damgası SADECE fromId'ye ait,
      // toId'nin kendi (varsa) cezasına dokunmaz.
      rel.offerCooldownUntil[fromId] = now + PAIR_BLOCK_MS;
      // Hızlı eşleşme engeli bu andan itibaren 24 saat sürsün -- hedef
      // kendi teklifini gönderene kadar (bkz. _recordOfferSent'teki
      // istisna).
      rel.matchBlockUntil = now + PAIR_BLOCK_MS;
      rel.declineStreak = 0;
    }
  }

  // Bir teklif kabul edilip oyun kurulduğunda çağrılır: art arda ret
  // "zincirini" sıfırlar (halihazırda uygulanmış zamanlı cezalar --
  // offerCooldownUntil, matchBlockUntil -- kendi sürelerini doldurana kadar
  // AYNEN kalmaya devam eder; bu sadece YENİ bir ceza tetiklenme riskini
  // sıfırlar -- kullanıcının açıkça belirttiği istisna: eşleşip oynasalar
  // bile mevcut "teklif gönderememe" cezası kalkmaz).
  _recordOfferAccepted(fromId, toId) {
    const rel = this._getPairRelation(fromId, toId);
    rel.lastDeclinedBy = null;
    rel.declineStreak = 0;
  }

  // Normal eşleştirme (lobiden kuyruğa girip rastgele biriyle karşılaşma):
  // burada iki oyuncu arasında önceden bir ilişki yok, o yüzden renkler
  // rastgele dağıtılıyor.
  _startGame(userA, userB, timeControlKey) {
    const whiteId = Math.random() < 0.5 ? userA : userB;
    const blackId = whiteId === userA ? userB : userA;
    this._createGame(whiteId, blackId, timeControlKey);
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
  _createGame(whiteId, blackId, timeControlKey, ranked = true) {
    const id = crypto.randomUUID();
    const tc = TIME_CONTROLS[timeControlKey];

    const game = {
      id,
      whiteId,
      blackId,
      timeControlKey,
      timeControlCategory: tc.category,
      ranked,
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
      rematchOfferBy: null,
      status: 'active',
      resultReason: null,
      winnerColor: null,
      createdAt: new Date().toISOString(),
    };

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

    // --- Saat: bu hamleyi düşünürken geçen süreyi düş ---
    const now = Date.now();
    const elapsed = now - game.turnStartedAt;
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
    this._finalizeGame(game, 'resign', color === 'white' ? 'black' : 'white');
    return this.publicState(game);
  }

  offerDraw(gameId, userId) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'active') throw new Error('Oyun bulunamadı ya da zaten bitmiş.');
    const color = this.colorOf(game, userId);
    if (!color) throw new Error('Bu oyunun oyuncusu değilsin.');
    game.drawOfferBy = color;
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
    const offerCheck = this.canOffer(userId, opponentId);
    if (!offerCheck.ok) {
      const err = new Error('Bu oyuncuya şu anda meydan okuyamazsın.');
      err.code = offerCheck.code;
      err.retryAfterMs = offerCheck.retryAfterMs;
      throw err;
    }
    game.rematchOfferBy = color;
    this._recordOfferSent(userId, opponentId);
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
      this._recordOfferAccepted(offererId, userId);
      // Renkleri BİLEREK tersine çevir: bu oyunda beyaz olan yeni oyunda
      // siyah olsun (rastgele değil) — kullanıcı isteği bu.
      const newWhiteId = game.blackId;
      const newBlackId = game.whiteId;
      // Önceki oyun puansızsa yeni oyun (revanş) da puansız kalır —
      // aksi halde bir dostluk maçının revanşı sürpriz şekilde puanlı
      // oynanmış olurdu.
      this._createGame(newWhiteId, newBlackId, game.timeControlKey, game.ranked !== false);
    } else {
      this._recordOfferDeclined(offererId, userId);
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
    // "Sadece o an sitede olanlar" — kullanıcının kendi tercihi (bkz. proje
    // notları): meydan okunabilmesi için hedefin AKTİF bir SSE bağlantısı
    // (yani sitede açık bir sekmesi) olması gerekiyor.
    if (!this.hub.isOnline(target.id)) throw new Error('Oyuncu şu anda çevrimiçi değil.');
    if (this.userActiveGame.has(challengerId)) throw new Error('Zaten devam eden bir oyunun var.');
    if (this.userActiveGame.has(target.id)) throw new Error('Rakip şu anda başka bir oyunda.');

    // Art arda 2 kez reddedilen tekliflerden doğan 24 saatlik "soğuma"
    // süresi varsa (bkz. canOffer), yeni bir meydan okuma gönderilemez.
    const offerCheck = this.canOffer(challengerId, target.id);
    if (!offerCheck.ok) {
      const err = new Error('Bu oyuncuya şu anda meydan okuyamazsın.');
      err.code = offerCheck.code;
      err.retryAfterMs = offerCheck.retryAfterMs;
      throw err;
    }

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
    this._recordOfferSent(challengerId, target.id);

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
      this._recordOfferDeclined(challenge.challengerId, userId);
      this.hub.sendTo(challenge.challengerId, 'challenge_declined', { challengeId });
      return { ok: true };
    }

    if (this.userActiveGame.has(challenge.challengerId) || this.userActiveGame.has(userId)) {
      this.hub.sendTo(challenge.challengerId, 'challenge_declined', { challengeId });
      throw new Error('Taraflardan biri zaten başka bir oyunda.');
    }

    this._recordOfferAccepted(challenge.challengerId, userId);

    let whiteId, blackId;
    if (challenge.colorChoice === 'white') {
      whiteId = challenge.challengerId; blackId = userId;
    } else if (challenge.colorChoice === 'black') {
      whiteId = userId; blackId = challenge.challengerId;
    } else {
      whiteId = Math.random() < 0.5 ? challenge.challengerId : userId;
      blackId = whiteId === challenge.challengerId ? userId : challenge.challengerId;
    }
    this._createGame(whiteId, blackId, challenge.timeControlKey, challenge.ranked);
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
      endedAt: new Date().toISOString(),
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
