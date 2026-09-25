// server.js
//
// Bağımlılıksız (npm paketi kullanmayan) HTTP sunucusu. Bu sandbox'ta npm
// kayıt sunucusuna erişim organizasyon politikasıyla tamamen engellendiği
// için (Express/Socket.io/better-sqlite3 kurulamadı), her şeyi Node'un
// YERLEŞİK modülleriyle (http, crypto, fs, child_process) yazdık — böylece
// kodu BURADA, gerçek istekler göndererek test edebildik. Kendi sunucunda
// (Render/Railway/VPS) npm kısıtlaması olmayacağı için istersen bunu
// Express + Socket.io + gerçek bir veritabanına kolayca taşıyabilirsin —
// README.md'de nasıl yapılacağı anlatılıyor.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Engine } = require('./lib/engine');
const { Store, RATING_CATEGORIES } = require('./lib/store');
const { hashPassword, verifyPassword, SessionManager, parseCookies } = require('./lib/auth');
const { EventHub } = require('./lib/events');
const { GameManager, START_FEN } = require('./lib/gameManager');
const { isInsufficientMaterial } = require('./lib/rules');
const { moveToSan } = require('./lib/notation');
const { createEmptyTree, addNode, childIdsOf, findChildByUci, uciPathTo, deleteSubtree } = require('./lib/analysisTree');

const PORT = process.env.PORT || 3000;
const ENGINE_PATH = path.join(__dirname, 'engine', 'fairy-stockfish');
const VARIANTS_PATH = path.join(__dirname, 'engine', 'variants.ini');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Analiz tahtasında motorun bir pozisyon için TOPLAM ne kadar düşüneceği ve
// bu düşünme sırasında hangi ARA anlarda (motoru KESİNTİYE UĞRATMADAN, aynı
// aramanın içinde) "şu ana kadar bulduğun en iyi hamle/varyant nedir" diye
// soracağımız (masaüstü/WinForms uygulamasındaki davranışla aynı: motor tek
// seferde giderek derinleşen bir arama yapıyor, biz sadece ara sıra
// çıktısını okuyup istemciye ilerleme olarak gönderiyoruz). Son değer
// (ANALYSIS_TOTAL_MS) toplam düşünme süresi, ondan öncekiler ARA
// güncelleme anları -- bkz. lib/engine.js: analyzeProgressive.
const ANALYSIS_CHECKPOINTS_MS = [1000, 3000, 5000, 7000];
const ANALYSIS_TOTAL_MS = 9000;
// Motorun önerdiği varyant (PV) bazen çok uzun olabiliyor (20-30 yarı hamle);
// bunların HER BİRİNİ gerçek notasyona (SAN) çevirmek için motora ekstra
// sorular sormamız gerekiyor (bkz. pvToSan) — hem gösterimi okunaksız
// yapmamak hem de sunucuyu gereksiz yere meşgul etmemek için sadece ilk
// birkaç hamleyi çeviriyoruz.
const MAX_PV_SAN_PLIES = 10;

