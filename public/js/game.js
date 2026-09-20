// public/js/game.js — oyun sayfası mantığı: tahta çizimi, tıkla-taşı
// etkileşimi, saatler, gerçek zamanlı güncellemeler (SSE), teslim/berabere
// akışları ve terfi seçim penceresi.
//
// ÖNEMLİ: Bu dosya motordan ASLA bir değerlendirme (eval) ya da "en iyi
// hamle" istemiyor/göstermiyor — sadece /legal-moves ile hangi hamlelerin
// KURALLARA GÖRE mümkün olduğunu soruyor (lichess/chess.com'daki nokta
// işaretleriyle aynı, standart bir kullanıcı arayüzü özelliği).

(function () {
  const BOARD_SIZE = 6;
  const GLYPHS = {
    K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
    k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
  };
  // WinForms uygulamasındaki taş görselleri (public/images/pieces/ altında).
  const PIECE_FILES = {
    K: 'white_king', Q: 'white_queen', R: 'white_rook', B: 'white_bishop', N: 'white_knight', P: 'white_pawn',
    k: 'black_king', q: 'black_queen', r: 'black_rook', b: 'black_bishop', n: 'black_knight', p: 'black_pawn',
  };
  function pieceImgSrc(letter) {
    return `/images/pieces/${PIECE_FILES[letter]}.png`;
  }

  // Elo puanı artık TEK bir sayı değil, süre kontrolü kategorisine göre
  // (bullet/blitz/rapid/classical) AYRI tutuluyor — bkz. lib/store.js.
  const CATEGORY_LABELS = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Klasik' };

  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('id');
  const $ = (id) => document.getElementById(id);

  let me = null;
  let state = null;
  let myColor = null; // 'white' | 'black'
  let flipped = false;
  let selected = null; // 'a1' gibi
  let legalMoves = []; // sıradaki oyuncu için tüm yasal hamleler (UCI)
  let clockTimer = null;
  let sse = null;

  if (!gameId) {
    window.location.href = '/';
    return;
  }

  async function api(method, pathname, body) {
    const res = await fetch(pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { }
    if (!res.ok) {
      const err = new Error((json && json.error) || 'Bilinmeyen hata');
      err.payload = json;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  function fenToGrid(fen) {
    const board = fen.split(' ')[0];
    const rows = board.split('/');
    return rows.map(row => {
      const cells = [];
      for (const ch of row) {
        if (/\d/.test(ch)) { for (let i = 0; i < parseInt(ch, 10); i++) cells.push(null); }
        else cells.push(ch);
      }
      return cells;
    });
  }

  function squareName(r, c) {
    return String.fromCharCode('a'.charCodeAt(0) + c) + (BOARD_SIZE - r);
  }

  function rcOfSquare(sq) {
    const c = sq.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(sq.substring(1), 10);
    const r = BOARD_SIZE - rank;
    return { r, c };
  }

  // Tehdit altındaki (şah çekilen) tarafın şahının bulunduğu kareyi bulur —
  // FEN'in "sırası kimde" alanına bakıyoruz, çünkü şah çekilmesi HER ZAMAN
  // sırası gelen tarafın başına gelir (bir hamle, kendi şahını çekilir
  // hâlde bırakamaz). state.inCheck sunucudan geliyor (bkz. gameManager.js).
  function findCheckedKingSquare(grid, fen) {
    const activeColor = fen.split(' ')[1];
    const kingChar = activeColor === 'w' ? 'K' : 'k';
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (grid[r][c] === kingChar) return { r, c };
      }
    }
    return null;
  }

  // ---------------- Tahta çizimi ----------------

  const boardEl = $('board');
  let squareEls = []; // [r][c] -> element

  function buildBoardSkeleton() {
    boardEl.innerHTML = '';
    squareEls = Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE));
    for (let dr = 0; dr < BOARD_SIZE; dr++) {
      for (let dc = 0; dc < BOARD_SIZE; dc++) {
        const r = flipped ? BOARD_SIZE - 1 - dr : dr;
        const c = flipped ? BOARD_SIZE - 1 - dc : dc;
        const div = document.createElement('div');
        const isLight = (r + c) % 2 === 0;
        div.className = 'square ' + (isLight ? 'light' : 'dark');
        div.dataset.r = r;
        div.dataset.c = c;
        div.addEventListener('click', () => onSquareClick(r, c));
        boardEl.appendChild(div);
        squareEls[r][c] = div;
      }
    }
  }

  function renderBoard() {
    const grid = fenToGrid(state.currentFen);
    const lastMove = state.movesUci.length ? state.movesUci[state.movesUci.length - 1] : null;
    let lastFrom = null, lastTo = null;
    if (lastMove) {
      lastFrom = lastMove.slice(0, 2);
      lastTo = lastMove.slice(2, 4);
    }
    const checkedKing = state.inCheck ? findCheckedKingSquare(grid, state.currentFen) : null;

    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const el = squareEls[r][c];
        const piece = grid[r][c];
        el.innerHTML = piece
          ? `<img class="piece-img" src="${pieceImgSrc(piece)}" alt="${GLYPHS[piece]}">`
          : '';

        const sq = squareName(r, c);
        el.classList.toggle('selected', selected === sq);
        el.classList.toggle('last-move', sq === lastFrom || sq === lastTo);
        el.classList.toggle('in-check', !!checkedKing && checkedKing.r === r && checkedKing.c === c);

        const isLegalDest = selected && legalMoves.some(m => m.startsWith(selected) && m.slice(2, 4) === sq);
        el.classList.toggle('legal-dest', !!isLegalDest);
      }
    }
  }

  // ---------------- Etkileşim ----------------

  function myTurn() {
    return state.status === 'active' && ((state.whiteToMove && myColor === 'white') || (!state.whiteToMove && myColor === 'black'));
  }

  async function refreshLegalMoves() {
    if (!myTurn()) { legalMoves = []; return; }
    try {
      const { moves } = await api('GET', `/api/game/${gameId}/legal-moves`);
      legalMoves = moves;
    } catch {
      legalMoves = [];
    }
  }

  function pieceBelongsToMe(piece) {
    if (!piece) return false;
    const isWhitePiece = piece === piece.toUpperCase();
    return (isWhitePiece && myColor === 'white') || (!isWhitePiece && myColor === 'black');
  }

  async function onSquareClick(r, c) {
    if (!state || state.status !== 'active') return;
    const sq = squareName(r, c);
    const grid = fenToGrid(state.currentFen);
    const piece = grid[r][c];

    if (!selected) {
      if (myTurn() && pieceBelongsToMe(piece)) {
        selected = sq;
        renderBoard();
      }
      return;
    }

    if (selected === sq) {
      selected = null;
      renderBoard();
      return;
    }

    if (pieceBelongsToMe(piece)) {
      selected = sq;
      renderBoard();
      return;
    }

    // Bir hedef kareye tıklandı — yasal mı diye bak.
    const matches = legalMoves.filter(m => m.startsWith(selected) && m.slice(2, 4) === sq);
    if (matches.length === 0) {
      // Yasal değil; seçimi iptal et.
      selected = null;
      renderBoard();
      return;
    }

    const from = selected;
    selected = null;

    if (matches.length === 1) {
      await submitMove(from, sq, null);
    } else {
      // Terfi — birden fazla eşleşme var (farklı terfi taşları).
      const options = matches.map(m => m.slice(4));
      showPromotionModal(options, async (choice) => {
        await submitMove(from, sq, choice);
      });
    }
  }

  async function submitMove(from, to, promotion) {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/move`, { from, to, promotion: promotion || undefined });
      mergeState(newState);
      await refreshLegalMoves();
      renderAll();
    } catch (err) {
      if (err.payload && err.payload.error === 'PROMOTION_REQUIRED') {
        showPromotionModal(err.payload.options, async (choice) => {
          await submitMove(from, to, choice);
        });
      } else {
        setStatusMessage(err.message, true);
      }
    }
  }

  function showPromotionModal(options, onChoose) {
    const modal = $('promotionModal');
    const optsEl = $('promotionOptions');
    optsEl.innerHTML = '';
    const letterFor = (letter) => myColor === 'white' ? letter.toUpperCase() : letter.toLowerCase();
    options.forEach(letter => {
      const btn = document.createElement('button');
      btn.innerHTML = `<img class="piece-img" src="${pieceImgSrc(letterFor(letter))}" alt="">`;
      btn.addEventListener('click', () => {
        modal.classList.add('hidden');
        onChoose(letter);
      });
      optsEl.appendChild(btn);
    });
    modal.classList.remove('hidden');
  }

  // ---------------- Saatler ----------------

  function formatMs(ms) {
    // Eski/eksik bir kayıtta saat bilgisi hiç yoksa (ör. bu alanların henüz
    // kaydedilmediği bir dönemden kalma bitmiş oyun) "NaN:NaN" göstermek
    // yerine güvenli bir şekilde 0'a düşüyoruz.
    if (typeof ms !== 'number' || !Number.isFinite(ms)) ms = 0;
    if (ms < 0) ms = 0;
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function tickClocks() {
    if (!state) return;
    let whiteMs = state.whiteClockMs;
    let blackMs = state.blackClockMs;
    if (state.status === 'active') {
      const elapsed = Date.now() - state.turnStartedAt;
      if (state.whiteToMove) whiteMs = Math.max(0, state.whiteClockMs - elapsed);
      else blackMs = Math.max(0, state.blackClockMs - elapsed);
    }

    // Yerleşim her zaman sabit: alt kutu HER ZAMAN "ben", üst kutu HER ZAMAN
    // "rakip" (renderPlayerNames() ile aynı kural) — bu, renge göre
    // DEĞİŞMEMELİ. (Daha önce burada renge göre de seçim yapılıyordu, bu da
    // siyah oyuncu için isim ile saat değerinin ters kutulara yazılmasına
    // (bir tür "çapraz kablolama" hatasına) yol açıyordu.)
    const myEl = $('bottomClock');
    const oppEl = $('topClock');
    const myMs = myColor === 'white' ? whiteMs : blackMs;
    const oppMs = myColor === 'white' ? blackMs : whiteMs;

    myEl.textContent = formatMs(myMs);
    oppEl.textContent = formatMs(oppMs);

    myEl.classList.toggle('low', myMs < 30000);
    oppEl.classList.toggle('low', oppMs < 30000);

    const myActive = state.status === 'active' && myTurn();
    const oppActive = state.status === 'active' && !myTurn();
    myEl.classList.toggle('active', myActive);
    oppEl.classList.toggle('active', oppActive);
  }

  // ---------------- Genel görünüm güncelleme ----------------

  function renderMoves() {
    const box = $('movesBox');
    // Gerçek cebirsel gösterim (SAN — ör. "exf4", "Qa5", "Bxb2", "O-O-O",
    // "Nf3+") sunucu tarafında hesaplanıp state.sanMoves içinde geliyor.
    const sanMoves = state.sanMoves || [];
    let html = '';
    for (let i = 0; i < sanMoves.length; i += 2) {
      const num = i / 2 + 1;
      html += `<div class="move-pair"><span class="move-num">${num}.</span><span>${sanMoves[i]}</span><span>${sanMoves[i + 1] || ''}</span></div>`;
    }
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  function resultReasonText(reason) {
    const map = {
      checkmate: 'Şah mat',
      stalemate: 'Pat (berabere)',
      insufficient_material: 'Yetersiz taş (berabere)',
      resign: 'Teslim oldu',
      timeout: 'Süre doldu',
      timeout_insufficient_material: 'Süre doldu, ancak yetersiz taş (berabere)',
      draw_agreed: 'Anlaşmalı beraberlik',
    };
    return map[reason] || reason;
  }

  function setStatusMessage(text, isError) {
    const box = $('statusBox');
    box.textContent = text;
    box.classList.toggle('error-text', !!isError);
  }

  function renderStatus() {
    if (state.status === 'active') {
      setStatusMessage(myTurn() ? 'Sıra sende' : 'Rakip düşünüyor...', false);
    } else {
      setStatusMessage(resultReasonText(state.resultReason), false);
    }
  }

  function renderGameOverBanner() {
    const banner = $('gameOverBanner');
    if (state.status !== 'finished') {
      banner.classList.add('hidden');
      return;
    }
    let outcomeText, cls;
    if (state.winnerColor === null) {
      outcomeText = 'Berabere';
      cls = '';
    } else if (state.winnerColor === myColor) {
      outcomeText = 'Kazandın!';
      cls = '';
    } else {
      outcomeText = 'Kaybettin';
      cls = 'loss';
    }
    banner.className = 'game-over-banner' + (cls ? ' ' + cls : '');
    let ratingLine = '';
    if (typeof state.whiteRatingAfter === 'number') {
      const myRatingAfter = myColor === 'white' ? state.whiteRatingAfter : state.blackRatingAfter;
      const categoryLabel = CATEGORY_LABELS[state.timeControlCategory] || '';
      ratingLine = `<div class="rating-change">Yeni ${categoryLabel} puanın: ${myRatingAfter}</div>`;
    }
    banner.innerHTML = `<h3>${outcomeText}</h3><div>${resultReasonText(state.resultReason)}</div>${ratingLine}`;
    banner.classList.remove('hidden');
  }

  function renderDrawOfferBanner() {
    const banner = $('drawOfferBanner');
    const showIt = state.status === 'active' && state.drawOfferBy && state.drawOfferBy !== myColor;
    banner.classList.toggle('hidden', !showIt);
  }

  // Oyun bittikten sonra: rakip yeni oyun teklif ettiyse kabul/reddet
  // kutusunu, etmediyse (ve ben de teklif etmediysem) "Yeni Oyun Teklif Et"
  // butonunu göster.
  function renderRematchUI() {
    const incomingBanner = $('rematchOfferBanner');
    const actionRow = $('rematchActionRow');
    const offerBtn = $('offerRematchBtn');

    $('analysisActionRow').classList.toggle('hidden', state.status !== 'finished');

    if (state.status !== 'finished') {
      incomingBanner.classList.add('hidden');
      actionRow.classList.add('hidden');
      return;
    }

    const opponentOffered = state.rematchOfferBy && state.rematchOfferBy !== myColor;
    incomingBanner.classList.toggle('hidden', !opponentOffered);

    actionRow.classList.toggle('hidden', opponentOffered);
    if (!opponentOffered) {
      const iOffered = !!state.rematchOfferBy && state.rematchOfferBy === myColor;
      offerBtn.disabled = iOffered;
      offerBtn.textContent = iOffered ? 'Teklif gönderildi, rakip bekleniyor...' : 'Yeni Oyun Teklif Et';
    }
  }

  function renderPlayerNames() {
    const myName = myColor === 'white' ? state.whiteUsername : state.blackUsername;
    const oppName = myColor === 'white' ? state.blackUsername : state.whiteUsername;
    $('bottomName').textContent = (myName || me.username) + ' (Sen)';
    $('topName').textContent = oppName || 'Rakip';
  }

  function renderActionButtons() {
    const active = state.status === 'active';
    $('offerDrawBtn').disabled = !active;
    $('resignBtn').disabled = !active;
  }

  function renderAll() {
    renderBoard();
    renderStatus();
    renderMoves();
    renderGameOverBanner();
    renderDrawOfferBanner();
    renderRematchUI();
    renderActionButtons();
    tickClocks();
  }

  // Gelen kısmi güncellemeleri (SSE game_over gibi) mevcut duruma yedirir.
  function mergeState(partial) {
    state = Object.assign({}, state, partial);
  }

  // ---------------- Butonlar ----------------

  $('resignBtn').addEventListener('click', async () => {
    if (!confirm('Teslim olmak istediğine emin misin?')) return;
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/resign`);
      mergeState(newState);
      renderAll();
    } catch (err) { alert(err.message); }
  });

  $('offerDrawBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/offer-draw`);
      mergeState(newState);
      renderAll();
    } catch (err) { alert(err.message); }
  });

  $('acceptDrawBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/respond-draw`, { accept: true });
      mergeState(newState);
      renderAll();
    } catch (err) { alert(err.message); }
  });

  $('declineDrawBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/respond-draw`, { accept: false });
      mergeState(newState);
      renderAll();
    } catch (err) { alert(err.message); }
  });

  $('offerRematchBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/offer-rematch`);
      mergeState(newState);
      renderAll();
    } catch (err) { alert(err.message); }
  });

  $('acceptRematchBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/respond-rematch`, { accept: true });
      mergeState(newState);
      renderAll();
      // Kabul edilince sunucu yeni oyunu başlatıp 'match_found' olayını
      // gönderecek — yönlendirme o olay geldiğinde yapılıyor.
    } catch (err) { alert(err.message); }
  });

  $('openAnalysisBtn').addEventListener('click', () => {
    window.location.href = '/analysis.html?id=' + gameId;
  });

  $('declineRematchBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/respond-rematch`, { accept: false });
      mergeState(newState);
      renderAll();
    } catch (err) { alert(err.message); }
  });

  // ---------------- SSE ----------------

  function connectSse() {
    sse = new EventSource('/events');
    sse.addEventListener('move', async (e) => {
      const data = JSON.parse(e.data);
      if (data.id !== gameId) return;
      mergeState(data);
      await refreshLegalMoves();
      renderAll();
    });
    sse.addEventListener('game_over', async (e) => {
      const data = JSON.parse(e.data);
      if (data.gameId !== gameId) return;
      mergeState({
        status: 'finished',
        resultReason: data.reason,
        winnerColor: data.winnerColor,
        whiteRatingAfter: data.whiteRatingAfter,
        blackRatingAfter: data.blackRatingAfter,
      });
      legalMoves = [];
      selected = null;
      renderAll();
    });
    sse.addEventListener('draw_offered', async () => {
      // Güncel durumu almak için tam bir tazeleme yapalım (drawOfferBy alanı için).
      await reloadState();
      renderAll();
    });
    sse.addEventListener('draw_declined', async () => {
      await reloadState();
      renderAll();
    });
    sse.addEventListener('rematch_offered', async () => {
      await reloadState();
      renderAll();
    });
    sse.addEventListener('rematch_declined', async () => {
      await reloadState();
      renderAll();
    });
    // Revanş kabul edildiğinde sunucu yeni bir oyun oluşturup her iki tarafa
    // da 'match_found' gönderiyor (lobideki eşleştirmeyle aynı olay) —
    // burada da onu dinleyip yeni oyunun sayfasına geçiyoruz.
    sse.addEventListener('match_found', (e) => {
      const data = JSON.parse(e.data);
      window.location.href = '/game.html?id=' + data.gameId;
    });
  }

  async function reloadState() {
    const { state: fresh } = await api('GET', `/api/game/${gameId}`);
    mergeState(fresh);
  }

  // ---------------- Başlangıç ----------------

  async function init() {
    try {
      me = await api('GET', '/api/me');
    } catch {
      window.location.href = '/';
      return;
    }
    $('userName').textContent = me.username;

    try {
      const { live, state: loadedState } = await api('GET', `/api/game/${gameId}`);
      state = loadedState;
      if (!live) {
        // Bitmiş/kalıcı hale gelmiş bir oyun kaydı — canlı alanlardan bazıları
        // (turnStartedAt, drawOfferBy) olmayabilir; makul varsayılanlar koyalım.
        state.status = 'finished';
        if (state.turnStartedAt === undefined) state.turnStartedAt = Date.now();
        if (state.drawOfferBy === undefined) state.drawOfferBy = null;
        if (state.rematchOfferBy === undefined) state.rematchOfferBy = null;
      }
    } catch (err) {
      setStatusMessage('Oyun yüklenemedi: ' + err.message, true);
      return;
    }

    // Puan rozeti bu oyunun süre kontrolü KATEGORİSİNE ait puanı gösteriyor
    // (Elo artık tek bir sayı değil, kategoriye göre ayrı — bkz. store.js).
    const myCategory = state.timeControlCategory || 'bullet';
    $('userRating').textContent = (me.ratings && me.ratings[myCategory]) ?? '-';

    myColor = state.whiteId === me.id ? 'white' : (state.blackId === me.id ? 'black' : null);
    if (!myColor) {
      setStatusMessage('Bu oyunun oyuncusu değilsin.', true);
      return;
    }
    flipped = myColor === 'black';

    buildBoardSkeleton();
    renderPlayerNames();
    await refreshLegalMoves();
    renderAll();

    connectSse();
    clockTimer = setInterval(tickClocks, 250);
  }

  window.addEventListener('beforeunload', () => {
    if (sse) sse.close();
    if (clockTimer) clearInterval(clockTimer);
  });

  // ---------------- Tahta renkleri ----------------
  // Kullanıcının seçtiği açık/koyu kare renkleri, sadece kendi tarayıcısında
  // (localStorage) saklanır — hesabına değil cihazına bağlıdır, sunucuya
  // gönderilmez ve rakibi etkilemez.
  const DEFAULT_LIGHT_SQUARE = '#ebecd0';
  const DEFAULT_DARK_SQUARE = '#779556';

  function applyBoardColors(light, dark) {
    document.documentElement.style.setProperty('--light-square', light);
    document.documentElement.style.setProperty('--dark-square', dark);
  }

  function initBoardColorSettings() {
    let light = DEFAULT_LIGHT_SQUARE;
    let dark = DEFAULT_DARK_SQUARE;
    try {
      light = localStorage.getItem('boardLightColor') || DEFAULT_LIGHT_SQUARE;
      dark = localStorage.getItem('boardDarkColor') || DEFAULT_DARK_SQUARE;
    } catch { /* localStorage kapalı/engelliyse varsayılanlarla devam */ }

    applyBoardColors(light, dark);
    $('lightColorInput').value = light;
    $('darkColorInput').value = dark;

    $('lightColorInput').addEventListener('input', (e) => {
      applyBoardColors(e.target.value, $('darkColorInput').value);
      try { localStorage.setItem('boardLightColor', e.target.value); } catch { }
    });
    $('darkColorInput').addEventListener('input', (e) => {
      applyBoardColors($('lightColorInput').value, e.target.value);
      try { localStorage.setItem('boardDarkColor', e.target.value); } catch { }
    });
    $('resetBoardColorsBtn').addEventListener('click', () => {
      applyBoardColors(DEFAULT_LIGHT_SQUARE, DEFAULT_DARK_SQUARE);
      $('lightColorInput').value = DEFAULT_LIGHT_SQUARE;
      $('darkColorInput').value = DEFAULT_DARK_SQUARE;
      try {
        localStorage.removeItem('boardLightColor');
        localStorage.removeItem('boardDarkColor');
      } catch { }
    });
  }

  initBoardColorSettings();
  init();
})();
