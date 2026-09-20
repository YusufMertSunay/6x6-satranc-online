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

const PORT = process.env.PORT || 3000;
const ENGINE_PATH = path.join(__dirname, 'engine', 'fairy-stockfish');
const VARIANTS_PATH = path.join(__dirname, 'engine', 'variants.ini');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Oyun sonrası analiz tahtasının motoru bekleteceği süre (ms). Kısa tutuluyor
// çünkü bu, CANLI OYUN motorundan AYRI bir süreç olsa da, aynı sunucunun
// CPU'sunu paylaşıyor — çok uzun bir "düşünme süresi" analiz isteyen bir
// kullanıcı varken diğer kullanıcıların canlı oyunlarını yavaşlatabilir.
const ANALYSIS_MOVETIME_MS = 1200;
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
let gameManager = null;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
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
// motor erişimi YASAK ilkesiyle tutarlı) VE sadece o oyunun oyuncularından
// biri erişebilir. Oyun hâlâ bellekte (gameManager) olabilir ya da 5 dakikalık
// pencere geçip diske (store) yazılmış olabilir — ikisini de kontrol ediyoruz.
function getFinishedGameForUser(gameId, userId) {
  const live = gameManager.getGame(gameId);
  if (live) {
    if (live.status !== 'finished') return null;
    if (live.whiteId !== userId && live.blackId !== userId) return null;
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
    if (persisted.whiteId !== userId && persisted.blackId !== userId) return null;
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
async function pvToSan(fenBeforeFirstMove, pvUciMoves) {
  const sanList = [];
  let fen = fenBeforeFirstMove;
  const limited = pvUciMoves.slice(0, MAX_PV_SAN_PLIES);
  let legalAtCurrent;
  try {
    legalAtCurrent = await analysisEngine.getLegalMoves(fen);
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

async function handleApi(req, res, pathname, url) {
  // ---- Kimlik doğrulama gerektirmeyen uçlar ----
  if (pathname === '/api/register' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    if (!username || typeof username !== 'string' || username.length < 3 || username.length > 24) {
      return sendJson(res, 400, { error: 'Kullanıcı adı 3-24 karakter olmalı.' });
    }
    if (!/^[a-zA-Z0-9_şŞıİöÖüÜçÇğĞ]+$/.test(username)) {
      return sendJson(res, 400, { error: 'Kullanıcı adı geçersiz karakterler içeriyor.' });
    }
    if (!password || password.length < 6) {
      return sendJson(res, 400, { error: 'Parola en az 6 karakter olmalı.' });
    }
    try {
      const { salt, passwordHash } = hashPassword(password);
      const user = store.createUser({ username, passwordHash, salt });
      const token = sessions.createSession(user.id);
      res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
      return sendJson(res, 200, { id: user.id, username: user.username, ratings: user.ratings });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const user = store.getUserByUsername(username || '');
    if (!user || !verifyPassword(password || '', user.salt, user.passwordHash)) {
      return sendJson(res, 401, { error: 'Kullanıcı adı ya da parola hatalı.' });
    }
    const token = sessions.createSession(user.id);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
    return sendJson(res, 200, { id: user.id, username: user.username, ratings: user.ratings });
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
  if (!user) return sendJson(res, 401, { error: 'Giriş yapmalısın.' });

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
    });
  }

  if (pathname === '/api/my-games' && req.method === 'GET') {
    return sendJson(res, 200, { games: store.recentGamesForUser(user.id, 20) });
  }

  if (pathname === '/api/my-active-game' && req.method === 'GET') {
    return sendJson(res, 200, { gameId: gameManager.activeGameId(user.id) });
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
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/queue/leave' && req.method === 'POST') {
    gameManager.leaveQueue(user.id);
    return sendJson(res, 200, { ok: true });
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
      return sendJson(res, 404, { error: 'Oyun bulunamadı.' });
    }

    if (sub === '/legal-moves' && req.method === 'GET') {
      try {
        const moves = await gameManager.legalMoves(gameId, user.id);
        return sendJson(res, 200, { moves });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (sub === '/move' && req.method === 'POST') {
      const { from, to, promotion } = await readBody(req);
      try {
        const state = await gameManager.applyMove(gameId, user.id, from, to, promotion);
        return sendJson(res, 200, { state });
      } catch (err) {
        if (err.code === 'PROMOTION_REQUIRED') {
          return sendJson(res, 409, { error: 'PROMOTION_REQUIRED', options: err.options });
        }
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (sub === '/resign' && req.method === 'POST') {
      try { return sendJson(res, 200, { state: gameManager.resign(gameId, user.id) }); }
      catch (err) { return sendJson(res, 400, { error: err.message }); }
    }

    if (sub === '/offer-draw' && req.method === 'POST') {
      try { return sendJson(res, 200, { state: gameManager.offerDraw(gameId, user.id) }); }
      catch (err) { return sendJson(res, 400, { error: err.message }); }
    }

    if (sub === '/respond-draw' && req.method === 'POST') {
      const { accept } = await readBody(req);
      try { return sendJson(res, 200, { state: gameManager.respondDraw(gameId, user.id, !!accept) }); }
      catch (err) { return sendJson(res, 400, { error: err.message }); }
    }

    if (sub === '/offer-rematch' && req.method === 'POST') {
      try { return sendJson(res, 200, { state: gameManager.offerRematch(gameId, user.id) }); }
      catch (err) { return sendJson(res, 400, { error: err.message }); }
    }

    if (sub === '/respond-rematch' && req.method === 'POST') {
      const { accept } = await readBody(req);
      try { return sendJson(res, 200, { state: gameManager.respondRematch(gameId, user.id, !!accept) }); }
      catch (err) { return sendJson(res, 400, { error: err.message }); }
    }

    // ---- Oyun sonrası analiz tahtası ----
    // Not: bu üçü SADECE bitmiş bir oyunun oyuncularına açık (yukarıdaki
    // getFinishedGameForUser) ve CANLI OYUN motorundan (const engine) tamamen
    // ayrı bir motor süreci (analysisEngine) kullanıyor.

    if (sub === '/analysis-start' && req.method === 'GET') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return sendJson(res, 403, { error: 'Bu oyun için analiz yapılamaz (oyun bitmemiş olabilir ya da bu oyunun oyuncusu değilsin).' });
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
      if (!info) return sendJson(res, 403, { error: 'Bu oyun için analiz yapılamaz.' });
      const { moves } = await readBody(req);
      const moveList = Array.isArray(moves) ? moves : [];
      try {
        const fen = await analysisEngine.getFenAfterMoves(info.startFen, moveList);
        if (!fen) return sendJson(res, 500, { error: 'Motor pozisyonu hesaplayamadı.' });
        const legalMoves = await analysisEngine.getLegalMoves(fen);
        // İstemcinin, tehdit altındaki şahın karesini kırmızı gösterebilmesi
        // için bu pozisyonda şah çekiliyor mu bilgisi de dönüyor.
        const inCheck = await analysisEngine.isInCheck(fen);
        return sendJson(res, 200, { fen, legalMoves, whiteToMove: fen.includes(' w '), inCheck });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (sub === '/analysis-evaluate' && req.method === 'POST') {
      const info = getFinishedGameForUser(gameId, user.id);
      if (!info) return sendJson(res, 403, { error: 'Bu oyun için analiz yapılamaz.' });
      const { moves } = await readBody(req);
      const moveList = Array.isArray(moves) ? moves : [];
      try {
        const fen = await analysisEngine.getFenAfterMoves(info.startFen, moveList);
        if (!fen) return sendJson(res, 500, { error: 'Motor pozisyonu hesaplayamadı.' });
        const whiteToMove = fen.includes(' w ');
        const legalMoves = await analysisEngine.getLegalMoves(fen);

        if (legalMoves.length === 0) {
          return sendJson(res, 200, { fen, whiteToMove, noLegalMoves: true, insufficientMaterial: false, result: null });
        }
        if (isInsufficientMaterial(fen)) {
          return sendJson(res, 200, { fen, whiteToMove, noLegalMoves: false, insufficientMaterial: true, result: null });
        }

        const result = await analysisEngine.analyze(fen, ANALYSIS_MOVETIME_MS);
        // PV'yi (motorun önerdiği varyant) UCI yerine GERÇEK satranç
        // notasyonuyla (SAN — ör. "Nf3", "O-O", "exd5") göstermek için
        // ayrıca çeviriyoruz (kullanıcının isteği: "rok O-O olarak görünsün"
        // ile aynı notasyon PV için de geçerli olsun).
        let sanPv = [];
        if (result && result.pv && result.pv.length) {
          try { sanPv = await pvToSan(fen, result.pv); } catch { sanPv = []; }
        }
        if (result) result.sanPv = sanPv;
        return sendJson(res, 200, { fen, whiteToMove, noLegalMoves: false, insufficientMaterial: false, result });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
  }

  return sendJson(res, 404, { error: 'Bulunamadı.' });
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

  gameManager = new GameManager(engine, store, hub);

  server.listen(PORT, () => {
    console.log(`6x6 Satranç Online sunucusu http://localhost:${PORT} adresinde çalışıyor`);
  });
}

main().catch(err => {
  console.error('Sunucu başlatılamadı:', err);
  process.exit(1);
});

process.on('SIGINT', () => { engine.quit(); analysisEngine.quit(); process.exit(0); });
process.on('SIGTERM', () => { engine.quit(); analysisEngine.quit(); process.exit(0); });