const store = new Store();
const sessions = new SessionManager();
const hub = new EventHub();
const engine = new Engine(ENGINE_PATH, VARIANTS_PATH, 'minichess6x6');
// Analiz için tamamen AYRI bir motor süreci: canlı oyunlardaki hamle
// yasallığı kontrolleri hiçbir zaman bir analiz isteğinin arkasında
// beklemesin diye (aksi halde tek bir paylaşılan motor kuyruğu, biri analiz
// yaparken diğer oyuncuların hamlelerini geciktirirdi).
const analysisEngine = new Engine(ENGINE_PATH, VARIANTS_PATH, 'minichess6x6');
// Analiz motoru artık bir pozisyon için TOPLAM 9 saniye (yukarıdaki
// ANALYSIS_TOTAL_MS) boyunca meşgul kalıyor -- bu sırada PV'yi gerçek
// notasyona (SAN) çevirmek için AYNI motora ek sorular (getLegalMoves vb.)
// gönderirsek, bu sorular 9 saniyelik aramanın kuyruğunda bekleyip ARA
// güncellemeleri anlamsız derecede geciktirirdi. Bu yüzden SADECE notasyon
// (SAN) çevirisi için üçüncü, küçük ve her zaman BOŞTA olan ayrı bir motor
// süreci kullanıyoruz.
const notationEngine = new Engine(ENGINE_PATH, VARIANTS_PATH, 'minichess6x6');
let gameManager = null;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Sunucu hata mesajları hâlâ Türkçe metin olarak üretiliyor (aşağıdaki
// gameManager.js/store.js/engine.js'de fırlatılan Error nesneleri VE bu
// dosyadaki doğrulama mesajları) — bunları değiştirmek yerine, istemcinin
// (public/js/i18n.js) o mesajı İNGİLİZCEYE çevirebilmesi için sabit bir
// "errorCode" eşliyoruz. Böylece dil tamamen İSTEMCİ tarafında çözülüyor,
// sunucunun her isteğin dilini bilmesine gerek kalmıyor — `error` alanı
// (Türkçe metin) geriye dönük uyumluluk/loglama için AYNEN kalıyor.
const ERROR_CODES = {
  'Oyun bulunamadı.': 'GAME_NOT_FOUND',
  'Bu oyunun oyuncusu değilsin.': 'NOT_A_PLAYER',
  'Oyun zaten bitmiş.': 'GAME_ALREADY_FINISHED',
  'Sıra sende değil.': 'NOT_YOUR_TURN',
  'Bu hamle yasal değil.': 'ILLEGAL_MOVE',
  'Geçersiz terfi seçimi.': 'INVALID_PROMOTION',
  'Oyun bulunamadı ya da zaten bitmiş.': 'GAME_NOT_FOUND_OR_FINISHED',
  'Yanıtlanacak bir beraberlik teklifi yok.': 'NO_DRAW_OFFER',
  'Bu oyun için yeni oyun teklif edilemez.': 'REMATCH_NOT_AVAILABLE',
  'Zaten devam eden bir oyunun var.': 'ALREADY_IN_GAME',
  'Rakip şu anda başka bir oyunda.': 'OPPONENT_IN_GAME',
  'Yanıtlanacak bir yeni oyun teklifi yok.': 'NO_REMATCH_OFFER',
  'Taraflardan biri zaten başka bir oyunda.': 'PLAYER_IN_ANOTHER_GAME',
  'Geçersiz süre kontrolü.': 'INVALID_TIME_CONTROL',
  'Bu kullanıcı adı zaten alınmış.': 'USERNAME_TAKEN',
  'Kullanıcı adı 3-24 karakter olmalı.': 'USERNAME_LENGTH',
  'Kullanıcı adı geçersiz karakterler içeriyor.': 'USERNAME_INVALID_CHARS',
  'Parola en az 6 karakter olmalı.': 'PASSWORD_TOO_SHORT',
  'Kullanıcı adı ya da parola hatalı.': 'LOGIN_FAILED',
  'Giriş yapmalısın.': 'LOGIN_REQUIRED',
  'Bu oyun için analiz yapılamaz (oyun bitmemiş olabilir ya da bu oyunun oyuncusu değilsin).': 'ANALYSIS_NOT_AVAILABLE_DETAILED',
  'Bu oyun için analiz yapılamaz.': 'ANALYSIS_NOT_AVAILABLE',
  'Motor pozisyonu hesaplayamadı.': 'ENGINE_POSITION_FAILED',
  'Motor çalışmıyor.': 'ENGINE_NOT_RUNNING',
  'Bulunamadı.': 'NOT_FOUND',
  'Geçersiz dil.': 'INVALID_LANGUAGE',
  'Kitap hamlesi silinemez.': 'BOOK_MOVE_UNDELETABLE',
  'Düğüm bulunamadı.': 'NODE_NOT_FOUND',
  // ---- Doğrudan meydan okuma ----
  'Oyuncu bulunamadı.': 'PLAYER_NOT_FOUND',
  'Kendine meydan okuyamazsın.': 'CANNOT_CHALLENGE_SELF',
  'Oyuncu şu anda çevrimiçi değil.': 'PLAYER_NOT_ONLINE',
  'Geçersiz renk seçimi.': 'INVALID_COLOR_CHOICE',
  'Bu meydan okuma artık geçerli değil.': 'CHALLENGE_NOT_FOUND',
  'Bu meydan okumayı yanıtlama yetkin yok.': 'CHALLENGE_NOT_YOURS',
  'Bu meydan okumayı iptal etme yetkin yok.': 'CHALLENGE_CANCEL_NOT_YOURS',
  'Bu oyuncuya şu anda meydan okuyamazsın.': 'OFFER_ON_COOLDOWN',
  // ---- İlk hamle süresi / oyun iptali ----
  'Bu oyun artık iptal edilemez (her iki taraf da ilk hamlesini yaptı).': 'CANNOT_CANCEL_GAME',
  'Siyah ilk hamlesini yapana kadar teslim olunamaz.': 'CANNOT_RESIGN_BEFORE_BLACK_MOVED',
  'Siyah ilk hamlesini yapana kadar beraberlik teklif edilemez.': 'CANNOT_OFFER_DRAW_BEFORE_BLACK_MOVED',
  // ---- Hızlı eşleştirme iptal suistimali ----
  'Art arda çok fazla hızlı eşleştirme oyunu iptal ettiğin için hızlı eşleştirmeyi geçici olarak kullanamıyorsun.': 'QUICK_MATCH_CANCEL_BLOCKED',
  // ---- Beraberlik teklifi sınırları ----
  'Bu oyunda en fazla 5 kez beraberlik teklif edebilirsin.': 'DRAW_OFFER_LIMIT_REACHED',
  'Her 3 hamlelik periyotta en fazla 1 kez beraberlik teklif edebilirsin.': 'DRAW_OFFER_PERIOD_LIMIT',
  // ---- Kullanıcı engelleme ----
  'Kendini engelleyemezsin.': 'CANNOT_BLOCK_SELF',
  'Bu kullanıcı seni engellemiş, ona oyun teklifi gönderemezsin.': 'BLOCKED_BY_TARGET',
  // ---- Mesaj susturma (kullanıcı isteği: chat/seyirci özelliği) ----
  'Kendini susturamazsın.': 'CANNOT_MUTE_SELF',
  // ---- Sohbet / seyirci özelliği (kullanıcı isteği) ----
  'Mesaj boş olamaz.': 'CHAT_EMPTY',
  'Mesaj çok uzun (en fazla 500 karakter).': 'CHAT_TOO_LONG',
  'Rakibin cevap verene kadar art arda en fazla 2 mesaj gönderebilirsin.': 'CHAT_PLAYER_RATE_LIMIT',
  'Başka biri araya mesaj yazana kadar üst üste en fazla 2 mesaj gönderebilirsin.': 'CHAT_SPECTATOR_RATE_LIMIT',
  'Bu oyunda art arda 2 kez reddedildiğin için bu rakibe, bu oyuna özel olarak, artık yeni oyun teklif edemezsin.': 'REMATCH_BLOCKED_FOR_GAME',
};

// Bazı hatalar (yukarıdaki sabit errorCode eşlemesinin YANI SIRA) dinamik
// bir veri de taşır -- ör. "ne kadar süre sonra tekrar deneyebilirsin"
// (retryAfterMs). errJson'un normal 3. parametresi (extra) bunun için;
// bu küçük yardımcı, err nesnesinde .retryAfterMs varsa onu otomatik
// olarak extra'ya ekler (PROMOTION_REQUIRED'daki err.options deseniyle
// aynı mantık).
function errFromException(res, err) {
  const extra = (err && err.retryAfterMs != null) ? { retryAfterMs: err.retryAfterMs } : undefined;
  return errJson(res, 400, err.message, extra);
}

function errJson(res, status, message, extra) {
  const obj = Object.assign({ error: message, errorCode: ERROR_CODES[message] || null }, extra || {});
  return sendJson(res, status, obj);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // basit bir aşırı büyük gövde koruması
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Geçersiz JSON gövdesi.')); }
    });
    req.on('error', reject);
  });
}

function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies['session'];
  if (!token) return null;
  const userId = sessions.getUserId(token);
  if (!userId) return null;
  return store.getUserById(userId);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  // Basit dizin dışına çıkma (path traversal) koruması.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Yasak.'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Bulunamadı.'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Analiz tahtası SADECE bitmiş bir oyun üzerinde çalışır (canlı oyun sırasında
// motor erişimi YASAK ilkesiyle tutarlı). ÖNCEDEN sadece o oyunun
// oyuncularından biri erişebiliyordu -- kullanıcı isteğiyle (seyirci/chat
// özelliği) bu artık İSTEĞE BAĞLI: giriş yapmış HERHANGİ bir kullanıcı bir
// bitmiş oyunun analiz tahtasını (ve dolayısıyla birleşik sohbetini)
// açabilir -- tıpkı /api/game/:id'nin de zaten oyuncu olmayanlara kapalı
// olmaması gibi (bu proje bilerek tamamen açık bir izleme/inceleme modeli
// kullanıyor, bkz. gameManager.js: watchGame). userId parametresi hâlâ
// duruyor (isim de değiştirilmedi, çağrı yerlerinde gereksiz değişiklik
// olmasın diye) ama artık erişimi KISITLAMAK için değil, sadece bilgi amaçlı
// (ör. varyant ağacı hâlâ kullanıcı başına ayrı tutuluyor). Oyun hâlâ
// bellekte (gameManager) olabilir ya da 5 dakikalık pencere geçip diske
// (store) yazılmış olabilir — ikisini de kontrol ediyoruz.
function getFinishedGameForUser(gameId, userId) {
  const live = gameManager.getGame(gameId);
  if (live) {
    if (live.status !== 'finished') return null;
    return {
      startFen: live.startFen,
      movesUci: live.movesUci,
      sanMoves: live.sanMoves,
      whiteId: live.whiteId,
      blackId: live.blackId,
      timeControlCategory: live.timeControlCategory,
      clockHistory: live.clockHistory,
    };
  }
  const persisted = store.getGame(gameId);
  if (persisted) {
    return {
      startFen: persisted.startFen,
      movesUci: persisted.movesUci,
      sanMoves: persisted.sanMoves,
      whiteId: persisted.whiteId,
      blackId: persisted.blackId,
      timeControlCategory: persisted.timeControlCategory,
      clockHistory: persisted.clockHistory,
    };
  }
  return null;
}

