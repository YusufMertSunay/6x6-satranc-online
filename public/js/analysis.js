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

  // gameId YOKSA: oyuncu hiç oyun oynamadan doğrudan "serbest analiz"
  // tahtasını açmış demektir -- bu durumda gerçek bir oyuna bağlı olmayan,
  // START_FEN'den (başlangıç pozisyonundan) başlayan uçlar (server.js:
  // /api/free-analysis-*) kullanılıyor.
  const freeMode = !gameId;

  // Analiz uçlarının (start/position/evaluate) yolunu moda göre seçer.
  function analysisPath(sub) {
    return freeMode ? ('/api/free-' + sub) : `/api/game/${gameId}/${sub}`;
  }

  let me = null;
  let myColor = null; // 'white' | 'black' — sadece varsayılan yön ve "(Sen)" etiketi için
  let flipped = false;

  let whiteId = null, blackId = null;
  let whiteUsername = '?', blackUsername = '?';
  let whiteRating = null, blackRating = null;
  let startFen = null;
  let clockHistory = []; // clockHistory[k] = k hamle oynanmışken geçerli olan saatler (bkz. gameManager.js)
  let timeControlCategory = 'bullet';

  // Süre kutucuğunun "az kaldı" (kırmızı) uyarısına geçeceği eşik, kategoriye
  // göre değişiyor: Bullet'te 10 sn, Blitz'te 30 sn, Rapid ve Klasik'te 1 dk
  // — oyun ekranındaki (game.js) eşiklerle BİREBİR AYNI.
  const LOW_TIME_MS = { bullet: 10000, blitz: 30000, rapid: 60000, classical: 60000 };

  let bookMoves = [];   // oyunun GERÇEKTE oynanmış hamleleri (UCI) — SABİT
  let bookSan = [];     // aynı hamlelerin SAN gösterimi — SABİT

  let appliedMoves = []; // şu anda tahtada uygulanmış hamleler (DEĞİŞEBİLİR — sapma burada olur)
  let selected = null;
  let currentFen = null;
  let currentLegalMoves = [];
  let currentWhiteToMove = true;
  let currentInCheck = false; // görüntülenen pozisyonda sırası gelen tarafın şahı çekiliyor mu?

  let generation = 0; // her navigasyonda artar; eski (gecikmiş) motor cevapları bununla elenir
  let bestMoveHighlight = null; // { from, to } ya da null

  // Motor artık bir pozisyon için TOPLAM 9 saniye (kesintisiz) düşünüp bu
  // süre boyunca birkaç kez ARA GÜNCELLEME gönderiyor (bkz. server.js:
  // streamAnalysisEvaluate) -- kullanıcı hızlıca başka bir pozisyona
  // geçerse, hâlâ süren ÖNCEKİ isteği burada saklanan AbortController ile
  // iptal ediyoruz ki sunucudaki motor boşuna 9 saniyeye kadar meşgul
  // kalmasın (bkz. streamEval).
  let currentEvalAbort = null;

  // ---------------- Sürükle-bırak (drag & drop) durumu ----------------
  // Oyun ekranındaki (game.js) ile birebir aynı mantık: taşları tıklayarak
  // VEYA sürükleyerek oynatabilmek için Pointer Events kullanıyoruz; küçük
  // bir eşik aşılmadan sürükleme başlamıyor, böylece düz tıklama akışı
  // (onSquareClick) hiç değişmeden çalışmaya devam ediyor.
  let dragState = null;
  let suppressNextClick = false;
  const DRAG_THRESHOLD_PX = 5;

  async function api(method, pathname, body) {
    const res = await fetch(pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { }
    if (!res.ok) {
      const err = new Error((json && json.error) || I18N.t('err.unknown'));
      err.payload = json;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // Değerlendirme (analysis-evaluate) artık TEK bir JSON cevabı değil,
  // sunucunun motor 9 saniye boyunca düşünürken 1/3/5/7/9. saniyelerde
  // yazdığı BİRDEN ÇOK JSON satırı (NDJSON -- her satır kendi başına geçerli
  // bir JSON nesnesi) olarak akıyor (bkz. server.js: streamAnalysisEvaluate).
  // Bu fonksiyon her satır geldikçe onUpdate(chunk) çağırıyor -- çağıran
  // taraf (refreshPosition), her çağrıda ekranı (en iyi hamle oku + PV
  // kutucuğu) güncelliyor, böylece motor hâlâ düşünürken sonuç birkaç kez
  // güncellenmiş oluyor (masaüstü/WinForms uygulamasındaki davranışla aynı).
  //
  // Kullanıcı hızlıca başka bir pozisyona geçerse (yeni bir refreshPosition
  // çağrısı bu fonksiyonu tekrar çağırırsa), ÖNCEKİ isteği currentEvalAbort
  // ile iptal ediyoruz -- hem burada gelecek eski/gecikmiş güncellemeleri
  // görmezden gelmek için hem de SUNUCUDAKİ motorun artık kimsenin
  // beklemediği bir hesaplamayla 9 saniyeye kadar meşgul kalmaması için
  // (sunucu tarafı bunu req'in 'close' olayından anlayıp motoru erken
  // durduruyor, bkz. server.js).
  async function streamEval(pathname, body, onUpdate) {
    if (currentEvalAbort) { try { currentEvalAbort.abort(); } catch { /* zaten bitmiş olabilir */ } }
    const abortController = new AbortController();
    currentEvalAbort = abortController;

    const res = await fetch(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    if (!res.ok) {
      let json = null; try { json = await res.json(); } catch { }
      const err = new Error((json && json.error) || I18N.t('err.unknown'));
      err.payload = json;
      err.status = res.status;
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch { continue; }
        onUpdate(chunk);
      }
    }
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

  // Tehdit altındaki (şah çekilen) tarafın şahının bulunduğu kareyi bulur —
  // FEN'in "sırası kimde" alanına bakıyoruz, çünkü şah çekilmesi HER ZAMAN
  // sırası gelen tarafın başına gelir. currentInCheck sunucudan geliyor
  // (bkz. server.js /analysis-position).
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
  let squareEls = []; // [r][c] -> element (dış kare div'i)
  let pieceSlotEls = []; // [r][c] -> element (taş görselinin çizildiği İÇ katman -- koordinat
                          // etiketleri kareden AYRI durduğu için renderBoard() artık dış
                          // kareyi değil, sadece bu iç katmanı innerHTML ile değiştiriyor)

  function buildBoardSkeleton() {
    boardEl.innerHTML = '';
    squareEls = Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE));
    pieceSlotEls = Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE));
    for (let dr = 0; dr < BOARD_SIZE; dr++) {
      for (let dc = 0; dc < BOARD_SIZE; dc++) {
        const r = flipped ? BOARD_SIZE - 1 - dr : dr;
        const c = flipped ? BOARD_SIZE - 1 - dc : dc;
        const div = document.createElement('div');
        const isLight = (r + c) % 2 === 0;
        div.className = 'square ' + (isLight ? 'light' : 'dark');
        div.dataset.r = r;
        div.dataset.c = c;

        // Taş görseli buraya (dış kareye değil) çiziliyor -- böylece
        // renderBoard() her tetiklendiğinde koordinat etiketleri SİLİNMİYOR.
        const pieceSlot = document.createElement('div');
        pieceSlot.className = 'piece-slot';
        div.appendChild(pieceSlot);

        // Tahta koordinatları (lichess'teki gibi): EKRANDA en alttaki satırın
        // karelerinin sol-altına dosya harfi (a-f), EKRANDA en sağdaki
        // sütunun karelerinin sağ-üstüne sıra numarası (1-6) ekleniyor. r/c
        // yukarıda flip'e göre zaten doğru hesaplandığından, tahta
        // çevrildiğinde bu etiketler de otomatik olarak doğru köşeye geçer.
        if (dr === BOARD_SIZE - 1) {
          const fileLabel = document.createElement('span');
          fileLabel.className = 'coord-label coord-file';
          fileLabel.textContent = String.fromCharCode('a'.charCodeAt(0) + c);
          div.appendChild(fileLabel);
        }
        if (dc === BOARD_SIZE - 1) {
          const rankLabel = document.createElement('span');
          rankLabel.className = 'coord-label coord-rank';
          rankLabel.textContent = String(BOARD_SIZE - r);
          div.appendChild(rankLabel);
        }

        div.addEventListener('click', () => onSquareClick(r, c));
        div.addEventListener('pointerdown', (e) => onSquarePointerDown(e, r, c));
        boardEl.appendChild(div);
        squareEls[r][c] = div;
        pieceSlotEls[r][c] = pieceSlot;
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

    const checkedKing = currentInCheck ? findCheckedKingSquare(grid, currentFen) : null;

    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const el = squareEls[r][c];
        const piece = grid[r][c];
        // Sürükleme sırasında taş kaynağı karede görsel taşı çizmiyoruz —
        // onun yerine ekranda gezen "hayalet" görsel gösteriliyor.
        const isDragSource = !!(dragState && dragState.dragging && r === dragState.fromR && c === dragState.fromC);
        pieceSlotEls[r][c].innerHTML = (piece && !isDragSource)
          ? `<img class="piece-img" src="${pieceImgSrc(piece)}" alt="${GLYPHS[piece]}">`
          : '';

        const sq = squareName(r, c);
        el.classList.toggle('selected', selected === sq);
        el.classList.toggle('last-move', sq === lastFrom || sq === lastTo);
        el.classList.toggle('in-check', !!checkedKing && checkedKing.r === r && checkedKing.c === c);

        const isLegalDest = selected && currentLegalMoves.some(m => m.startsWith(selected) && m.slice(2, 4) === sq);
        el.classList.toggle('legal-dest', !!isLegalDest);
      }
    }

    drawBestMoveArrow();
  }

  // Kare adını (ör. "e4") satır/sütun indeksine çevirir — motorun önerdiği
  // en iyi hamlenin okunu çizerken kalkış/varış karelerinin EKRANDAKİ
  // (flip'e göre değişebilen) konumunu bulmak için kullanılıyor.
  function rcOfSquare(sq) {
    const c = sq.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(sq.substring(1), 10);
    const r = BOARD_SIZE - rank;
    return { r, c };
  }

  // Motorun önerdiği en iyi hamleyi Lichess'teki gibi yarı saydam mavi bir
  // OK ile tahtanın üzerine çizer (kare çerçevesiyle değil). Kareler
  // flip'e göre yer değiştirebildiği için konumları CSS'ten değil,
  // gerçek ekran koordinatlarından (getBoundingClientRect) hesaplıyoruz —
  // böylece tahta çevrildiğinde ok da otomatik olarak doğru yerde çıkıyor.
  function drawBestMoveArrow() {
    const svg = $('bestMoveArrow');
    svg.innerHTML = '';
    if (!bestMoveHighlight) return;

    const boardRect = boardEl.getBoundingClientRect();
    if (!boardRect.width || !boardRect.height) return;
    svg.setAttribute('viewBox', `0 0 ${boardRect.width} ${boardRect.height}`);

    const { r: rFrom, c: cFrom } = rcOfSquare(bestMoveHighlight.from);
    const { r: rTo, c: cTo } = rcOfSquare(bestMoveHighlight.to);
    const fromEl = squareEls[rFrom] && squareEls[rFrom][cFrom];
    const toEl = squareEls[rTo] && squareEls[rTo][cTo];
    if (!fromEl || !toEl) return;

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const x1 = fromRect.left - boardRect.left + fromRect.width / 2;
    const y1 = fromRect.top - boardRect.top + fromRect.height / 2;
    const x2 = toRect.left - boardRect.left + toRect.width / 2;
    const y2 = toRect.top - boardRect.top + toRect.height / 2;

    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len, uy = dy / len;
    const sq = fromRect.width;

    // Ok ucu tam hedef karenin merkezine değil, biraz öncesine kadar
    // uzansın ki üzerindeki taşı tamamen kapatmasın.
    const tipX = x2 - ux * (sq * 0.12);
    const tipY = y2 - uy * (sq * 0.12);
    const lineEndX = tipX - ux * (sq * 0.22);
    const lineEndY = tipY - uy * (sq * 0.22);

    const color = 'rgba(21, 107, 255, 0.55)';
    const ns = 'http://www.w3.org/2000/svg';

    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', lineEndX);
    line.setAttribute('y2', lineEndY);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', Math.max(6, sq * 0.14));
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);

    const angle = Math.atan2(dy, dx);
    const headLen = sq * 0.30;
    const headWidth = sq * 0.24;
    const baseX = tipX - Math.cos(angle) * headLen;
    const baseY = tipY - Math.sin(angle) * headLen;
    const leftX = baseX + Math.cos(angle + Math.PI / 2) * (headWidth / 2);
    const leftY = baseY + Math.sin(angle + Math.PI / 2) * (headWidth / 2);
    const rightX = baseX + Math.cos(angle - Math.PI / 2) * (headWidth / 2);
    const rightY = baseY + Math.sin(angle - Math.PI / 2) * (headWidth / 2);

    const head = document.createElementNS(ns, 'polygon');
    head.setAttribute('points', `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
    head.setAttribute('fill', color);
    svg.appendChild(head);
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

  // ---------------- Sürükle-bırak (drag & drop) ----------------

  function onSquarePointerDown(e, r, c) {
    if (!currentFen) return;
    const grid = fenToGrid(currentFen);
    const piece = grid[r][c];
    if (!pieceBelongsToSideToMove(piece)) return;
    dragState = {
      pointerId: e.pointerId,
      fromR: r,
      fromC: c,
      fromSq: squareName(r, c),
      piece,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      ghostEl: null,
      ghostW: 0,
      ghostH: 0,
    };
  }

  function positionGhost(x, y) {
    if (!dragState || !dragState.ghostEl) return;
    dragState.ghostEl.style.left = (x - dragState.ghostW / 2) + 'px';
    dragState.ghostEl.style.top = (y - dragState.ghostH / 2) + 'px';
  }

  function startDragging(e) {
    dragState.dragging = true;
    selected = dragState.fromSq;
    const rect = squareEls[dragState.fromR][dragState.fromC].getBoundingClientRect();
    const ghost = document.createElement('img');
    ghost.className = 'drag-ghost';
    ghost.src = pieceImgSrc(dragState.piece);
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    dragState.ghostEl = ghost;
    dragState.ghostW = rect.width;
    dragState.ghostH = rect.height;
    positionGhost(e.clientX, e.clientY);
    renderBoard();
  }

  function cleanupDrag() {
    if (dragState && dragState.ghostEl) dragState.ghostEl.remove();
    dragState = null;
  }

  function onDocumentPointerMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    if (!dragState.dragging) {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      startDragging(e);
    }
    positionGhost(e.clientX, e.clientY);
  }

  function onDocumentPointerUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    if (!dragState.dragging) {
      // Eşik aşılmadı — düz bir tıklamaydı, native 'click' olayı zaten
      // onSquareClick'i tetikleyecek.
      dragState = null;
      return;
    }

    // NOT: Bırakma tahtanın dışında olduysa tarayıcı hiç 'click' olayı
    // üretmeyebilir (mousedown/mouseup hedefleri farklı) — bu durumda
    // bayrağın sonsuza dek 'true' kalıp bir sonraki gerçek tıklamayı
    // yutmaması için kısa bir yedek sıfırlama (setTimeout 0) da ekliyoruz.
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 0);

    const fromSq = dragState.fromSq;
    let dropSq = null;
    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    const squareEl = targetEl && targetEl.closest ? targetEl.closest('.square') : null;
    if (squareEl && boardEl.contains(squareEl)) {
      const r = parseInt(squareEl.dataset.r, 10);
      const c = parseInt(squareEl.dataset.c, 10);
      dropSq = squareName(r, c);
    }

    cleanupDrag();
    selected = null;

    // Alakasız bir kareye ya da tahtanın dışına bırakıldıysa, ya da kendi
    // karesine bırakıldıysa: hamleyi hiç oynatma.
    if (!dropSq || dropSq === fromSq) {
      renderBoard();
      return;
    }

    const matches = currentLegalMoves.filter(m => m.startsWith(fromSq) && m.slice(2, 4) === dropSq);
    if (matches.length === 0) {
      renderBoard();
      return;
    }

    if (matches.length === 1) {
      appliedMoves.push(matches[0]);
      refreshPosition();
    } else {
      const options = matches.map(m => m.slice(4));
      const sideIsWhite = currentWhiteToMove;
      showPromotionModal(options, sideIsWhite, (choice) => {
        appliedMoves.push(fromSq + dropSq + choice);
        refreshPosition();
      });
    }
  }

  document.addEventListener('pointermove', onDocumentPointerMove);
  document.addEventListener('pointerup', onDocumentPointerUp);
  document.addEventListener('pointercancel', () => {
    cleanupDrag();
    selected = null;
    if (currentFen) renderBoard();
  });

  boardEl.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

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
  // Değerlendirme çubuğu (eval bar) da tahtayla aynı yönde dursun diye —
  // tahta çevrilince (siyah altta gösterilince) çubuk da ters dönüp beyaz
  // üstte, siyah altta görünür (bkz. style.css: .eval-bar-container.flipped).
  function syncEvalBarOrientation() {
    $('evalBarContainer').classList.toggle('flipped', flipped);
  }

  $('flipBoardBtn').addEventListener('click', () => {
    flipped = !flipped;
    buildBoardSkeleton();
    renderPlayerNames();
    syncEvalBarOrientation();
    renderBoard();
    renderClocks();
  });

  // ---------------- Durum metni / oyuncu isimleri ----------------

  function renderPlayerNames() {
    const bottomColor = flipped ? 'black' : 'white';
    const topColor = flipped ? 'white' : 'black';
    // whiteUsername/blackUsername gerçek bir oyunda her zaman dolu geliyor;
    // serbest analizde (freeMode) sunucu bilerek null gönderiyor (bkz.
    // server.js: /api/free-analysis-start) -- bu durumda "Beyaz"/"Siyah"
    // yazısını arayüz diline göre BİZ üretiyoruz.
    const nameFor = (color) => (color === 'white' ? whiteUsername : blackUsername) || I18N.t('common.' + color);
    const ratingFor = (color) => color === 'white' ? whiteRating : blackRating;
    const suffix = (color) => (color === myColor ? I18N.t('common.youSuffix') : '');
    $('bottomName').textContent = nameFor(bottomColor) + suffix(bottomColor);
    $('topName').textContent = nameFor(topColor) + suffix(topColor);
    // İsimlerin yanında, bu oyunun süre kontrolü kategorisine ait Elo puanı
    // (hem kendiminki hem rakibinki) gösteriliyor.
    const bottomRating = ratingFor(bottomColor);
    const topRating = ratingFor(topColor);
    $('bottomRating').textContent = typeof bottomRating === 'number' ? bottomRating : '';
    $('topRating').textContent = typeof topRating === 'number' ? topRating : '';
  }

  // ---------------- Saatler (o pozisyondaki GERÇEK saat durumu) ----------------
  // ÖNEMLİ: Bu, canlı bir sayaç DEĞİL — analiz sırasında geriye/ileriye
  // gidildikçe, o hamle GERÇEKTE oynandığında saatlerin ne olduğunu
  // (sunucudan gelen clockHistory'den) sabit bir şekilde gösteriyor.
  function formatMs(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) ms = 0;
    if (ms < 0) ms = 0;
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function renderClocks() {
    if (!clockHistory || !clockHistory.length) {
      $('bottomClock').textContent = '--:--';
      $('topClock').textContent = '--:--';
      $('bottomClock').classList.remove('low');
      $('topClock').classList.remove('low');
      return;
    }
    // appliedMoves.length, o anki pozisyonda kaç GERÇEK/varsayılan hamle
    // uygulandığını verir; kitaptan sapıldıysa (appliedMoves.length gerçek
    // oyundakinden uzun olabilir) elimizdeki SON bilinen (gerçek) saat
    // durumunu göstermeye devam ediyoruz — sapılan hamleler için saat
    // bilgisi zaten hiç var olmadı.
    const idx = Math.min(appliedMoves.length, clockHistory.length - 1);
    const snap = clockHistory[idx];
    const bottomColor = flipped ? 'black' : 'white';
    const topColor = flipped ? 'white' : 'black';
    const msFor = (color) => color === 'white' ? snap.whiteClockMs : snap.blackClockMs;
    const bottomMs = msFor(bottomColor);
    const topMs = msFor(topColor);
    $('bottomClock').textContent = formatMs(bottomMs);
    $('topClock').textContent = formatMs(topMs);

    // O pozisyondaki saat, kategoriye ait eşiğin altındaysa (ya da eşitse)
    // kutucuk kırmızı gösteriliyor — oyun ekranındakiyle aynı mantık.
    const lowThreshold = LOW_TIME_MS[timeControlCategory] ?? 30000;
    $('bottomClock').classList.toggle('low', bottomMs <= lowThreshold);
    $('topClock').classList.toggle('low', topMs <= lowThreshold);
  }

  function renderStatus() {
    const box = $('statusBox');
    const onBook = isOnBook();
    const turnText = currentWhiteToMove ? I18N.t('analysis.turnWhite') : I18N.t('analysis.turnBlack');
    // "Kitaptan sapıldı" uyarısı SADECE gerçek bir oyunun analizinde anlamlı
    // (freeMode'da zaten sabit bir "kitap" yok, bookMoves her zaman
    // appliedMoves'a eşitleniyor — bkz. refreshPosition).
    const noteText = (!freeMode && !onBook) ? I18N.t('analysis.deviatedNote') : '';
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

  // Motor PV'yi UCI olarak veriyor (ör. "e2e4"); bu, gerçek notasyona (SAN)
  // çevrilemediği (sunucu hatası vb.) NADİR bir durumda kullanılan YEDEK
  // gösterim. Normalde PV, sunucu tarafında lib/notation.js ile gerçek
  // satranç notasyonuna (Nf3, exd5, O-O, Qh5+ gibi) çevrilip result.sanPv
  // olarak geliyor — bkz. formatSanPv.
  function formatUciMoveList(pv) {
    return pv.map(m => m.slice(0, 2) + '-' + m.slice(2, 4) + (m.length > 4 ? '=' + m.slice(4).toUpperCase() : '')).join('  ');
  }

  // Gerçek notasyona çevrilmiş PV'yi ("Nf3","Bd6","O-O" gibi), oyundaki
  // hamle listesiyle aynı standartta hamle numaralarıyla birlikte
  // biçimlendirir (ör. "16.Nf3 Bd6 17.O-O Re8").
  function formatSanPv(sanPv, whiteToMoveStart, fullmoveStart) {
    const tokens = [];
    let isWhite = whiteToMoveStart;
    let num = fullmoveStart;
    sanPv.forEach((san, idx) => {
      if (isWhite) {
        tokens.push(num + '.' + san);
      } else {
        tokens.push((idx === 0 ? num + '...' : '') + san);
        num++;
      }
      isWhite = !isWhite;
    });
    return tokens.join(' ');
  }

  function renderEvalNeutral(text) {
    $('evalLabel').textContent = I18N.t('analysis.evalPrefix') + text;
    $('pvBox').textContent = '-';
    setEvalBarPercent(50);
    bestMoveHighlight = null;
  }

  // Dil değişince az önce gösterilen değerlendirmeyi (motoru YENİDEN
  // ÇALIŞTIRMADAN) doğru dilde yeniden çizebilmek için son gelen veriyi
  // saklıyoruz — bkz. dosya sonundaki 'langchange' dinleyicisi.
  let lastEvalData = null;

  function renderEval(data) {
    lastEvalData = data;
    if (data.noLegalMoves) {
      renderEvalNeutral(I18N.t('analysis.evalGameOverNoMoves'));
      renderBoard();
      return;
    }
    if (data.insufficientMaterial) {
      renderEvalNeutral(I18N.t('analysis.evalDrawInsufficientMaterial'));
      renderBoard();
      return;
    }
    const result = data.result;
    if (!result) {
      renderEvalNeutral(I18N.t('common.dash'));
      renderBoard();
      return;
    }

    const whiteToMove = data.whiteToMove;
    let labelText;
    let whitePercent;

    if (result.scoreMate !== null && result.scoreMate !== undefined) {
      const whiteMate = whiteToMove ? result.scoreMate : -result.scoreMate;
      if (whiteMate > 0) {
        labelText = I18N.t('analysis.whiteMatesIn', { n: Math.abs(whiteMate) });
        whitePercent = 99;
      } else {
        labelText = I18N.t('analysis.blackMatesIn', { n: Math.abs(whiteMate) });
        whitePercent = 1;
      }
    } else {
      const whiteCp = whiteToMove ? result.scoreCp : -result.scoreCp;
      const pawns = (whiteCp / 100).toFixed(2);
      const sign = whiteCp > 0 ? '+' : '';
      const advantageText = whiteCp >= 0 ? I18N.t('analysis.whiteAdvantage') : I18N.t('analysis.blackAdvantage');
      labelText = `${sign}${pawns} (${advantageText})`;
      whitePercent = cpToWhitePercent(whiteCp);
    }

    $('evalLabel').textContent = I18N.t('analysis.evalPrefix') + labelText;
    setEvalBarPercent(whitePercent);

    if (result.sanPv && result.sanPv.length) {
      const fullmoveStart = parseInt((data.fen.split(' ')[5] || '1'), 10) || 1;
      $('pvBox').textContent = formatSanPv(result.sanPv, whiteToMove, fullmoveStart);
    } else if (result.pv && result.pv.length) {
      // Sunucu SAN üretemediyse (nadir bir durum) UCI biçimine düşüyoruz.
      $('pvBox').textContent = formatUciMoveList(result.pv);
    } else if (result.bestMove) {
      $('pvBox').textContent = formatUciMoveList([result.bestMove]);
    } else {
      $('pvBox').textContent = '-';
    }

    bestMoveHighlight = result.bestMove ? { from: result.bestMove.slice(0, 2), to: result.bestMove.slice(2, 4) } : null;
    renderBoard();
  }

  // ---------------- Pozisyon tazeleme (navigasyon sonrası) ----------------

  async function refreshPosition() {
    const myGen = ++generation;
    selected = null;
    renderNavButtons();
    renderMoveList();

    // ÖNEMLİ: önceki (hâlâ sürüyor olabilecek, motoru 9 saniyeye kadar
    // meşgul edebilecek) bir değerlendirme isteği varsa BURADA, pozisyon
    // isteğini göndermeden ÖNCE iptal ediyoruz -- yoksa aşağıdaki
    // analysis-position isteği, analysisEngine'i hâlâ meşgul eden ESKİ
    // değerlendirme görevi bitene kadar (motoru yeniden kullanmak için)
    // gereksiz yere sırada bekleyebilir (streamEval() kendi içinde de aynı
    // iptali yapıyor, ama o zamana kadar pozisyon isteği zaten kuyrukta
    // takılmış olurdu).
    if (currentEvalAbort) {
      try { currentEvalAbort.abort(); } catch { /* zaten bitmiş olabilir */ }
      currentEvalAbort = null;
    }

    let posData;
    try {
      posData = await api('POST', analysisPath('analysis-position'), { moves: appliedMoves });
    } catch (err) {
      if (myGen !== generation) return;
      $('statusBox').textContent = I18N.t('err.positionCalcFailedPrefix') + I18N.tErr(err);
      return;
    }
    if (myGen !== generation) return;

    currentFen = posData.fen;
    currentLegalMoves = posData.legalMoves;
    currentWhiteToMove = posData.whiteToMove;
    currentInCheck = !!posData.inCheck;
    bestMoveHighlight = null;

    if (freeMode) {
      // Serbest analizde sabit bir "kitap" (gerçek oyun) yok -- o ana kadar
      // OYNANAN hamlelerin kendisi kitap sayılır (sunucu her pozisyon
      // isteğinde güncel SAN listesini de gönderiyor, bkz. server.js
      // /api/free-analysis-position). Bu sayede "kitaptan sapıldı" uyarısı
      // hiç görünmez ve hamle listesi oynadıkça doğru şekilde güncellenir.
      bookMoves = appliedMoves.slice();
      bookSan = posData.sanMoves || [];
      renderMoveList();
    }

    renderBoard();
    renderStatus();
    renderNavButtons();
    renderClocks();

    $('evalLabel').textContent = I18N.t('analysis.evalCalculating');
    $('pvBox').textContent = '...';

    try {
      await streamEval(analysisPath('analysis-evaluate'), { moves: appliedMoves }, (chunk) => {
        // Motor hâlâ 9 saniyelik düşünmesini sürdürürken bu callback 1/3/5/7/9.
        // saniyelerde birkaç kez çağrılıyor -- her çağrıda ekranı (en iyi
        // hamle oku + PV kutucuğu) GÜNCELLİYORUZ, en son (final:true) çağrı
        // motorun nihai kararını yansıtıyor.
        if (myGen !== generation) return;
        renderEval(chunk);
      });
    } catch (err) {
      if (myGen !== generation) return;
      // AbortError, kullanıcı başka bir pozisyona geçtiği için BİZİM
      // kendimizin iptal ettiği (streamEval içinde) önceki istekten geliyor
      // -- bu gerçek bir hata değil, sessizce yoksayıyoruz (yeni
      // refreshPosition çağrısı zaten kendi güncellemesini gönderecek).
      if (err.name === 'AbortError') return;
      $('evalLabel').textContent = I18N.t('err.evalFailedPrefix') + I18N.tErr(err);
    }
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
    I18N.syncFromAccount(me.language);
    $('userName').textContent = me.username;

    let info;
    try {
      info = await api('GET', analysisPath('analysis-start'));
    } catch (err) {
      $('statusBox').textContent = I18N.t('err.analysisOpenFailedPrefix') + I18N.tErr(err);
      return;
    }

    startFen = info.startFen;
    bookMoves = info.movesUci || [];
    bookSan = info.sanMoves || [];
    whiteId = info.whiteId;
    blackId = info.blackId;
    whiteUsername = info.whiteUsername;
    blackUsername = info.blackUsername;
    whiteRating = typeof info.whiteRating === 'number' ? info.whiteRating : null;
    blackRating = typeof info.blackRating === 'number' ? info.blackRating : null;
    clockHistory = info.clockHistory || [];
    // Serbest analizde (freeMode) gerçek bir süre kontrolü kategorisi yok --
    // bunu 'bullet'a düşürürsek puan rozeti YANLIŞLIKLA kullanıcının bullet
    // puanını gösterirdi; bu yüzden freeMode'da bilerek null bırakıyoruz.
    timeControlCategory = freeMode ? null : (info.timeControlCategory || 'bullet');

    // Puan rozeti bu oyunun süre kontrolü kategorisine ait puanı gösteriyor
    // (Elo artık tek bir sayı değil, kategoriye göre ayrı — bkz. store.js).
    // freeMode'da kategori olmadığı için rozet boş ('-') kalır.
    $('userRating').textContent = (timeControlCategory && me.ratings) ? (me.ratings[timeControlCategory] ?? '-') : '-';

    myColor = me.id === whiteId ? 'white' : (me.id === blackId ? 'black' : null);
    flipped = myColor === 'black';

    if (freeMode) {
      // Gerçek bir oyuna bağlı olmadığımız için "Oyuna dön" linkinin bir
      // anlamı yok -- gizleyip yanındaki "Lobiye dön" linkini bırakıyoruz.
      $('backLink').classList.add('hidden');
    } else {
      $('backLink').href = '/game.html?id=' + gameId;
    }

    buildBoardSkeleton();
    renderPlayerNames();
    syncEvalBarOrientation();

    // C# masaüstü uygulamasındaki gibi analiz varsayılan olarak oyunun
    // SONUNDA açılıyor (bitmiş oyunun son pozisyonu).
    appliedMoves = bookMoves.slice();
    await refreshPosition();
  }

  // ---------------- Dil değişince görünen ekranı yeniden çiz ----------------
  document.title = I18N.t('title.analysis');
  window.addEventListener('langchange', () => {
    document.title = I18N.t('title.analysis');
    if (currentFen) {
      renderPlayerNames();
      renderStatus();
      if (lastEvalData) renderEval(lastEvalData);
    }
  });

  initBoardColorSettings();
  init();
})();
