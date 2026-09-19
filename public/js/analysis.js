// public/js/analysis.js — oyun bitince açılabilen ANALİZ TAHTASI.
//
// Masaüstü uygulamasındaki AnalysisForm.cs'in web karşılığı:
//  - Oyunun başından sonuna kadar hamle hamle gezinme (Başa/Geri/İleri/Sona),
//  - Hamle listesinde bir hamleye tıklayınca o ana atlama,
//  - Herhangi bir andan itibaren "kitaptan sapıp" farklı bir hamle deneme
//    (deviation) — bundan sonrası artık gerçek oyunun hamleleri değil,
//  - Her pozisyon için ayrı bir motor sürecinden (analysisEngine, server.js)
//    değerlendirme (skor) ve önerilen varyant (PV) istenip gösterilmesi.
//
// ÖNEMLİ: Bu ekran SADECE bitmiş oyunlar için ve SADECE o oyunun iki
// oyuncusuna açık — sunucu tarafında da ayrıca kontrol ediliyor
// (getFinishedGameForUser). Canlı oyun sırasında (game.js) motor
// değerlendirmesi/en iyi hamle KESİNLİKLE gösterilmiyor; bu, sadece oyun
// bittikten sonraki bu ayrı sayfada devreye giriyor.

(function () {
  const BOARD_SIZE = 6;
  const GLYPHS = {
    K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
    k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
  };
  const PIECE_FILES = {
    K: 'white_king', Q: 'white_queen', R: 'white_rook', B: 'white_bishop', N: 'white_knight', P: 'white_pawn',
    k: 'black_king', q: 'black_queen', r: 'black_rook', b: 'black_bishop', n: 'black_knight', p: 'black_pawn',
  };
  function pieceImgSrc(letter) {
    return `/images/pieces/${PIECE_FILES[letter]}.png`;
  }

  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('id');
  const $ = (id) => document.getElementById(id);

  if (!gameId) {
    window.location.href = '/';
    return;
  }

  let me = null;
  let myColor = null; // 'white' | 'black' — sadece varsayılan yön ve "(Sen)" etiketi için
  let flipped = false;

  let whiteId = null, blackId = null;
  let whiteUsername = '?', blackUsername = '?';
  let startFen = null;

  let bookMoves = [];   // oyunun GERÇEKTE oynanmış hamleleri (UCI) — SABİT
  let bookSan = [];     // aynı hamlelerin SAN gösterimi — SABİT

  let appliedMoves = []; // şu anda tahtada uygulanmış hamleler (DEĞİŞEBİLİR — sapma burada olur)
  let selected = null;
  let currentFen = null;
  let currentLegalMoves = [];
  let currentWhiteToMove = true;

  let generation = 0; // her navigasyonda artar; eski (gecikmiş) motor cevapları bununla elenir
  let bestMoveHighlight = null; // { from, to } ya da null

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

  // ---------------- Tahta çizimi ----------------

  const boardEl = $('board');
  let squareEls = [];

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
    if (!currentFen) return;
    const grid = fenToGrid(currentFen);
    const lastMove = appliedMoves.length ? appliedMoves[appliedMoves.length - 1] : null;
    let lastFrom = null, lastTo = null;
    if (lastMove) {
      lastFrom = lastMove.slice(0, 2);
      lastTo = lastMove.slice(2, 4);
    }

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

        const isLegalDest = selected && currentLegalMoves.some(m => m.startsWith(selected) && m.slice(2, 4) === sq);
        el.classList.toggle('legal-dest', !!isLegalDest);

        const isBestFrom = bestMoveHighlight && sq === bestMoveHighlight.from;
        const isBestTo = bestMoveHighlight && sq === bestMoveHighlight.to;
        el.classList.toggle('best-move-from', !!isBestFrom);
        el.classList.toggle('best-move-to', !!isBestTo);
      }
    }
  }

  // ---------------- Kitap (gerçek oyun) takibi ----------------

  function isOnBook() {
    if (appliedMoves.length > bookMoves.length) return false;
    for (let i = 0; i < appliedMoves.length; i++) {
      if (appliedMoves[i] !== bookMoves[i]) return false;
    }
    return true;
  }

  // ---------------- Etkileşim (tahtaya tıklayarak hamle deneme) ----------------

  function pieceBelongsToSideToMove(piece) {
    if (!piece) return false;
    const isWhitePiece = piece === piece.toUpperCase();
    return currentWhiteToMove ? isWhitePiece : !isWhitePiece;
  }

  function onSquareClick(r, c) {
    if (!currentFen) return;
    const sq = squareName(r, c);
    const grid = fenToGrid(currentFen);
    const piece = grid[r][c];

    if (!selected) {
      if (pieceBelongsToSideToMove(piece)) {
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

    if (pieceBelongsToSideToMove(piece)) {
      selected = sq;
      renderBoard();
      return;
    }

    const matches = currentLegalMoves.filter(m => m.startsWith(selected) && m.slice(2, 4) === sq);
    if (matches.length === 0) {
      selected = null;
      renderBoard();
      return;
    }

    const from = selected;
    selected = null;

    if (matches.length === 1) {
      appliedMoves.push(matches[0]);
      refreshPosition();
    } else {
      // Terfi — birden fazla eşleşme (farklı terfi taşları).
      const options = matches.map(m => m.slice(4));
      const sideIsWhite = currentWhiteToMove;
      showPromotionModal(options, sideIsWhite, (choice) => {
        appliedMoves.push(from + sq + choice);
        refreshPosition();
      });
    }
  }

  function showPromotionModal(options, sideIsWhite, onChoose) {
    const modal = $('promotionModal');
    const optsEl = $('promotionOptions');
    optsEl.innerHTML = '';
    const letterFor = (letter) => sideIsWhite ? letter.toUpperCase() : letter.toLowerCase();
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

  // ---------------- Hamle listesi ----------------

  function renderMoveList() {
    const box = $('movesBox');
    const onBook = isOnBook();
    const currentBookIndex = onBook ? appliedMoves.length : -1; // 1 => ilk hamle oynanmış demek
    let html = '';
    for (let i = 0; i < bookSan.length; i += 2) {
      const num = i / 2 + 1;
      const whiteIdx = i + 1;
      const blackIdx = i + 2;
      const whiteCls = whiteIdx === currentBookIndex ? ' class="current-move"' : '';
      const blackCls = blackIdx === currentBookIndex ? ' class="current-move"' : '';
      const whiteSpan = `<span data-idx="${i}"${whiteCls}>${bookSan[i]}</span>`;
      const blackSpan = bookSan[i + 1] !== undefined
        ? `<span data-idx="${i + 1}"${blackCls}>${bookSan[i + 1]}</span>`
        : '<span></span>';
      html += `<div class="move-pair"><span class="move-num">${num}.</span>${whiteSpan}${blackSpan}</div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('span[data-idx]').forEach(span => {
      span.addEventListener('click', () => {
        const idx = parseInt(span.dataset.idx, 10);
        appliedMoves = bookMoves.slice(0, idx + 1);
        selected = null;
        refreshPosition();
      });
    });
  }

  // ---------------- Navigasyon düğmeleri ----------------

  function renderNavButtons() {
    const onBook = isOnBook();
    $('navStartBtn').disabled = appliedMoves.length === 0;
    $('navBackBtn').disabled = appliedMoves.length === 0;
    $('navForwardBtn').disabled = !(onBook && appliedMoves.length < bookMoves.length);
    $('navEndBtn').disabled = onBook && appliedMoves.length === bookMoves.length;
  }

  $('navStartBtn').addEventListener('click', () => {
    appliedMoves = [];
    selected = null;
    refreshPosition();
  });
  $('navBackBtn').addEventListener('click', () => {
    if (appliedMoves.length === 0) return;
    appliedMoves = appliedMoves.slice(0, -1);
    selected = null;
    refreshPosition();
  });
  $('navForwardBtn').addEventListener('click', () => {
    if (!isOnBook() || appliedMoves.length >= bookMoves.length) return;
    appliedMoves.push(bookMoves[appliedMoves.length]);
    selected = null;
    refreshPosition();
  });
  $('navEndBtn').addEventListener('click', () => {
    appliedMoves = bookMoves.slice();
    selected = null;
    refreshPosition();
  });
  $('flipBoardBtn').addEventListener('click', () => {
    flipped = !flipped;
    buildBoardSkeleton();
    renderPlayerNames();
    renderBoard();
  });

  // ---------------- Durum metni / oyuncu isimleri ----------------

  function renderPlayerNames() {
    const bottomColor = flipped ? 'black' : 'white';
    const topColor = flipped ? 'white' : 'black';
    const nameFor = (color) => color === 'white' ? whiteUsername : blackUsername;
    const suffix = (color) => (color === myColor ? ' (Sen)' : '');
    $('bottomName').textContent = nameFor(bottomColor) + suffix(bottomColor);
    $('topName').textContent = nameFor(topColor) + suffix(topColor);
  }

  function renderStatus() {
    const box = $('statusBox');
    const onBook = isOnBook();
    const turnText = currentWhiteToMove ? 'Sırada: Beyaz' : 'Sırada: Siyah';
    const noteText = onBook ? '' : ' — kitaptan sapıldı (bu hamleler gerçek oyunda oynanmadı)';
    box.textContent = turnText + noteText;
  }

  // ---------------- Değerlendirme (eval bar / etiket / PV) ----------------

  function cpToWhitePercent(cp) {
    const clamped = Math.max(-1000, Math.min(1000, cp));
    return 50 + 50 * (clamped / 1000);
  }

  function setEvalBarPercent(whitePercent) {
    $('evalBarWhite').style.height = whitePercent + '%';
    $('evalBarBlack').style.height = (100 - whitePercent) + '%';
  }

  function formatUciMoveList(pv) {
    return pv.map(m => m.slice(0, 2) + '-' + m.slice(2, 4) + (m.length > 4 ? '=' + m.slice(4).toUpperCase() : '')).join('  ');
  }

  function renderEvalNeutral(text) {
    $('evalLabel').textContent = 'Değerlendirme: ' + text;
    $('pvBox').textContent = '-';
    setEvalBarPercent(50);
    bestMoveHighlight = null;
  }

  function renderEval(data) {
    if (data.noLegalMoves) {
      renderEvalNeutral('oyun bu pozisyonda bitiyor (hamle yok)');
      renderBoard();
      return;
    }
    if (data.insufficientMaterial) {
      renderEvalNeutral('berabere (yetersiz taş)');
      renderBoard();
      return;
    }
    const result = data.result;
    if (!result) {
      renderEvalNeutral('-');
      renderBoard();
      return;
    }

    const whiteToMove = data.whiteToMove;
    let labelText;
    let whitePercent;

    if (result.scoreMate !== null && result.scoreMate !== undefined) {
      const whiteMate = whiteToMove ? result.scoreMate : -result.scoreMate;
      if (whiteMate > 0) {
        labelText = `Beyaz mat ediyor (#${Math.abs(whiteMate)})`;
        whitePercent = 99;
      } else {
        labelText = `Siyah mat ediyor (#${Math.abs(whiteMate)})`;
        whitePercent = 1;
      }
    } else {
      const whiteCp = whiteToMove ? result.scoreCp : -result.scoreCp;
      const pawns = (whiteCp / 100).toFixed(2);
      const sign = whiteCp > 0 ? '+' : '';
      labelText = `${sign}${pawns} (${whiteCp >= 0 ? 'Beyaz avantajlı' : 'Siyah avantajlı'})`;
      whitePercent = cpToWhitePercent(whiteCp);
    }

    $('evalLabel').textContent = 'Değerlendirme: ' + labelText;
    setEvalBarPercent(whitePercent);
    $('pvBox').textContent = result.pv && result.pv.length ? formatUciMoveList(result.pv) : (result.bestMove ? formatUciMoveList([result.bestMove]) : '-');

    bestMoveHighlight = result.bestMove ? { from: result.bestMove.slice(0, 2), to: result.bestMove.slice(2, 4) } : null;
    renderBoard();
  }

  // ---------------- Pozisyon tazeleme (navigasyon sonrası) ----------------

  async function refreshPosition() {
    const myGen = ++generation;
    selected = null;
    renderNavButtons();
    renderMoveList();

    let posData;
    try {
      posData = await api('POST', `/api/game/${gameId}/analysis-position`, { moves: appliedMoves });
    } catch (err) {
      if (myGen !== generation) return;
      $('statusBox').textContent = 'Pozisyon hesaplanamadı: ' + err.message;
      return;
    }
    if (myGen !== generation) return;

    currentFen = posData.fen;
    currentLegalMoves = posData.legalMoves;
    currentWhiteToMove = posData.whiteToMove;
    bestMoveHighlight = null;

    renderBoard();
    renderStatus();
    renderNavButtons();

    $('evalLabel').textContent = 'Değerlendirme: hesaplanıyor...';
    $('pvBox').textContent = '...';

    let evalData;
    try {
      evalData = await api('POST', `/api/game/${gameId}/analysis-evaluate`, { moves: appliedMoves });
    } catch (err) {
      if (myGen !== generation) return;
      $('evalLabel').textContent = 'Değerlendirme alınamadı: ' + err.message;
      return;
    }
    if (myGen !== generation) return;

    renderEval(evalData);
  }

  // ---------------- Tahta renkleri (oyun sayfasıyla aynı, ortak ayar) ----------------

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

  // ---------------- Başlangıç ----------------

  async function init() {
    try {
      me = await api('GET', '/api/me');
    } catch {
      window.location.href = '/';
      return;
    }
    $('userName').textContent = me.username;
    $('userRating').textContent = me.rating;

    let info;
    try {
      info = await api('GET', `/api/game/${gameId}/analysis-start`);
    } catch (err) {
      $('statusBox').textContent = 'Analiz açılamadı: ' + err.message;
      return;
    }

    startFen = info.startFen;
    bookMoves = info.movesUci || [];
    bookSan = info.sanMoves || [];
    whiteId = info.whiteId;
    blackId = info.blackId;
    whiteUsername = info.whiteUsername;
    blackUsername = info.blackUsername;

    myColor = me.id === whiteId ? 'white' : (me.id === blackId ? 'black' : null);
    flipped = myColor === 'black';

    $('backLink').href = '/game.html?id=' + gameId;

    buildBoardSkeleton();
    renderPlayerNames();

    // C# masaüstü uygulamasındaki gibi analiz varsayılan olarak oyunun
    // SONUNDA açılıyor (bitmiş oyunun son pozisyonu).
    appliedMoves = bookMoves.slice();
    await refreshPosition();
  }

  initBoardColorSettings();
  init();
})();