// Motorun UCI formatındaki önerilen varyantını (ör. ["e2e4","e7e5","g1f3"])
// GERÇEK satranç notasyonuna (ör. ["e4","e5","Nf3"]) çevirir — hamle
// listesindeki gösterimle (lib/notation.js) BİREBİR AYNI mantık. Motora
// İKİNCİ bir kural motoru olarak sormuyoruz; sadece her ara pozisyonun
// FEN'ini ve o pozisyondaki yasal hamleleri (belirsizlik giderme ve
// şah/mat işareti için) soruyoruz — hamlelerin kendisini zaten motor önerdi.
//
// engineForQueries PARAMETRELİ: analiz motoru (analysisEngine) bir pozisyon
// için TOPLAM 9 saniye boyunca meşgul olabildiğinden (bkz.
// ANALYSIS_TOTAL_MS), ARA güncellemelerin notasyonunu bu motora sormak
// dokuz saniyelik kuyruğun ARKASINDA beklemek anlamına gelirdi -- bu yüzden
// çağıran taraf, arama HÂLÂ SÜRERKEN yapılan ara güncellemeler için her
// zaman BOŞTA olan notationEngine'i, arama BİTTİKTEN SONRAKİ nihai sonuç
// için ise (motor zaten boşaldığından) analysisEngine'i geçirebiliyor.
async function pvToSan(engineForQueries, fenBeforeFirstMove, pvUciMoves) {
  const sanList = [];
  let fen = fenBeforeFirstMove;
  const limited = pvUciMoves.slice(0, MAX_PV_SAN_PLIES);
  let legalAtCurrent;
  try {
    legalAtCurrent = await engineForQueries.getLegalMoves(fen);
  } catch {
    return sanList; // motor cevap veremezse boş liste dön — istemci UCI'ya düşer
  }
  for (const uciMove of limited) {
    let sanBody;
    try {
      sanBody = moveToSan(fen, uciMove, legalAtCurrent);
    } catch {
      break;
    }
    let nextFen;
    try {
      nextFen = await engineForQueries.getFenAfterMoves(fen, [uciMove]);
    } catch {
      nextFen = null;
    }
    if (!nextFen) { sanList.push(sanBody); break; }
    let legalAtNext = [];
    let inCheck = false;
    try {
      legalAtNext = await engineForQueries.getLegalMoves(nextFen);
      inCheck = await engineForQueries.isInCheck(nextFen);
    } catch { /* şah/mat işaretini atlayıp devam edelim */ }
    const suffix = inCheck ? (legalAtNext.length === 0 ? '#' : '+') : '';
    sanList.push(sanBody + suffix);
    fen = nextFen;
    legalAtCurrent = legalAtNext;
  }
  return sanList;
}

// Oyuncu hiç oyun oynamadan da doğrudan "serbest analiz" tahtasını
// açabilsin diye (bkz. analysis.js: gameId olmadığında bu uçlar kullanılıyor)
// -- oynanan hamlelerin (henüz gerçek bir oyuna ait olmadığı için) gerçek
// notasyona (SAN) çevrilmiş halini de burada hesaplıyoruz. Mantık pvToSan
// ile BİREBİR AYNI, tek fark: PV gibi kısa bir öneri değil, kullanıcının o
// ana kadar OYNADIĞI TÜM hamleler (uzunluğu sınırlanmadan, bkz. MAX_PV_SAN_PLIES).
async function freeMovesToSan(uciMoves) {
  const sanList = [];
  let fen = START_FEN;
  let legalAtCurrent;
  try {
    legalAtCurrent = await analysisEngine.getLegalMoves(fen);
  } catch {
    return sanList;
  }
  for (const uciMove of uciMoves) {
    let sanBody;
    try {
      sanBody = moveToSan(fen, uciMove, legalAtCurrent);
    } catch {
      break;
    }
    let nextFen;
    try {
      nextFen = await analysisEngine.getFenAfterMoves(fen, [uciMove]);
    } catch {
      nextFen = null;
    }
    if (!nextFen) { sanList.push(sanBody); break; }
    let legalAtNext = [];
    let inCheck = false;
    try {
      legalAtNext = await analysisEngine.getLegalMoves(nextFen);
      inCheck = await analysisEngine.isInCheck(nextFen);
    } catch { /* şah/mat işaretini atlayıp devam edelim */ }
    const suffix = inCheck ? (legalAtNext.length === 0 ? '#' : '+') : '';
    sanList.push(sanBody + suffix);
    fen = nextFen;
    legalAtCurrent = legalAtNext;
  }
  return sanList;
}

// ---- Analiz tahtası VARYANT AĞACI (lichess tarzı) yardımcıları ----
// Ağacın kendisi (düğüm ekleme/silme/yol bulma) lib/analysisTree.js'de saf
// veri yapısı olarak yaşıyor; burada sadece motora (FEN/SAN/yasallık) ihtiyaç
// duyan kısımları -- yeni bir hamle eklerken doğrulama ve notasyon üretimi --
// ve store.js kalıcılığını (yükle/kaydet) bir araya getiriyoruz.

function analysisScopeKey(userId, gameId) {
  return gameId ? `game:${gameId}:${userId}` : `free:${userId}`;
}

// scopeKey'e ait ağacı diskten yükler; hiç yoksa YENİ bir ağaç oluşturur.
// gameId'li (oyun-bazlı) analizde, ağaç İLK KEZ oluşturulurken gerçek oyunun
// hamleleri "isBook:true" olarak zincire tohumlanır (bookMovesUci/bookSanMoves)
// -- böylece oyuncu daha sonra geri dönüp ağacı açtığında gerçek oyunun
// hamleleri hep orada olur ve SİLİNEMEZ (bkz. deleteNodeFromTree). Ağaç zaten
// varsa (daha önce en az bir kez kaydedilmişse) bookMovesUci'ye BAKILMAZ --
// zaten oradaki isBook zinciri korunuyor.
function getOrCreateAnalysisTree(scopeKey, startFen, bookMovesUci, bookSanMoves) {
  let tree = store.getAnalysisTree(scopeKey);
  if (tree) return tree;
  tree = createEmptyTree(startFen);
  if (bookMovesUci && bookMovesUci.length) {
    let parentId = null;
    for (let i = 0; i < bookMovesUci.length; i++) {
      const node = addNode(tree, { parentId, uci: bookMovesUci[i], san: (bookSanMoves && bookSanMoves[i]) || bookMovesUci[i], isBook: true });
      parentId = node.id;
    }
  }
  store.saveAnalysisTree(scopeKey, tree);
  return tree;
}

