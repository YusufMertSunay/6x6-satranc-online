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

const START_FEN = 'rbqknr/pppppp/6/6/PPPPPP/RBQKNR w Qq - 0 1';

const TIME_CONTROLS = {
  '1+0': { initialMs: 1 * 60 * 1000, incrementMs: 0, label: '1 dk' },
  '1+1': { initialMs: 1 * 60 * 1000, incrementMs: 1000, label: '1 dk | +1 sn' },
  '3+2': { initialMs: 3 * 60 * 1000, incrementMs: 2000, label: '3 dk | +2 sn' },
  '5+8': { initialMs: 5 * 60 * 1000, incrementMs: 8000, label: '5 dk | +8 sn' },
  '10+0': { initialMs: 10 * 60 * 1000, incrementMs: 0, label: '10 dk' },
  '10+15': { initialMs: 10 * 60 * 1000, incrementMs: 15000, label: '10 dk | +15 sn' },
  '30+0': { initialMs: 30 * 60 * 1000, incrementMs: 0, label: '30 dk' },
  '30+30': { initialMs: 30 * 60 * 1000, incrementMs: 30000, label: '30 dk | +30 sn' },
};

class GameManager {
  constructor(engine, store, hub) {
    this.engine = engine;
    this.store = store;
    this.hub = hub;
    this.queues = {}; // timeControlKey -> [userId, ...]
    for (const key of Object.keys(TIME_CONTROLS)) this.queues[key] = [];
    this.games = new Map(); // gameId -> live game state
    this.userActiveGame = new Map(); // userId -> gameId (en fazla bir aktif oyun)

    // Saat bayrağı düşüşlerini kontrol etmek için periyodik tarama.
    this._sweepInterval = setInterval(() => this._sweepClocks(), 1000);
  }

  timeControls() {
    return Object.entries(TIME_CONTROLS).map(([key, v]) => ({ key, label: v.label }));
  }

  // ============================================================
  // EŞLEŞTİRME
  // ============================================================

  joinQueue(userId, timeControlKey) {
    if (!TIME_CONTROLS[timeControlKey]) throw new Error('Geçersiz süre kontrolü.');
    if (this.userActiveGame.has(userId)) throw new Error('Zaten devam eden bir oyunun var.');

    // Aynı kullanıcı iki kez kuyruğa girmesin.
    for (const q of Object.values(this.queues)) {
      const idx = q.indexOf(userId);
      if (idx !== -1) q.splice(idx, 1);
    }

    const queue = this.queues[timeControlKey];
    if (queue.length > 0) {
      const opponentId = queue.shift();
      // Eşleşen oyuncu hâlâ bağlıysa oyunu başlat; değilse bu kullanıcıyı kuyruğa koy.
      this._startGame(opponentId, userId, timeControlKey);
    } else {
      queue.push(userId);
      this.hub.sendTo(userId, 'queued', { timeControlKey });
    }
  }

  leaveQueue(userId) {
    for (const q of Object.values(this.queues)) {
      const idx = q.indexOf(userId);
      if (idx !== -1) q.splice(idx, 1);
    }
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
  _createGame(whiteId, blackId, timeControlKey) {
    const id = crypto.randomUUID();
    const tc = TIME_CONTROLS[timeControlKey];

    const game = {
      id,
      whiteId,
      blackId,
      timeControlKey,
      startFen: START_FEN,
      movesUci: [],
      currentFen: START_FEN,
      whiteToMove: true,
      whiteClockMs: tc.initialMs,
      blackClockMs: tc.initialMs,
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
      startFen: game.startFen,
      movesUci: game.movesUci,
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

    // --- Hamleyi uygula ---
    game.movesUci.push(chosenMove);
    const newFen = await this.engine.getFenAfterMoves(game.startFen, game.movesUci);
    game.currentFen = newFen;
    game.whiteToMove = newFen.includes(' w ');

    // --- Saat: hamleyi tamamlayan tarafa artış ekle, sırayı diğer tarafa geç ---
    game[clockField] = remaining + tc.incrementMs;
    game.turnStartedAt = now;
    game.drawOfferBy = null; // yeni bir hamle önceki beraberlik teklifini geçersiz kılar

    // --- Oyun bitti mi? (mat / pat / yetersiz taş) ---
    await this._checkGameEnd(game);

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

  async _checkGameEnd(game) {
    if (game.status !== 'active') return;

    const legal = await this.engine.getLegalMoves(game.currentFen);
    if (legal.length === 0) {
      const inCheck = await this.engine.isInCheck(game.currentFen);
      if (inCheck) {
        // Sırası gelen taraf mat oldu — diğer taraf kazandı.
        const winner = game.whiteToMove ? 'black' : 'white';
        this._finalizeGame(game, 'checkmate', winner);
      } else {
        this._finalizeGame(game, 'stalemate', null);
      }
      return;
    }

    if (isInsufficientMaterial(game.currentFen)) {
      this._finalizeGame(game, 'insufficient_material', null);
    }
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
      // Renkleri BİLEREK tersine çevir: bu oyunda beyaz olan yeni oyunda
      // siyah olsun (rastgele değil) — kullanıcı isteği bu.
      const newWhiteId = game.blackId;
      const newBlackId = game.whiteId;
      this._createGame(newWhiteId, newBlackId, game.timeControlKey);
    } else {
      this.hub.sendTo(offererId, 'rematch_declined', { gameId });
    }
    return this.publicState(game);
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

    let scoreWhite = 0.5;
    if (winnerColor === 'white') scoreWhite = 1;
    else if (winnerColor === 'black') scoreWhite = 0;

    let newWhiteRating = whiteUser?.rating ?? 1500;
    let newBlackRating = blackUser?.rating ?? 1500;

    if (whiteUser && blackUser) {
      const result = computeNewRatings(whiteUser.rating, blackUser.rating, scoreWhite);
      newWhiteRating = result.newWhite;
      newBlackRating = result.newBlack;
      this.store.updateUserRating(
        whiteUser.id, newWhiteRating,
        scoreWhite === 1 ? 'win' : scoreWhite === 0 ? 'loss' : 'draw'
      );
      this.store.updateUserRating(
        blackUser.id, newBlackRating,
        scoreWhite === 0 ? 'win' : scoreWhite === 1 ? 'loss' : 'draw'
      );
    }

    this.store.saveFinishedGame(game.id, {
      whiteId: game.whiteId,
      blackId: game.blackId,
      whiteUsername: whiteUser?.username,
      blackUsername: blackUser?.username,
      timeControlKey: game.timeControlKey,
      startFen: game.startFen,
      currentFen: game.currentFen,
      movesUci: game.movesUci,
      resultReason: reason,
      winnerColor,
      whiteRatingAfter: newWhiteRating,
      blackRatingAfter: newBlackRating,
      endedAt: new Date().toISOString(),
    });

    this.userActiveGame.delete(game.whiteId);
    this.userActiveGame.delete(game.blackId);

    const payload = {
      gameId: game.id, reason, winnerColor,
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

module.exports = { GameManager, TIME_CONTROLS, START_FEN };
