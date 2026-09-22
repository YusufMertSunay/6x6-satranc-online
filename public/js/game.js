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
  // Kategori adı arayüz diline göre değişebildiği için (Klasik/Classical)
  // sabit bir tabloya değil, i18n sözlüğüne bakıyoruz (bkz. categoryLabel).
  function categoryLabel(category) {
    return I18N.t('cat.' + category);
  }

  // Süre kutucuğunun "az kaldı" (kırmızı) uyarısına geçeceği eşik, kategoriye
  // göre değişiyor: Bullet'te 10 sn, Blitz'te 30 sn, Rapid ve Klasik'te 1 dk.
  const LOW_TIME_MS = { bullet: 10000, blitz: 30000, rapid: 60000, classical: 60000 };

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

  // ---------------- Sürükle-bırak (drag & drop) durumu ----------------
  // Taşları hem tıklayarak (yukarıdaki selected/legalMoves akışı) hem de
  // lichess/chess.com'daki gibi SÜRÜKLEYEREK oynatabilmek için: Pointer
  // Events API kullanıyoruz (fare + dokunmatik, tek kod yolu). Küçük bir
  // eşik (DRAG_THRESHOLD_PX) aşılmadan "sürükleme" başlatılmıyor — bu
  // sayede düz bir tıklama, native 'click' olayına dokunulmadan eskisi
  // gibi çalışmaya devam ediyor.
  let dragState = null; // { pointerId, fromR, fromC, fromSq, piece, startX, startY, dragging, ghostEl, ghostW, ghostH }
  let suppressNextClick = false;
  const DRAG_THRESHOLD_PX = 5;

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
      const err = new Error((json && json.error) || I18N.t('err.unknown'));
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
        // Sürükleme sırasında, taş kaynağı karede görsel taşı çizmiyoruz —
        // onun yerine ekranda gezen "hayalet" (ghost) görsel gösteriliyor.
        const isDragSource = !!(dragState && dragState.dragging && r === dragState.fromR && c === dragState.fromC);
        pieceSlotEls[r][c].innerHTML = (piece && !isDragSource)
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
        setStatusMessage(I18N.tErr(err), true);
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

  // ---------------- Sürükle-bırak (drag & drop) ----------------

  function onSquarePointerDown(e, r, c) {
    // Sadece SOL tık/dokunuş bir taş sürüklemesi başlatabilir -- sağ tık artık
    // ayrı bir amaç için kullanılıyor (ok/çember işaretlemesi, aşağıda). Bu
    // kontrol olmadan, fare her zaman aynı "pointerId"yi paylaştığından, bir
    // taşın üzerinde sağ tıklayıp sürüklemek yanlışlıkla bir hamle sürüklemesi
    // gibi algılanabiliyordu.
    if (e.button !== 0) return;
    if (!state || state.status !== 'active') return;
    if (!myTurn()) return;
    const grid = fenToGrid(state.currentFen);
    const piece = grid[r][c];
    if (!pieceBelongsToMe(piece)) return;
    // Henüz "sürükleme" başlatmıyoruz — sadece olası bir sürüklemenin
    // başlangıç noktasını kaydediyoruz. Eşik aşılmazsa bu, native 'click'
    // olayına bırakılan düz bir tıklama olarak kalacak.
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

  async function onDocumentPointerUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    if (!dragState.dragging) {
      // Eşik hiç aşılmadı — bu düz bir tıklamaydı, native 'click' olayı
      // zaten onSquareClick'i tetikleyecek. Sadece durumu temizliyoruz.
      dragState = null;
      return;
    }

    // Gerçek bir sürükleme yapıldı — bunu takip edecek senkron 'click'
    // olayını (varsa) görmezden gel (aynı hamlenin iki kez işlenmemesi için).
    // NOT: Bırakma tahtanın DIŞINDA olduysa (ör. senaryo 3) mousedown/mouseup
    // hedefleri farklı olduğu için tarayıcı hiç 'click' olayı üretmeyebilir
    // — bu durumda bayrak sonsuza kadar 'true' kalıp BİR SONRAKİ gerçek
    // tıklamayı yanlışlıkla yutar. Bunu önlemek için, olay varsa onu
    // tüketen yakalayıcı listener'a EK OLARAK, kısa bir süre sonra bayrağı
    // otomatik olarak sıfırlayan bir yedek (setTimeout 0) koyuyoruz.
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

    // Alakasız bir kareye ya da tahtanın dışına bırakıldıysa (dropSq yok)
    // veya kendi karesine bırakıldıysa: hamleyi HİÇ oynatma, taş eski
    // yerine geri dönsün (renderBoard yeniden gerçek durumu çizecek).
    if (!dropSq || dropSq === fromSq) {
      renderBoard();
      return;
    }

    const matches = legalMoves.filter(m => m.startsWith(fromSq) && m.slice(2, 4) === dropSq);
    if (matches.length === 0) {
      renderBoard();
      return;
    }

    renderBoard();

    if (matches.length === 1) {
      await submitMove(fromSq, dropSq, null);
    } else {
      const options = matches.map(m => m.slice(4));
      showPromotionModal(options, async (choice) => {
        await submitMove(fromSq, dropSq, choice);
      });
    }
  }

  document.addEventListener('pointermove', onDocumentPointerMove);
  document.addEventListener('pointerup', onDocumentPointerUp);
  document.addEventListener('pointercancel', () => {
    cleanupDrag();
    selected = null;
    if (state) renderBoard();
  });

  // Gerçek bir sürüklemenin ARDINDAN gelebilecek senkron 'click' olayını
  // yakalama (capture) aşamasında keserek onSquareClick'e hiç ulaşmasını
  // engelliyoruz (aksi halde aynı hamle iki kez işlenmeye çalışılabilir).
  boardEl.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // ---------------- Sağ tık işaretlemeleri (ok / çember) ----------------
  // Lichess'teki gibi: tahtada bir kareye SAĞ TIKLAYIP sürüklemek (o karede
  // taş olsa bile) silik yeşil bir OK çizer; sürüklemeden düz bir sağ tık ise
  // silik yeşil bir ÇEMBER çizer. Her ikisi de kalıcıdır -- oyuncu tahtada
  // herhangi bir yere SOL tıklayana kadar ekranda kalır. Bu özellik sadece
  // fare ile (masaüstünde) anlamlı olduğu için düz mouse olayları kullanılıyor
  // (dokunmatik cihazlarda sağ tık zaten yok).
  let boardAnnotations = []; // {type:'circle', r, c} | {type:'arrow', fromR, fromC, toR, toC}
  let rightDragState = null; // {fromR, fromC, lastR, lastC, moved}
  const annotationsSvg = $('userAnnotationsSvg');

  function annotationsEqual(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'circle') return a.r === b.r && a.c === b.c;
    return a.fromR === b.fromR && a.fromC === b.fromC && a.toR === b.toR && a.toC === b.toC;
  }

  // Bir kareden diğerine giden hareketin, HERHANGİ BİR taşın (kale/fil/vezir
  // gibi düz/çapraz herhangi bir mesafe, ya da at gibi L şeklinde) yapabileceği
  // bir şekil olup olmadığını kontrol eder. Bu, sürükleme sırasında okun
  // sadece "geçerli" karelere kadar uzamasını sağlamak için kullanılıyor.
  function isValidPieceShape(fromR, fromC, toR, toC) {
    const dr = toR - fromR, dc = toC - fromC;
    if (dr === 0 && dc === 0) return false;
    if (dr === 0 || dc === 0) return true; // düz (yatay/dikey), herhangi bir mesafe
    if (Math.abs(dr) === Math.abs(dc)) return true; // çapraz, herhangi bir mesafe
    if ((Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2)) return true; // at (L şekli)
    return false;
  }

  function squareFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const sqEl = el && el.closest ? el.closest('.square') : null;
    if (!sqEl || !boardEl.contains(sqEl)) return null;
    return { r: parseInt(sqEl.dataset.r, 10), c: parseInt(sqEl.dataset.c, 10) };
  }

  function annotationCenter(boardRect, r, c) {
    const el = squareEls[r] && squareEls[r][c];
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left - boardRect.left + rect.width / 2, y: rect.top - boardRect.top + rect.height / 2, sq: rect.width };
  }

  const ANNOTATION_COLOR = 'rgba(21, 145, 40, 0.6)';
  const ns = 'http://www.w3.org/2000/svg';

  function drawOneAnnotation(boardRect, anno) {
    if (anno.type === 'circle') {
      const p = annotationCenter(boardRect, anno.r, anno.c);
      if (!p) return;
      const strokeW = Math.max(3, p.sq * 0.08);
      const radius = Math.max(4, p.sq / 2 - strokeW / 2 - 2);
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', p.x);
      circle.setAttribute('cy', p.y);
      circle.setAttribute('r', radius);
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', ANNOTATION_COLOR);
      circle.setAttribute('stroke-width', strokeW);
      annotationsSvg.appendChild(circle);
      return;
    }
    const p1 = annotationCenter(boardRect, anno.fromR, anno.fromC);
    const p2 = annotationCenter(boardRect, anno.toR, anno.toC);
    if (!p1 || !p2) return;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len, uy = dy / len;
    const sq = p1.sq;
    const tipX = p2.x - ux * (sq * 0.12);
    const tipY = p2.y - uy * (sq * 0.12);
    const lineEndX = tipX - ux * (sq * 0.22);
    const lineEndY = tipY - uy * (sq * 0.22);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', p1.x);
    line.setAttribute('y1', p1.y);
    line.setAttribute('x2', lineEndX);
    line.setAttribute('y2', lineEndY);
    line.setAttribute('stroke', ANNOTATION_COLOR);
    line.setAttribute('stroke-width', Math.max(6, sq * 0.14));
    line.setAttribute('stroke-linecap', 'round');
    annotationsSvg.appendChild(line);

    const angle = Math.atan2(dy, dx);
    const headLen = sq * 0.30;
    const headWidth = sq * 0.26;
    const baseX = tipX - Math.cos(angle) * headLen;
    const baseY = tipY - Math.sin(angle) * headLen;
    const leftX = baseX + Math.cos(angle + Math.PI / 2) * (headWidth / 2);
    const leftY = baseY + Math.sin(angle + Math.PI / 2) * (headWidth / 2);
    const rightX = baseX + Math.cos(angle - Math.PI / 2) * (headWidth / 2);
    const rightY = baseY + Math.sin(angle - Math.PI / 2) * (headWidth / 2);
    const head = document.createElementNS(ns, 'polygon');
    head.setAttribute('points', `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
    head.setAttribute('fill', ANNOTATION_COLOR);
    annotationsSvg.appendChild(head);
  }

  function renderAnnotations(livePreview) {
    annotationsSvg.innerHTML = '';
    const boardRect = boardEl.getBoundingClientRect();
    if (!boardRect.width || !boardRect.height) return;
    annotationsSvg.setAttribute('viewBox', `0 0 ${boardRect.width} ${boardRect.height}`);
    for (const anno of boardAnnotations) drawOneAnnotation(boardRect, anno);
    if (livePreview) drawOneAnnotation(boardRect, livePreview);
  }

  function clearAnnotations() {
    if (!boardAnnotations.length) return;
    boardAnnotations = [];
    renderAnnotations();
  }

  // Tahtanın kendi sağ tık menüsünü (native context menu) hiç göstermiyoruz --
  // aksi halde her sağ tıkta tarayıcının kendi menüsü açılırdı.
  boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

  boardEl.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      // Sol tık: tahtada HERHANGİ bir yere (taş olsun olmasın) sol tıklanınca
      // tüm işaretlemeler temizlenir -- bu, gerçek bir hamle oynatmak için
      // yapılan tıklama/sürüklemeyi de otomatik olarak kapsar.
      clearAnnotations();
      return;
    }
    if (e.button !== 2) return;
    const start = squareFromPoint(e.clientX, e.clientY);
    if (!start) return;
    rightDragState = { fromR: start.r, fromC: start.c, lastR: start.r, lastC: start.c, moved: false };
  });

  document.addEventListener('mousemove', (e) => {
    if (!rightDragState) return;
    const cur = squareFromPoint(e.clientX, e.clientY);
    if (cur && (cur.r !== rightDragState.fromR || cur.c !== rightDragState.fromC)) {
      if (isValidPieceShape(rightDragState.fromR, rightDragState.fromC, cur.r, cur.c)) {
        rightDragState.lastR = cur.r;
        rightDragState.lastC = cur.c;
        rightDragState.moved = true;
      }
      // Geçersiz bir şekle (ör. a1->d2) gelindiyse: en son GEÇERLİ karede
      // kalmaya devam ediyoruz (lastR/lastC güncellenmiyor).
    }
    renderAnnotations(rightDragState.moved ? {
      type: 'arrow', fromR: rightDragState.fromR, fromC: rightDragState.fromC,
      toR: rightDragState.lastR, toC: rightDragState.lastC,
    } : null);
  });

  document.addEventListener('mouseup', (e) => {
    if (!rightDragState || e.button !== 2) return;
    const st = rightDragState;
    rightDragState = null;
    const anno = st.moved
      ? { type: 'arrow', fromR: st.fromR, fromC: st.fromC, toR: st.lastR, toC: st.lastC }
      : { type: 'circle', r: st.fromR, c: st.fromC };
    const idx = boardAnnotations.findIndex(a => annotationsEqual(a, anno));
    if (idx >= 0) boardAnnotations.splice(idx, 1);
    else boardAnnotations.push(anno);
    renderAnnotations();
  });

  window.addEventListener('resize', () => renderAnnotations());

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

    // Süre kutucuğu, o oyunun süre kontrolü KATEGORİSİNE ait eşiğin altına
    // (veya eşitine) düşünce kırmızıya dönüyor — ister kendi süren ister
    // rakibinki olsun, ilgili kutucuk kırmızı gösteriliyor.
    const lowThreshold = LOW_TIME_MS[state.timeControlCategory] ?? 30000;
    myEl.classList.toggle('low', myMs <= lowThreshold);
    oppEl.classList.toggle('low', oppMs <= lowThreshold);

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
      checkmate: 'result.checkmate',
      stalemate: 'result.stalemate',
      insufficient_material: 'result.insufficientMaterial',
      resign: 'result.resigned',
      timeout: 'result.timeout',
      timeout_insufficient_material: 'result.timeoutInsufficientMaterial',
      draw_agreed: 'result.drawAgreed',
      threefold_repetition: 'result.threefold',
      fifty_move_rule: 'result.fiftyMove',
    };
    return map[reason] ? I18N.t(map[reason]) : reason;
  }

  function setStatusMessage(text, isError) {
    const box = $('statusBox');
    box.textContent = text;
    box.classList.toggle('error-text', !!isError);
  }

  function renderStatus() {
    if (state.status === 'active') {
      setStatusMessage(myTurn() ? I18N.t('game.yourTurn') : I18N.t('game.opponentThinking'), false);
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
      outcomeText = I18N.t('result.draw');
      cls = '';
    } else if (state.winnerColor === myColor) {
      outcomeText = I18N.t('result.wonBanner');
      cls = '';
    } else {
      outcomeText = I18N.t('result.lost');
      cls = 'loss';
    }
    banner.className = 'game-over-banner' + (cls ? ' ' + cls : '');
    let ratingLine = '';
    if (typeof state.whiteRatingAfter === 'number') {
      const myRatingAfter = myColor === 'white' ? state.whiteRatingAfter : state.blackRatingAfter;
      const catLabel = state.timeControlCategory ? categoryLabel(state.timeControlCategory) : '';
      ratingLine = `<div class="rating-change">${I18N.t('game.newRatingLine', { category: catLabel, rating: myRatingAfter })}</div>`;
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
      offerBtn.textContent = iOffered ? I18N.t('game.rematchPending') : I18N.t('game.offerRematch');
    }
  }

  function renderPlayerNames() {
    const myName = myColor === 'white' ? state.whiteUsername : state.blackUsername;
    const oppName = myColor === 'white' ? state.blackUsername : state.whiteUsername;
    const myRating = myColor === 'white' ? state.whiteRating : state.blackRating;
    const oppRating = myColor === 'white' ? state.blackRating : state.whiteRating;
    $('bottomName').textContent = (myName || me.username) + I18N.t('common.youSuffix');
    $('topName').textContent = oppName || I18N.t('common.opponent');
    // İsimlerin yanında, bu oyunun süre kontrolü KATEGORİSİNE ait Elo puanı
    // (hem kendimin hem rakibimin) gösteriliyor — bkz. server.js'de
    // eklenen state.whiteRating/blackRating.
    $('bottomRating').textContent = typeof myRating === 'number' ? myRating : '';
    $('topRating').textContent = typeof oppRating === 'number' ? oppRating : '';
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
    if (!confirm(I18N.t('game.confirmResign'))) return;
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/resign`);
      mergeState(newState);
      renderAll();
    } catch (err) { alert(I18N.tErr(err)); }
  });

  $('offerDrawBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/offer-draw`);
      mergeState(newState);
      renderAll();
    } catch (err) { alert(I18N.tErr(err)); }
  });

  $('acceptDrawBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/respond-draw`, { accept: true });
      mergeState(newState);
      renderAll();
    } catch (err) { alert(I18N.tErr(err)); }
  });

  $('declineDrawBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/respond-draw`, { accept: false });
      mergeState(newState);
      renderAll();
    } catch (err) { alert(I18N.tErr(err)); }
  });

  $('offerRematchBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/offer-rematch`);
      mergeState(newState);
      renderAll();
    } catch (err) { alert(I18N.tErr(err)); }
  });

  $('acceptRematchBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/respond-rematch`, { accept: true });
      mergeState(newState);
      renderAll();
      // Kabul edilince sunucu yeni oyunu başlatıp 'match_found' olayını
      // gönderecek — yönlendirme o olay geldiğinde yapılıyor.
    } catch (err) { alert(I18N.tErr(err)); }
  });

  $('openAnalysisBtn').addEventListener('click', () => {
    window.location.href = '/analysis.html?id=' + gameId;
  });

  $('declineRematchBtn').addEventListener('click', async () => {
    try {
      const { state: newState } = await api('POST', `/api/game/${gameId}/respond-rematch`, { accept: false });
      mergeState(newState);
      renderAll();
    } catch (err) { alert(I18N.tErr(err)); }
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
    I18N.syncFromAccount(me.language);
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
      setStatusMessage(I18N.t('err.gameLoadFailedPrefix') + I18N.tErr(err), true);
      return;
    }

    // Puan rozeti bu oyunun süre kontrolü KATEGORİSİNE ait puanı gösteriyor
    // (Elo artık tek bir sayı değil, kategoriye göre ayrı — bkz. store.js).
    const myCategory = state.timeControlCategory || 'bullet';
    $('userRating').textContent = (me.ratings && me.ratings[myCategory]) ?? '-';

    myColor = state.whiteId === me.id ? 'white' : (state.blackId === me.id ? 'black' : null);
    if (!myColor) {
      setStatusMessage(I18N.t('err.NOT_A_PLAYER'), true);
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

  // ---------------- Dil değişince görünen ekranı yeniden çiz ----------------
  document.title = I18N.t('title.game');
  window.addEventListener('langchange', () => {
    document.title = I18N.t('title.game');
    if (state) { renderPlayerNames(); renderAll(); }
  });

  initBoardColorSettings();
  init();
})();