// parentId düğümünün altına (kökse null) yeni bir hamle (uci) ekler. Aynı
// ebeveynin altında aynı uci zaten varsa (istemci aynı hamleyi iki kez
// gönderirse -- ör. sayfa yeniden yüklendi) MEVCUT düğüm döndürülür, çift
// varyant OLUŞTURULMAZ (idempotent). Yasallık + SAN üretimi pvToSan/
// freeMovesToSan ile BİREBİR AYNI mantıkla, tek seferde bir hamle için yapılır.
// ÖNEMLİ: burada analysisEngine YERİNE notationEngine kullanıyoruz.
// analysisEngine, bir pozisyon için TOPLAM 9 SANİYE (kesintisiz)
// meşgul olabiliyor (bkz. ANALYSIS_TOTAL_MS) -- kullanıcı bu 9 saniye
// SÜRERKEN tahtaya tıklayıp yeni bir hamle denerse (çok normal bir
// senaryo), bu hamlenin ağaca eklenmesi analysisEngine'in kuyruğunun
// EN SONUNA düşerdi ve neredeyse 9 saniyeye kadar "asılı" kalırdı --
// arayüz donmuş gibi görünürdü. notationEngine HER ZAMAN BOŞTA
// tutulduğu için (bkz. pvToSan/sendChunk'taki aynı mantık) bu doğrulama
// hep ANINDA sonuçlanıyor.
async function addMoveToTree(scopeKey, tree, parentId, uci) {
  const existing = findChildByUci(tree, parentId || null, uci);
  if (existing) return existing;
  const priorMoves = uciPathTo(tree, parentId || null);
  const fenBefore = await notationEngine.getFenAfterMoves(tree.startFen, priorMoves);
  if (!fenBefore) throw new Error('Motor pozisyonu hesaplayamadı.');
  const legalMoves = await notationEngine.getLegalMoves(fenBefore);
  if (!legalMoves.includes(uci)) throw new Error('Bu hamle yasal değil.');
  const sanBody = moveToSan(fenBefore, uci, legalMoves);
  let suffix = '';
  const fenAfter = await notationEngine.getFenAfterMoves(fenBefore, [uci]);
  if (fenAfter) {
    try {
      const legalAfter = await notationEngine.getLegalMoves(fenAfter);
      const inCheck = await notationEngine.isInCheck(fenAfter);
      suffix = inCheck ? (legalAfter.length === 0 ? '#' : '+') : '';
    } catch { /* şah/mat işaretini atlayıp devam edelim */ }
  }
  const node = addNode(tree, { parentId: parentId || null, uci, san: sanBody + suffix, isBook: false });
  store.saveAnalysisTree(scopeKey, tree);
  return node;
}

// parentId'den başlayıp uciList'teki hamleleri SIRAYLA ağaca ekler (motorun
// önerdiği bir varyantın TAMAMINI tek seferde uygulamak için) -- her adımda
// addMoveToTree'nin aynı dedupe/doğrulama mantığını kullanır, oluşan/bulunan
// düğümlerin id DİZİSİNİ (yeni "yol" -- currentPath'e eklenecek kısım) döndürür.
async function addLineToTree(scopeKey, tree, parentId, uciList) {
  const newPath = [];
  let cur = parentId || null;
  for (const uci of uciList) {
    const node = await addMoveToTree(scopeKey, tree, cur, uci);
    newPath.push(node.id);
    cur = node.id;
  }
  return newPath;
}

// Bir düğümü (ve tüm alt ağacını) siler -- ama önce (VE alt ağacındaki HİÇBİR
// düğüm) isBook değilse. Kullanıcı gerçek oyunun hamlelerini SİLEMEZ; kendi
// eklediği bir varyantı (o varyantın altında oynadığı devam hamleleriyle
// birlikte) istediği zaman silebilir.
function deleteNodeFromTree(scopeKey, tree, nodeId) {
  const node = tree.nodes[nodeId];
  if (!node) throw new Error('Düğüm bulunamadı.');
  if (node.isBook) throw new Error('Kitap hamlesi silinemez.');
  deleteSubtree(tree, nodeId);
  store.saveAnalysisTree(scopeKey, tree);
}

// Bir pozisyonu MOTORUN KESİNTİSİZ 9 SANİYE DÜŞÜNMESİYLE değerlendirir ve
// sonucu istemciye TEK bir HTTP yanıtı üzerinden, satır satır (NDJSON --
// "newline-delimited JSON") AKIŞ halinde gönderir: ANALYSIS_CHECKPOINTS_MS
// (1/3/5/7. saniyeler) her birinde o ana kadar bulunan en iyi hamle/skor/
// varyantı bir ARA GÜNCELLEME satırı olarak, ANALYSIS_TOTAL_MS (9.
// saniye) sonunda ise NİHAİ sonucu ({..., final:true}) yazıyoruz. Böylece
// istemcideki "en iyi hamle" oku ve PV kutucuğu, motor HÂLÂ düşünürken
// birden çok kez güncellenebiliyor -- masaüstü/WinForms uygulamasındaki
// davranışla aynı fikir: motor TEK bir kesintisiz aramayla giderek daha
// isabetli hamleler buluyor, biz sadece ara sıra çıktısını okuyoruz.
//
// İstemci bu isteği iptal ederse (ör. kullanıcı başka bir pozisyona geçtiği
// için fetch'i abort ettiyse), req'in 'close' olayı üzerinden motora ERKEN
// durmasını söylüyoruz (cancelTask) -- böylece analysisEngine'in kuyruğu
// artık kimsenin beklemediği bir hesaplamayla gereksiz yere 9 saniye MEŞGUL
// kalmıyor (aksi halde sonraki her navigasyon 9 saniyeye kadar birikirdi).
async function streamAnalysisEvaluate(req, res, startFen, moveList) {
  let fen;
  try {
    fen = await analysisEngine.getFenAfterMoves(startFen, moveList);
  } catch (err) {
    return errJson(res, 500, err.message);
  }
  if (!fen) return errJson(res, 500, 'Motor pozisyonu hesaplayamadı.');
  const whiteToMove = fen.includes(' w ');

  let legalMoves;
  try {
    legalMoves = await analysisEngine.getLegalMoves(fen);
  } catch (err) {
    return errJson(res, 500, err.message);
  }

  if (legalMoves.length === 0) {
    return sendJson(res, 200, { fen, whiteToMove, noLegalMoves: true, insufficientMaterial: false, result: null, final: true });
  }
  if (isInsufficientMaterial(fen)) {
    return sendJson(res, 200, { fen, whiteToMove, noLegalMoves: false, insufficientMaterial: true, result: null, final: true });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
  });

  // Ara güncellemelerin SAN çevirisi asenkron olduğundan (notationEngine'e
  // birkaç istek atıyor), yazmaları bu zincirle SIRALI tutuyoruz -- yoksa
  // iki güncelleme üst üste binip NDJSON satırları karışabilir.
  let writeChain = Promise.resolve();
  const sendChunk = (result, isFinal, engineForSan) => {
    writeChain = writeChain.then(async () => {
      if (res.writableEnded) return;
      let sanPv = [];
      if (result && result.pv && result.pv.length) {
        try { sanPv = await pvToSan(engineForSan, fen, result.pv); } catch { sanPv = []; }
      }
      if (res.writableEnded) return;
      const payload = {
        fen, whiteToMove, noLegalMoves: false, insufficientMaterial: false,
        result: result ? Object.assign({}, result, { sanPv }) : null,
        final: isFinal,
      };
      try { res.write(JSON.stringify(payload) + '\n'); } catch { /* bağlantı zaten kapanmışsa yoksay */ }
      if (isFinal && !res.writableEnded) res.end();
    });
  };

  const { token, promise } = analysisEngine.analyzeProgressive(
    fen,
    ANALYSIS_CHECKPOINTS_MS,
    ANALYSIS_TOTAL_MS,
    // ARA güncellemelerin notasyonu HER ZAMAN BOŞTA olan notationEngine'den
    // geliyor -- analysisEngine bu sırada zaten 9 saniyelik aramayla meşgul.
    (partial) => sendChunk(partial, false, notationEngine)
  );

  // ÖNEMLİ: burada req.on('close') DEĞİL, res.on('close') dinliyoruz.
  // Ölçerek doğruladık: bu noktaya gelmeden önce istek gövdesi zaten
  // tamamen okunmuş (readBody) olduğundan, req'in 'close' olayı istemci
  // bağlantıyı erken keserse (fetch abort) GÜVENİLİR şekilde ATEŞLENMİYOR
  // -- res'in 'close' olayı ise (yanıt daha tamamlanmadan bağlantı
  // koptuğunda) her durumda güvenilir şekilde tetikleniyor.
  const onClose = () => {
    if (!res.writableEnded) analysisEngine.cancelTask(token);
  };
  res.on('close', onClose);

  try {
    const finalResult = await promise;
    // Arama artık BİTTİĞİ (motor boşaldığı) için nihai sonucun notasyonunu
    // analysisEngine'in kendisinden isteyebiliyoruz.
    sendChunk(finalResult, true, analysisEngine);
  } catch (err) {
    if (!res.writableEnded) {
      try {
        res.write(JSON.stringify({ fen, whiteToMove, noLegalMoves: false, insufficientMaterial: false, result: null, final: true, error: err.message }) + '\n');
      } catch { /* yazma başarısız olursa (bağlantı zaten kapanmışsa) yoksay */ }
      res.end();
    }
  } finally {
    res.removeListener('close', onClose);
  }
}

async function handleApi(req, res, pathname, url) {
  // ---- Kimlik doğrulama gerektirmeyen uçlar ----
  if (pathname === '/api/register' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    if (!username || typeof username !== 'string' || username.length < 3 || username.length > 24) {
      return errJson(res, 400, 'Kullanıcı adı 3-24 karakter olmalı.');
    }
    if (!/^[a-zA-Z0-9_şŞıİöÖüÜçÇğĞ]+$/.test(username)) {
      return errJson(res, 400, 'Kullanıcı adı geçersiz karakterler içeriyor.');
    }
    if (!password || password.length < 6) {
      return errJson(res, 400, 'Parola en az 6 karakter olmalı.');
    }
    try {
      const { salt, passwordHash } = hashPassword(password);
      const user = store.createUser({ username, passwordHash, salt });
      const token = sessions.createSession(user.id);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
      return sendJson(res, 200, { id: user.id, username: user.username, ratings: user.ratings, language: user.language || 'tr' });
    } catch (err) {
      return errJson(res, 400, err.message);
    }
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const user = store.getUserByUsername(username || '');
    if (!user || !verifyPassword(password || '', user.salt, user.passwordHash)) {
      return errJson(res, 401, 'Kullanıcı adı ya da parola hatalı.');
    }
    const token = sessions.createSession(user.id);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
    return sendJson(res, 200, { id: user.id, username: user.username, ratings: user.ratings, language: user.language || 'tr' });
  }

  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    // Elo puanı kategoriye göre AYRI olduğu için liderlik tablosu da tek bir
    // kategoriye göre sıralanıyor (?category=bullet|blitz|rapid|classical).
    const requestedCategory = url.searchParams.get('category');
    const category = RATING_CATEGORIES.includes(requestedCategory) ? requestedCategory : 'bullet';
    return sendJson(res, 200, { category, leaderboard: store.leaderboard(category, 20) });
  }

  if (pathname === '/api/time-controls' && req.method === 'GET') {
    return sendJson(res, 200, { timeControls: gameManager.timeControls() });
  }

  // ---- Aşağıdakiler için giriş yapılmış olmak gerekiyor ----
  const user = getUserFromRequest(req);
  if (!user) return errJson(res, 401, 'Giriş yapmalısın.');

  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    if (cookies['session']) sessions.destroySession(cookies['session']);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    return sendJson(res, 200, {
      id: user.id, username: user.username, ratings: user.ratings,
      wins: user.wins, losses: user.losses, draws: user.draws,
      language: user.language || 'tr',
    });
  }

  // Arayüz dili tercihini ('tr' | 'en') HESABA kaydeder — böylece kullanıcı
  // başka bir cihaz/tarayıcıdan giriş yaptığında da (o cihazın çerezinden
  // bağımsız olarak) aynı dil otomatik uygulanır (bkz. public/js/i18n.js:
  // setLang → persist, ve login/register/me cevaplarındaki "language" alanı).
  if (pathname === '/api/set-language' && req.method === 'POST') {
    const { language } = await readBody(req);
    if (language !== 'tr' && language !== 'en') {
      return errJson(res, 400, 'Geçersiz dil.');
    }
    store.setUserLanguage(user.id, language);
    return sendJson(res, 200, { ok: true, language });
  }

  if (pathname === '/api/my-games' && req.method === 'GET') {
    return sendJson(res, 200, { games: store.recentGamesForUser(user.id, 20) });
  }

  if (pathname === '/api/my-active-game' && req.method === 'GET') {
    return sendJson(res, 200, { gameId: gameManager.activeGameId(user.id) });
  }

  // ---- Oyunsuz "serbest analiz" tahtası ----
  // Oyuncu hiç oyun oynamadan da analiz tahtasını başlangıç pozisyonundan
  // açabilsin diye eklendi -- aşağıdaki üç uç, /api/game/:id/analysis-*
  // uçlarıyla AYNI mantığı (analysisEngine üzerinden FEN/legal-move/eval
  // hesaplama) kullanıyor, ama gerçek bir oyuna (ve o oyunun oyuncusu olma
  // şartına) BAĞLI DEĞİL -- her zaman START_FEN'den başlıyor.
  if (pathname === '/api/free-analysis-start' && req.method === 'GET') {
    return sendJson(res, 200, {
      startFen: START_FEN,
      movesUci: [],
      sanMoves: [],
      whiteId: null,
      blackId: null,
      // Sabit "Beyaz"/"Siyah" METNİ göndermek yerine null bırakıyoruz --
      // istemci (analysis.js) bir oyuncunun gerçek kullanıcı adı olmadığını
      // gördüğünde, o anki arayüz diline göre "Beyaz"/"White" veya
      // "Siyah"/"Black" yazısını KENDİSİ üretiyor (bkz. public/js/i18n.js).
      whiteUsername: null,
      blackUsername: null,
      whiteRating: null,
      blackRating: null,
      timeControlCategory: null,
      clockHistory: [],
    });
  }

  if (pathname === '/api/free-analysis-position' && req.method === 'POST') {
    const { moves } = await readBody(req);
    const moveList = Array.isArray(moves) ? moves : [];
    try {
      const fen = await analysisEngine.getFenAfterMoves(START_FEN, moveList);
      if (!fen) return errJson(res, 500, 'Motor pozisyonu hesaplayamadı.');
      const legalMoves = await analysisEngine.getLegalMoves(fen);
      const inCheck = await analysisEngine.isInCheck(fen);
      // Serbest analizde sabit bir "kitap" (gerçek oyun) olmadığı için,
      // istemcinin hamle listesini gösterebilmesi adına o ana kadar oynanan
      // hamlelerin GERÇEK notasyonunu (SAN) da burada hesaplayıp gönderiyoruz
      // (oyun-bazlı analizde bu bilgi zaten analysis-start'ta bir kereye
      // mahsus, sabit bir oyunun hamleleri için geliyordu).
      const sanMoves = await freeMovesToSan(moveList);
      return sendJson(res, 200, { fen, legalMoves, whiteToMove: fen.includes(' w '), inCheck, sanMoves });
    } catch (err) {
      return errJson(res, 500, err.message);
    }
  }

  if (pathname === '/api/free-analysis-evaluate' && req.method === 'POST') {
    const { moves } = await readBody(req);
    const moveList = Array.isArray(moves) ? moves : [];
    return streamAnalysisEvaluate(req, res, START_FEN, moveList);
  }

  // ---- Serbest analiz VARYANT AĞACI (kalıcı -- kullanıcı başına tek taslak) ----
  if (pathname === '/api/free-analysis-tree' && req.method === 'GET') {
    const scopeKey = analysisScopeKey(user.id, null);
    const tree = getOrCreateAnalysisTree(scopeKey, START_FEN, null, null);
    return sendJson(res, 200, { tree });
  }

  if (pathname === '/api/free-analysis-tree/add-move' && req.method === 'POST') {
    const scopeKey = analysisScopeKey(user.id, null);
    const tree = getOrCreateAnalysisTree(scopeKey, START_FEN, null, null);
    const { parentId, uci } = await readBody(req);
    try {
      const node = await addMoveToTree(scopeKey, tree, parentId || null, uci);
      return sendJson(res, 200, { tree, nodeId: node.id });
    } catch (err) { return errJson(res, 400, err.message); }
  }

  if (pathname === '/api/free-analysis-tree/add-line' && req.method === 'POST') {
    const scopeKey = analysisScopeKey(user.id, null);
    const tree = getOrCreateAnalysisTree(scopeKey, START_FEN, null, null);
    const { parentId, uciList } = await readBody(req);
    const list = Array.isArray(uciList) ? uciList : [];
    try {
      const path = await addLineToTree(scopeKey, tree, parentId || null, list);
      return sendJson(res, 200, { tree, path });
    } catch (err) { return errJson(res, 400, err.message); }
  }

  if (pathname === '/api/free-analysis-tree/delete-node' && req.method === 'POST') {
    const scopeKey = analysisScopeKey(user.id, null);
    const tree = getOrCreateAnalysisTree(scopeKey, START_FEN, null, null);
    const { nodeId } = await readBody(req);
    try {
      deleteNodeFromTree(scopeKey, tree, nodeId);
      return sendJson(res, 200, { tree });
    } catch (err) { return errJson(res, 400, err.message); }
  }

  if (pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(': bağlantı açıldı\n\n');
    hub.addClient(user.id, res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 25000);
    req.on('close', () => {
      clearInterval(keepAlive);
      hub.removeClient(user.id, res);
    });
    return;
  }

  if (pathname === '/api/queue/join' && req.method === 'POST') {
    const { timeControlKey } = await readBody(req);
    try {
      gameManager.joinQueue(user.id, timeControlKey);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      // errFromException kullanıyoruz -- hızlı eşleştirme iptal suistimali
      // cezası (QUICK_MATCH_CANCEL_BLOCKED) retryAfterMs taşıyor, istemci
      // bunu "kaç saat/dakika sonra tekrar dene" şeklinde göstermek için
      // kullanıyor (bkz. public/js/i18n.js: describeOfferError).
      return errFromException(res, err);
    }
  }

  if (pathname === '/api/queue/leave' && req.method === 'POST') {
    gameManager.leaveQueue(user.id);
    return sendJson(res, 200, { ok: true });
  }

  // ---- Doğrudan meydan okuma (belirli, o an çevrimiçi olan bir oyuncuya) ----
  if (pathname === '/api/challenge/send' && req.method === 'POST') {
    const { username, timeControlKey, color, ranked } = await readBody(req);
    try {
      const result = gameManager.createChallenge(user.id, username, timeControlKey, color, ranked !== false);
      return sendJson(res, 200, Object.assign({ ok: true }, result));
    } catch (err) {
      return errFromException(res, err);
    }
  }

  if (pathname === '/api/challenge/respond' && req.method === 'POST') {
    const { challengeId, accept } = await readBody(req);
    try {
      const result = gameManager.respondChallenge(challengeId, user.id, !!accept);
      return sendJson(res, 200, result);
    } catch (err) {
      return errJson(res, 400, err.message);
    }
  }

  if (pathname === '/api/challenge/cancel' && req.method === 'POST') {
    const { challengeId } = await readBody(req);
    try {
      const result = gameManager.cancelChallenge(challengeId, user.id);
      return sendJson(res, 200, result);
    } catch (err) {
      return errJson(res, 400, err.message);
    }
  }

  // ---- Kullanıcı engelleme (kullanıcı isteği) ----
  if (pathname === '/api/block/list' && req.method === 'GET') {
    return sendJson(res, 200, { usernames: gameManager.listBlockedUsers(user.id) });
  }

  if (pathname === '/api/block/add' && req.method === 'POST') {
    const { username } = await readBody(req);
    try {
      const result = gameManager.blockUser(user.id, username);
      return sendJson(res, 200, result);
    } catch (err) {
      return errJson(res, 400, err.message);
    }
  }

  if (pathname === '/api/block/remove' && req.method === 'POST') {
    const { username } = await readBody(req);
    try {
      const result = gameManager.unblockUser(user.id, username);
      return sendJson(res, 200, result);
    } catch (err) {
      return errJson(res, 400, err.message);
    }
  }

  // ---- Mesaj susturma (kullanıcı isteği: chat/seyirci özelliği) ----
  // Komple engellemeden (yukarısı) TAMAMEN AYRI -- sadece o kullanıcının
  // mesajlarını (hangi sohbette olursa olsun) gizler, oyun teklifi/hızlı
  // eşleştirme gibi hiçbir şeyi etkilemez (bkz. gameManager.js: muteUser).
  if (pathname === '/api/mute/list' && req.method === 'GET') {
    return sendJson(res, 200, { usernames: gameManager.listMutedUsers(user.id) });
  }

  if (pathname === '/api/mute/add' && req.method === 'POST') {
    const { username } = await readBody(req);
    try {
      const result = gameManager.muteUser(user.id, username);
      return sendJson(res, 200, result);
    } catch (err) {
      return errJson(res, 400, err.message);
    }
  }

  if (pathname === '/api/mute/remove' && req.method === 'POST') {
    const { username } = await readBody(req);
    try {
      const result = gameManager.unmuteUser(user.id, username);
      return sendJson(res, 200, result);
    } catch (err) {
      return errJson(res, 400, err.message);
    }
  }

  const gameIdMatch = pathname.match(/^\/api\/game\/([^/]+)(\/.*)?$/);
  if (gameIdMatch) {
    const gameId = gameIdMatch[1];
    const sub = gameIdMatch[2] || '';

    if (sub === '' && req.method === 'GET') {
      const live = gameManager.getGame(gameId);
      if (live) {
        const state = gameManager.publicState(live);
        // İstemcinin oyuncu isimlerini VE isimlerin yanında gösterilecek
        // Elo puanlarını (bu oyunun süre kontrolü kategorisine ait) da
        // ekliyoruz — bu bilgiler motor/oyun mantığı tarafında değil,
        // kullanıcı kayıtlarında (store) tutuluyor.
        const whiteUser = store.getUserById(state.whiteId);
        const blackUser = store.getUserById(state.blackId);
        const category = state.timeControlCategory || 'bullet';
        state.whiteUsername = whiteUser?.username || '?';
        state.blackUsername = blackUser?.username || '?';
        state.whiteRating = whiteUser?.ratings?.[category] ?? 1500;
        state.blackRating = blackUser?.ratings?.[category] ?? 1500;
        return sendJson(res, 200, { live: true, state });
      }
      const finished = store.getGame(gameId);
      if (finished) {
        // Bitmiş/kalıcı hale gelmiş bir oyun için de aynı şekilde GÜNCEL
        // (bu oyundan sonraki) Elo puanlarını ekliyoruz — store kopyasını
        // değiştirmemek için yeni bir nesneye kopyalıyoruz.
        const category = finished.timeControlCategory || 'bullet';
        const whiteUser = store.getUserById(finished.whiteId);
        const blackUser = store.getUserById(finished.blackId);
        const state = Object.assign({}, finished, {
          whiteRating: whiteUser?.ratings?.[category] ?? 1500,
          blackRating: blackUser?.ratings?.[category] ?? 1500,
        });
        return sendJson(res, 200, { live: false, state });
      }
      return errJson(res, 404, 'Oyun bulunamadı.');
    }

    if (sub === '/legal-moves' && req.method === 'GET') {
      try {
        const moves = await gameManager.legalMoves(gameId, user.id);
        return sendJson(res, 200, { moves });
      } catch (err) {
        return errJson(res, 400, err.message);
      }
    }

    if (sub === '/move' && req.method === 'POST') {
      const { from, to, promotion } = await readBody(req);
      try {
        const state = await gameManager.applyMove(gameId, user.id, from, to, promotion);
        return sendJson(res, 200, { state });
      } catch (err) {
        if (err.code === 'PROMOTION_REQUIRED') {
          return errJson(res, 409, 'PROMOTION_REQUIRED', { options: err.options });
        }
        return errJson(res, 400, err.message);
      }
    }

    if (sub === '/resign' && req.method === 'POST') {
      try { return sendJson(res, 200, { state: gameManager.resign(gameId, user.id) }); }
      catch (err) { return errJson(res, 400, err.message); }
    }

    if (sub === '/cancel' && req.method === 'POST') {
      try { return sendJson(res, 200, gameManager.cancelGame(gameId, user.id)); }
      catch (err) { return errJson(res, 400, err.message); }
    }

    if (sub === '/offer-draw' && req.method === 'POST') {
      try { return sendJson(res, 200, { state: gameManager.offerDraw(gameId, user.id) }); }
      catch (err) { return errJson(res, 400, err.message); }
    }

    if (sub === '/respond-draw' && req.method === 'POST') {
      const { accept } = await readBody(req);
      try { return sendJson(res, 200, { state: gameManager.respondDraw(gameId, user.id, !!accept) }); }
      catch (err) { return errJson(res, 400, err.message); }
    }

    if (sub === '/offer-rematch' && req.method === 'POST') {
      try { return sendJson(res, 200, { state: gameManager.offerRematch(gameId, user.id) }); }
      catch (err) { return errFromException(res, err); }
    }

    if (sub === '/respond-rematch' && req.method === 'POST') {
      const { accept } = await readBody(req);
      try { return sendJson(res, 200, { state: gameManager.respondRematch(gameId, user.id, !!accept) }); }
      catch (err) { return errJson(res, 400, err.message); }
    }

    // ---- Seyirci kaydı (kullanıcı isteği) ----
    // Bir sayfa (canlı oyun EKRANI ya da bitmiş oyunun analiz tahtası)
    // açıldığında/kapatıldığında çağrılır -- gerçek zamanlı sohbet
    // yayınının (bkz. gameManager.js: _broadcastChat) kime gideceğini
    // belirler. Oyuncular DA bu uçları çağırır (kendi oyunlarını izliyor
    // sayılırlar) -- zararı yok, sadece Set'e ekleme.
    if (sub === '/watch' && req.method === 'POST') {
      try { gameManager.watchGame(gameId, user.id); return sendJson(res, 200, { ok: true }); }
      catch (err) { return errJson(res, 404, err.message); }
    }

    if (sub === '/unwatch' && req.method === 'POST') {
      gameManager.unwatchGame(gameId, user.id);
      return sendJson(res, 200, { ok: true });
    }

    // ---- Sohbet (kullanıcı isteği: chat/seyirci özelliği) ----
    // GET: bu kullanıcının bu oyun için görebileceği sohbet(ler)i döner
    // (canlıyken oyuncu/seyirci ayrı, bittikten sonra tek birleşik sohbet --
    // bkz. gameManager.js: getChat). POST: yeni bir mesaj gönderir; hangi
    // sohbete (oyuncu/seyirci/birleşik) gideceğini ve art arda mesaj
    // sınırını sunucu KENDİSİ belirler (bkz. sendChat) -- istemci sadece
    // metni gönderir.
    if (sub === '/chat' && req.method === 'GET') {
      try { return sendJson(res, 200, gameManager.getChat(gameId, user.id)); }
      catch (err) { return errJson(res, 404, err.message); }
    }

    if (sub === '/chat' && req.method === 'POST') {
      const { text } = await readBody(req);
      try { return sendJson(res, 200, gameManager.sendChat(gameId, user.id, text)); }
      catch (err) { return errJson(res, 400, err.message); }
    }

    // ---- Oyun sonrası analiz tahtası ----
    // Not: bu üçü SADECE bitmiş bir oyunun oyuncularına açık (yukarıdaki
    // getFinishedGameForUser) ve CANLI OYUN motorundan (const engine) tamamen
    // ayrı bir motor süreci (analysisEngine) kullanıyor.

    if (sub === '/analysis-start' && req.method === 'GET') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return errJson(res, 403, 'Bu oyun için analiz yapılamaz (oyun bitmemiş olabilir ya da bu oyunun oyuncusu değilsin).');
      const whiteUser = store.getUserById(info.whiteId);
      const blackUser = store.getUserById(info.blackId);
      // Elo puanı kategoriye göre ayrı tutuluyor (bkz. store.js) — isimlerin
      // yanında gösterilecek puan da bu oyunun kategorisine ait olmalı.
      const category = info.timeControlCategory || 'bullet';
      return sendJson(res, 200, {
        startFen: info.startFen,
        movesUci: info.movesUci,
        sanMoves: info.sanMoves,
        whiteId: info.whiteId,
        blackId: info.blackId,
        whiteUsername: whiteUser?.username || '?',
        blackUsername: blackUser?.username || '?',
        whiteRating: whiteUser?.ratings?.[category] ?? 1500,
        blackRating: blackUser?.ratings?.[category] ?? 1500,
        timeControlCategory: info.timeControlCategory,
        // İstemcinin, gezinilen her pozisyonda "o hamlede saatler ne
        // kadardı" gösterebilmesi için tüm saat geçmişi (bkz. gameManager.js).
        clockHistory: info.clockHistory || [],
      });
    }

    if (sub === '/analysis-position' && req.method === 'POST') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return errJson(res, 403, 'Bu oyun için analiz yapılamaz.');
      const { moves } = await readBody(req);
      const moveList = Array.isArray(moves) ? moves : [];
      try {
        const fen = await analysisEngine.getFenAfterMoves(info.startFen, moveList);
        if (!fen) return errJson(res, 500, 'Motor pozisyonu hesaplayamadı.');
        const legalMoves = await analysisEngine.getLegalMoves(fen);
        // İstemcinin, tehdit altındaki şahın karesini kırmızı gösterebilmesi
        // için bu pozisyonda şah çekiliyor mu bilgisi de dönüyor.
        const inCheck = await analysisEngine.isInCheck(fen);
        return sendJson(res, 200, { fen, legalMoves, whiteToMove: fen.includes(' w '), inCheck });
      } catch (err) {
        return errJson(res, 500, err.message);
      }
    }

    if (sub === '/analysis-evaluate' && req.method === 'POST') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return errJson(res, 403, 'Bu oyun için analiz yapılamaz.');
      const { moves } = await readBody(req);
      const moveList = Array.isArray(moves) ? moves : [];
      return streamAnalysisEvaluate(req, res, info.startFen, moveList);
    }

    // ---- Oyun-bazlı analiz VARYANT AĞACI (kalıcı -- bu oyunu analiz eden bu
    // kullanıcıya özel) -- ağaç ilk açıldığında gerçek oyunun hamleleri
    // isBook:true olarak tohumlanır (bkz. getOrCreateAnalysisTree).
    if (sub === '/analysis-tree' && req.method === 'GET') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return errJson(res, 403, 'Bu oyun için analiz yapılamaz.');
      const scopeKey = analysisScopeKey(user.id, gameId);
      const tree = getOrCreateAnalysisTree(scopeKey, info.startFen, info.movesUci, info.sanMoves);
      return sendJson(res, 200, { tree });
    }

    if (sub === '/analysis-tree/add-move' && req.method === 'POST') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return errJson(res, 403, 'Bu oyun için analiz yapılamaz.');
      const scopeKey = analysisScopeKey(user.id, gameId);
      const tree = getOrCreateAnalysisTree(scopeKey, info.startFen, info.movesUci, info.sanMoves);
      const { parentId, uci } = await readBody(req);
      try {
        const node = await addMoveToTree(scopeKey, tree, parentId || null, uci);
        return sendJson(res, 200, { tree, nodeId: node.id });
      } catch (err) { return errJson(res, 400, err.message); }
    }

    if (sub === '/analysis-tree/add-line' && req.method === 'POST') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return errJson(res, 403, 'Bu oyun için analiz yapılamaz.');
      const scopeKey = analysisScopeKey(user.id, gameId);
      const tree = getOrCreateAnalysisTree(scopeKey, info.startFen, info.movesUci, info.sanMoves);
      const { parentId, uciList } = await readBody(req);
      const list = Array.isArray(uciList) ? uciList : [];
      try {
        const path = await addLineToTree(scopeKey, tree, parentId || null, list);
        return sendJson(res, 200, { tree, path });
      } catch (err) { return errJson(res, 400, err.message); }
    }

    if (sub === '/analysis-tree/delete-node' && req.method === 'POST') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return errJson(res, 403, 'Bu oyun için analiz yapılamaz.');
      const scopeKey = analysisScopeKey(user.id, gameId);
      const tree = getOrCreateAnalysisTree(scopeKey, info.startFen, info.movesUci, info.sanMoves);
      const { nodeId } = await readBody(req);
      try {
        deleteNodeFromTree(scopeKey, tree, nodeId);
        return sendJson(res, 200, { tree });
      } catch (err) { return errJson(res, 400, err.message); }
    }
  }

  return errJson(res, 404, 'Bulunamadı.');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/') || pathname === '/events') {
    try {
      await handleApi(req, res, pathname, url);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: 'Sunucu hatası: ' + err.message });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

async function main() {
  console.log('Fairy-Stockfish motoru başlatılıyor...');
  await engine.start();
  console.log('Motor hazır. Başlangıç pozisyonu doğrulanıyor...');
  const checkFen = await engine.getFenAfterMoves(START_FEN, []);
  if (!checkFen) throw new Error('Motor başlangıç pozisyonunu doğrulayamadı — variants.ini yolunu kontrol et.');
  console.log('Doğrulandı:', checkFen);

  console.log('Analiz motoru başlatılıyor...');
  await analysisEngine.start();
  console.log('Analiz motoru hazır.');

  console.log('Notasyon (SAN çevirisi) motoru başlatılıyor...');
  await notationEngine.start();
  console.log('Notasyon motoru hazır.');

  gameManager = new GameManager(engine, store, hub);

  server.listen(PORT, () => {
    console.log(`6x6 Satranç Online sunucusu http://localhost:${PORT} adresinde çalışıyor`);
  });
}

main().catch(err => {
  console.error('Sunucu başlatılamadı:', err);
  process.exit(1);
});

process.on('SIGINT', () => { engine.quit(); analysisEngine.quit(); notationEngine.quit(); process.exit(0); });
process.on('SIGTERM', () => { engine.quit(); analysisEngine.quit(); notationEngine.quit(); process.exit(0); });
