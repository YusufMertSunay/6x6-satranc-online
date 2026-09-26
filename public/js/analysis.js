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
  let whiteProvisional = false, blackProvisional = false;
  let startFen = null;
  let clockHistory = []; // clockHistory[k] = k hamle oynanmışken geçerli olan saatler (bkz. gameManager.js)
  let timeControlCategory = 'bullet';

  // Süre kutucuğunun "az kaldı" (kırmızı) uyarısına geçeceği eşik, kategoriye
  // göre değişiyor: Bullet'te 10 sn, Blitz'te 30 sn, Rapid ve Klasik'te 1 dk
  // — oyun ekranındaki (game.js) eşiklerle BİREBİR AYNI.
  const LOW_TIME_MS = { bullet: 10000, blitz: 30000, rapid: 60000, classical: 60000 };

  // ---- Varyant AĞACI (lichess tarzı) ----
  // tree: sunucudan gelen (ve sunucuda kalıcı olarak saklanan) tüm hamle
  // ağacı -- bkz. lib/analysisTree.js. { startFen, nodes:{id:{id,parentId,
  // uci,san,isBook,children:[]}}, rootChildren:[id,...], nextId }.
  // currentPath: KÖKTEN şu anki pozisyona kadar olan düğüm id'leri dizisi
  // (boşsa başlangıç pozisyonundayız). redoStack: Geri (Back) ile terk
  // edilen düğümler -- tarayıcının ileri/geri geçmişi gibi, İleri (Forward)
  // ile yeniden aynı yola dönülebilsin diye (yeni bir dal denenmediği
  // sürece hiçbir varyant KAYBOLMAZ, sadece "geçmişte" kalır).
  let tree = null;
  let currentPath = [];
  let redoStack = [];
  let selected = null;
  let currentFen = null;
  let currentLegalMoves = [];
  let currentWhiteToMove = true;
  let currentInCheck = false; // görüntülenen pozisyonda sırası gelen tarafın şahı çekiliyor mu?

  let generation = 0; // her navigasyonda artar; eski (gecikmiş) motor cevapları bununla elenir
  let bestMoveHighlight = null; // { from, to, promotion, whiteToMove } ya da null (promotion terfi hamlelerinde dolu)

  // Kullanıcı isteğiyle: analiz tahtasında (hem oyun-bazlı hem serbest
  // analizde -- bu dosya ikisini de yönetiyor) motoru bir düğmeyle (dil
  // seçme düğmesi gibi) tamamen kapatıp açabiliyoruz. Kapalıyken motora HİÇ
  // istek gönderilmiyor (sunucu/motor boşuna meşgul edilmiyor) ve en iyi
  // hamle oku (mavi ok) otomatik olarak siliniyor -- bkz. initEngineToggle /
  // requestEvalForCurrentPosition. Tercih, dil tercihinin aksine hesaba
  // değil, sadece bu tarayıcıya (localStorage) kaydediliyor -- bkz.
  // initBoardColorSettings'teki aynı kalıp.
  let engineEnabled = true;

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
    const lastMoveNodeId = currentNodeId();
    const lastMove = lastMoveNodeId ? tree.nodes[lastMoveNodeId].uci : null;
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

    // Motorun önerdiği hamle bir TERFİ ise (bestMove 5. karakteri terfi
    // taşını belirtir, ör. "b7a8q"): Lichess'teki gibi, önerilen terfi
    // taşının SOLUK (yarı saydam) bir görselini hedef karenin üzerine
    // bindiriyoruz -- kullanıcı notasyonu okumadan hangi taşa terfi
    // önerildiğini hemen görebilsin.
    if (bestMoveHighlight.promotion) {
      const letter = bestMoveHighlight.whiteToMove
        ? bestMoveHighlight.promotion.toUpperCase()
        : bestMoveHighlight.promotion.toLowerCase();
      const ghostSize = sq * 0.78; // .piece-img ile aynı oran (bkz. style.css)
      const ghost = document.createElementNS(ns, 'image');
      ghost.setAttributeNS('http://www.w3.org/1999/xlink', 'href', pieceImgSrc(letter));
      ghost.setAttribute('href', pieceImgSrc(letter));
      ghost.setAttribute('x', x2 - ghostSize / 2);
      ghost.setAttribute('y', y2 - ghostSize / 2);
      ghost.setAttribute('width', ghostSize);
      ghost.setAttribute('height', ghostSize);
      ghost.setAttribute('opacity', '0.55');
      ghost.style.pointerEvents = 'none';
      svg.appendChild(ghost);
    }
  }

  // ---------------- Varyant ağacı yardımcıları ----------------
  // (lib/analysisTree.js'deki server-side yardımcıların İSTEMCİ TARAFI
  // eşdeğerleri -- burada motor/FEN gerekmiyor, sadece ağaç üzerinde
  // gezinme/okuma yapılıyor.)

  function childrenOf(parentId) {
    if (!tree) return [];
    if (!parentId) return tree.rootChildren || [];
    const node = tree.nodes[parentId];
    return node ? node.children : [];
  }

  // Kökten nodeId'ye kadar olan düğüm id'leri dizisini verir (nodeId dahil).
  function nodeIdPathTo(nodeId) {
    const path = [];
    let cur = nodeId;
    while (cur) {
      path.unshift(cur);
      const node = tree.nodes[cur];
      cur = node ? node.parentId : null;
    }
    return path;
  }

  // Bir düğüm id dizisini (currentPath gibi) motora gönderilecek UCI hamle
  // dizisine çevirir (analysis-position/analysis-evaluate uçları hâlâ düz
  // bir { moves: [...] } gövdesi bekliyor -- ağacın kendisi hakkında hiçbir
  // şey bilmelerine gerek yok).
  function movesForPath(path) {
    return path.map(id => tree.nodes[id].uci);
  }

  function currentNodeId() {
    return currentPath.length ? currentPath[currentPath.length - 1] : null;
  }

  // Şu anki pozisyona giden yoldaki HER düğüm gerçek oyunun ana hattının
  // (isBook) bir parçaysa hâlâ "kitaptayız" demektir (kök -- yani hiç hamle
  // oynanmamış hâl -- her zaman kitapta sayılır, boş dizinin every() değeri
  // true döner). Serbest analizde (freeMode) hiçbir düğüm isBook olmadığı
  // için en az bir hamle oynanır oynanmaz bu hep false döner -- bu yüzden
  // "kitaptan sapıldı" notu renderStatus'ta zaten freeMode'da gösterilmiyor.
  function isOnBook() {
    return currentPath.every(id => tree.nodes[id] && tree.nodes[id].isBook);
  }

  // ---------------- Etkileşim (tahtaya tıklayarak hamle deneme) ----------------

  // Tahtaya tıklayarak/sürükleyerek ya da terfi seçerek oynanan HER hamle
  // buradan geçer -- hamleyi sunucudaki (kalıcı) varyant ağacına ekletir
  // (aynı ebeveynin altında aynı hamle zaten varsa sunucu MEVCUT düğümü
  // döndürür, çift varyant oluşmaz -- bkz. server.js: addMoveToTree), yeni
  // düğümü currentPath'e ekler ve pozisyonu tazeler. Kullanıcı YENİ bir dal
  // denediği için (redoStack'teki "ileri" geçmişiyle birebir aynı hamle
  // DEĞİLSE) redoStack temizlenir -- tarayıcı geçmişinde yeni bir sayfaya
  // gitmenin "ileri" geçmişini silmesi gibi.
  async function playMove(uci) {
    const parentId = currentNodeId();
    let resp;
    try {
      resp = await api('POST', analysisPath('analysis-tree/add-move'), { parentId, uci });
    } catch (err) {
      alert(I18N.tErr(err));
      return;
    }
    tree = resp.tree;
    currentPath = [...currentPath, resp.nodeId];
    if (redoStack.length && redoStack[redoStack.length - 1] === resp.nodeId) {
      redoStack.pop();
    } else {
      redoStack = [];
    }
    selected = null;
    refreshPosition();
  }

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
      playMove(matches[0]);
    } else {
      // Terfi — birden fazla eşleşme (farklı terfi taşları).
      const options = matches.map(m => m.slice(4));
      const sideIsWhite = currentWhiteToMove;
      showPromotionModal(options, sideIsWhite, (choice) => {
        playMove(from + sq + choice);
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
    // Sadece SOL tık/dokunuş bir taş sürüklemesi başlatabilir -- sağ tık artık
    // ayrı bir amaç için kullanılıyor (ok/çember işaretlemesi, aşağıda).
    if (e.button !== 0) return;
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
      playMove(matches[0]);
    } else {
      const options = matches.map(m => m.slice(4));
      const sideIsWhite = currentWhiteToMove;
      showPromotionModal(options, sideIsWhite, (choice) => {
        playMove(fromSq + dropSq + choice);
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

  // ---------------- Sağ tık işaretlemeleri (ok / çember) ----------------
  // Lichess'teki gibi: tahtada bir kareye SAĞ TIKLAYIP sürüklemek (o karede
  // taş olsa bile) silik yeşil bir OK çizer; sürüklemeden düz bir sağ tık ise
  // silik yeşil bir ÇEMBER çizer. Her ikisi de kalıcıdır -- oyuncu tahtada
  // herhangi bir yere SOL tıklayana kadar ekranda kalır. Motorun mavi "en iyi
  // hamle" okundan (bkz. drawBestMoveArrow / #bestMoveArrow) TAMAMEN AYRI bir
  // SVG katmanı (#userAnnotationsSvg) kullanıyoruz -- böylece ikisi birbirini
  // silmiyor.
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
  // bir şekil olup olmadığını kontrol eder -- sürükleme sırasında okun sadece
  // "geçerli" karelere kadar uzamasını sağlamak için kullanılıyor.
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
  const annoNs = 'http://www.w3.org/2000/svg';

  function drawOneAnnotation(boardRect, anno) {
    if (anno.type === 'circle') {
      const p = annotationCenter(boardRect, anno.r, anno.c);
      if (!p) return;
      const strokeW = Math.max(3, p.sq * 0.08);
      const radius = Math.max(4, p.sq / 2 - strokeW / 2 - 2);
      const circle = document.createElementNS(annoNs, 'circle');
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
    const line = document.createElementNS(annoNs, 'line');
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
    const head = document.createElementNS(annoNs, 'polygon');
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

  // Tahtanın kendi sağ tık menüsünü (native context menu) hiç göstermiyoruz.
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

  // ---------------- Hamle listesi (varyant ağacı) ----------------
  // Lichess tarzı: ana hat (her düğümün İLK çocuğu) düz akışta yazılıyor;
  // aynı ebeveynin altındaki DİĞER çocuklar (kullanıcının aynı hamlede
  // denediği farklı alternatifler) parantez içinde, ayrı bir "alt varyant"
  // olarak hemen ardından ekleniyor -- bu mantık RECURSIVE olduğu için bir
  // varyantın içinde başka bir varyant (2., 3., 4. ... denemeler) da aynı
  // şekilde iç içe gösterilebiliyor.

  function navigateToNode(nodeId) {
    currentPath = nodeId ? nodeIdPathTo(nodeId) : [];
    redoStack = [];
    selected = null;
    refreshPosition();
  }

  async function deleteNode(nodeId) {
    if (!confirm(I18N.t('analysis.confirmDeleteVariation'))) return;
    let resp;
    try {
      resp = await api('POST', analysisPath('analysis-tree/delete-node'), { nodeId });
    } catch (err) {
      alert(I18N.tErr(err));
      return;
    }
    tree = resp.tree;
    // Şu an gösterilen pozisyon, silinen alt ağacın İÇİNDEYSE (silinen
    // düğümün kendisi ya da bir devamıysa), en yakın hâlâ var olan atalara
    // (silinen düğümün ebeveynine) geri dönüyoruz.
    const idx = currentPath.indexOf(nodeId);
    if (idx !== -1) currentPath = currentPath.slice(0, idx);
    redoStack = [];
    selected = null;
    refreshPosition();
  }

  function makeMoveSpan(node, numberPrefix) {
    const wrap = document.createElement('span');
    wrap.className = 'san-move' + (node.id === currentNodeId() ? ' current-move' : '');
    wrap.textContent = (numberPrefix || '') + node.san;
    wrap.addEventListener('click', () => navigateToNode(node.id));
    // Gerçek oyunun hamleleri (isBook) SİLİNEMEZ -- sadece kullanıcının
    // kendi eklediği (kitaptan sapan) hamlelerin yanında "sil" düğmesi var.
    if (!node.isBook) {
      const delBtn = document.createElement('span');
      delBtn.className = 'variation-delete-btn';
      delBtn.textContent = '✕';
      delBtn.title = I18N.t('analysis.deleteVariationTitle');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteNode(node.id);
      });
      wrap.appendChild(delBtn);
    }
    return wrap;
  }

  // parentId'nin İLK çocuğundan başlayarak ana hattı (depth arttıkça) çizer;
  // yol üzerindeki her ebeveynin FAZLADAN çocukları varsa (ikinci, üçüncü...
  // denemeler) her biri için parantez içinde, kendi devamıyla birlikte
  // (yine bu fonksiyonu recursive çağırarak) ayrı bir varyant bloğu ekler.
  function buildLineFragment(startParentId, startDepth) {
    const frag = document.createDocumentFragment();
    let parentId = startParentId;
    let depth = startDepth;
    let first = true;
    while (true) {
      const kids = childrenOf(parentId);
      if (!kids.length) break;
      const isWhite = depth % 2 === 1;
      const moveNum = Math.ceil(depth / 2);

      const mainNode = tree.nodes[kids[0]];
      const mainPrefix = isWhite ? (moveNum + '. ') : (first ? (moveNum + '… ') : '');
      frag.appendChild(makeMoveSpan(mainNode, mainPrefix));
      frag.appendChild(document.createTextNode(' '));

      for (let i = 1; i < kids.length; i++) {
        const varNode = tree.nodes[kids[i]];
        const varPrefix = isWhite ? (moveNum + '. ') : (moveNum + '… ');
        const block = document.createElement('span');
        block.className = 'variation-block';
        block.appendChild(document.createTextNode('('));
        block.appendChild(makeMoveSpan(varNode, varPrefix));
        block.appendChild(document.createTextNode(' '));
        block.appendChild(buildLineFragment(varNode.id, depth + 1));
        block.appendChild(document.createTextNode(') '));
        frag.appendChild(block);
      }

      parentId = kids[0];
      depth += 1;
      first = false;
    }
    return frag;
  }

  function renderMoveTree() {
    const box = $('movesBox');
    box.innerHTML = '';
    box.appendChild(buildLineFragment(null, 1));
    // Notasyon kutucuğu sığmaz hale gelince (uzun bir oyun/varyant), şu anki
    // hamleyi (varsa) her zaman görünür alanda tutarak OTOMATİK OLARAK
    // aşağı (ya da yukarı) kaydırıyoruz -- kullanıcı manuel kaydırmak
    // zorunda kalmıyor.
    //
    // ÖNEMLİ: Element.scrollIntoView() KASITLI OLARAK KULLANILMIYOR --
    // 'nearest' seçeneğine rağmen bazı tarayıcılarda (özellikle küçültülmüş
    // pencerede/telefonda), hedef öğeyi görünür kılmak için sadece bu
    // kutunun içini değil SAYFANIN KENDİSİNİ de aşağı kaydırabiliyordu
    // ("bir hamle oynatınca ekran otomatik aşağı kayıyor" hatasının kökü
    // buydu). Bunun yerine SADECE bu kutunun kendi scrollTop'unu, hedef
    // öğenin kutu içindeki konumuna göre ELLE hesaplayıp ayarlıyoruz --
    // sayfanın/pencerenin kaydırma konumuna kesinlikle hiç dokunmuyor.
    const curEl = box.querySelector('.current-move');
    if (curEl) {
      const boxRect = box.getBoundingClientRect();
      const elRect = curEl.getBoundingClientRect();
      if (elRect.top < boxRect.top) {
        box.scrollTop -= (boxRect.top - elRect.top);
      } else if (elRect.bottom > boxRect.bottom) {
        box.scrollTop += (elRect.bottom - boxRect.bottom);
      }
    } else {
      box.scrollTop = box.scrollHeight;
    }
  }

  // ---------------- Navigasyon düğmeleri ----------------

  // İleri (Forward) gidilecek bir şey var mı? -- ya redoStack'te (Geri ile
  // terk edilmiş ama hâlâ hatırlanan) bir düğüm var, ya da şu anki
  // pozisyonun en az bir çocuğu (devamı) var demektir.
  function canGoForward() {
    if (redoStack.length) return true;
    return childrenOf(currentNodeId()).length > 0;
  }

  function renderNavButtons() {
    $('navStartBtn').disabled = currentPath.length === 0;
    $('navBackBtn').disabled = currentPath.length === 0;
    const fwd = canGoForward();
    $('navForwardBtn').disabled = !fwd;
    $('navEndBtn').disabled = !fwd;
  }

  // Başa (Start): şu ana kadar gezinilen tüm yolu redoStack'e (tarayıcının
  // "ileri" geçmişi gibi) taşır -- böylece İleri'ye basılınca aynı yoldan
  // adım adım (ya da doğrudan Sona ile tek seferde) geri dönülebilir; hiçbir
  // varyant KAYBOLMAZ.
  $('navStartBtn').addEventListener('click', () => {
    while (currentPath.length) redoStack.push(currentPath.pop());
    selected = null;
    refreshPosition();
  });
  $('navBackBtn').addEventListener('click', () => {
    if (currentPath.length === 0) return;
    redoStack.push(currentPath.pop());
    selected = null;
    refreshPosition();
  });
  $('navForwardBtn').addEventListener('click', () => {
    if (redoStack.length) {
      currentPath.push(redoStack.pop());
    } else {
      const kids = childrenOf(currentNodeId());
      if (!kids.length) return;
      currentPath.push(kids[0]); // ana hat -- ilk (en önce eklenen) çocuk
    }
    selected = null;
    refreshPosition();
  });
  // Sona (End): redoStack'te bir "ileri" geçmişi varsa TAMAMINI geri
  // uygulayarak oradan devam eder; yoksa (taze bir dal ya da hiç geri
  // gidilmemiş) şu anki pozisyondan itibaren ana hattı (her düğümün ilk
  // çocuğu) sonuna kadar takip eder.
  $('navEndBtn').addEventListener('click', () => {
    if (redoStack.length) {
      while (redoStack.length) currentPath.push(redoStack.pop());
    } else {
      let parentId = currentNodeId();
      while (true) {
        const kids = childrenOf(parentId);
        if (!kids.length) break;
        currentPath.push(kids[0]);
        parentId = kids[0];
      }
    }
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
    // Tahta çevrilince kare elemanları YENİDEN oluşturulduğu için (yukarıdaki
    // buildBoardSkeleton), hem motorun okunu hem de kullanıcının kendi
    // ok/çember işaretlemelerini YENİ kare konumlarına göre tekrar çiziyoruz.
    if (bestMoveHighlight) drawBestMoveArrow();
    renderAnnotations();
  });

  // ---------------- Durum metni / oyuncu isimleri ----------------

  // Kullanıcı isteği: bir oyuncu bu kategoride henüz 8 puanlı maç
  // oynamadıysa, puanının yanında mavi bir "?" gösterilir (bkz. app.js/
  // game.js'deki AYNI adlı fonksiyon -- ortak bir modül olmadığı için, bu
  // dosyada da aynı mantık tekrarlanıyor).
  function ratingMarkupHtml(rating, provisional) {
    if (!provisional) return String(rating);
    return `${rating}<sup class="provisional-mark" title="${I18N.t('lobby.provisionalRatingTitle')}">?</sup>`;
  }

  function renderPlayerNames() {
    const bottomColor = flipped ? 'black' : 'white';
    const topColor = flipped ? 'white' : 'black';
    // whiteUsername/blackUsername gerçek bir oyunda her zaman dolu geliyor;
    // serbest analizde (freeMode) sunucu bilerek null gönderiyor (bkz.
    // server.js: /api/free-analysis-start) -- bu durumda "Beyaz"/"Siyah"
    // yazısını arayüz diline göre BİZ üretiyoruz.
    const nameFor = (color) => (color === 'white' ? whiteUsername : blackUsername) || I18N.t('common.' + color);
    const ratingFor = (color) => color === 'white' ? whiteRating : blackRating;
    const provisionalFor = (color) => color === 'white' ? whiteProvisional : blackProvisional;
    const suffix = (color) => (color === myColor ? I18N.t('common.youSuffix') : '');
    $('bottomName').textContent = nameFor(bottomColor) + suffix(bottomColor);
    $('topName').textContent = nameFor(topColor) + suffix(topColor);
    // İsimlerin yanında, bu oyunun süre kontrolü kategorisine ait Elo puanı
    // (hem kendiminki hem rakibinki) gösteriliyor -- bu kategoride henüz 8
    // maç oynamamış tarafın puanının yanında mavi "?" işareti çıkıyor.
    const bottomRating = ratingFor(bottomColor);
    const topRating = ratingFor(topColor);
    $('bottomRating').innerHTML = typeof bottomRating === 'number' ? ratingMarkupHtml(bottomRating, provisionalFor(bottomColor)) : '';
    $('topRating').innerHTML = typeof topRating === 'number' ? ratingMarkupHtml(topRating, provisionalFor(topColor)) : '';
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
    // currentPath.length, o anki pozisyonda kaç hamle uygulandığını verir;
    // kitaptan sapıldıysa (currentPath.length gerçek oyundakinden uzun
    // olabilir) elimizdeki SON bilinen (gerçek) saat durumunu göstermeye
    // devam ediyoruz — sapılan hamleler için saat bilgisi zaten hiç var
    // olmadı.
    const idx = Math.min(currentPath.length, clockHistory.length - 1);
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
    // (freeMode'da zaten sabit bir "kitap" yok -- ağaçta hiçbir düğüm
    // isBook değil, bkz. isOnBook).
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

    // bestMove 5 karakterse (ör. "b7a8q") bu bir TERFİ hamlesidir -- 5.
    // karakter (q/r/b/n) önerilen terfi taşını verir; drawBestMoveArrow bunu
    // hedef karenin üzerine soluk bir görsel olarak çiziyor (bkz. yukarısı).
    // whiteToMove'u da saklıyoruz ki terfi taşı DOĞRU RENKTE (terfi eden
    // tarafın rengiyle) çizilsin.
    bestMoveHighlight = result.bestMove ? {
      from: result.bestMove.slice(0, 2),
      to: result.bestMove.slice(2, 4),
      promotion: result.bestMove.length > 4 ? result.bestMove.slice(4) : null,
      whiteToMove,
    } : null;
    renderBoard();
  }

  // Motorun önerdiği varyantın (PV kutucuğu) üzerine tıklanınca: o varyantın
  // TAMAMI (motorun UCI cinsinden önerdiği hamle dizisi -- result.pv) tek
  // seferde ağaca (yeni bir varyant/devam olarak) eklenir VE tahta,
  // varyantın SONUNDA oluşan pozisyona otomatik olarak atlar. Kullanıcı bu
  // hamle dizisinin bir kısmını ya da tamamını istediği zaman (her zamanki
  // "sil" düğmesiyle) silebilir -- book olmadıkları için hepsi silinebilir.
  $('pvBox').addEventListener('click', async () => {
    if (!lastEvalData || !lastEvalData.result || !lastEvalData.result.pv || !lastEvalData.result.pv.length) return;
    const parentId = currentNodeId();
    let resp;
    try {
      resp = await api('POST', analysisPath('analysis-tree/add-line'), { parentId, uciList: lastEvalData.result.pv });
    } catch (err) {
      alert(I18N.tErr(err));
      return;
    }
    tree = resp.tree;
    currentPath = [...currentPath, ...resp.path];
    redoStack = [];
    selected = null;
    refreshPosition();
  });

  // ---------------- Pozisyon tazeleme (navigasyon sonrası) ----------------

  async function refreshPosition() {
    const myGen = ++generation;
    selected = null;
    renderNavButtons();
    renderMoveTree();

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

    const movesSoFar = movesForPath(currentPath);
    let posData;
    try {
      posData = await api('POST', analysisPath('analysis-position'), { moves: movesSoFar });
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

    renderBoard();
    renderStatus();
    renderNavButtons();
    renderClocks();

    await requestEvalForCurrentPosition(myGen, movesSoFar);
  }

  // Bir pozisyon için motor değerlendirmesini ister ve ekranı (eval etiketi,
  // PV kutusu, en iyi hamle oku, eval barı) günceller. refreshPosition()
  // (her navigasyondan sonra) VE motoru düğmeyle yeniden AÇAN kullanıcı
  // (initEngineToggle) tarafından çağrılıyor -- motor KAPALIYKEN sunucuya
  // hiç istek gönderilmiyor, sadece "Motor kapalı" yazısı gösteriliyor ve
  // en iyi hamle oku (varsa) hemen siliniyor (kullanıcı isteği).
  async function requestEvalForCurrentPosition(myGen, movesSoFar) {
    if (!engineEnabled) {
      $('evalLabel').textContent = I18N.t('analysis.engineDisabled');
      $('pvBox').textContent = '-';
      bestMoveHighlight = null;
      drawBestMoveArrow();
      return;
    }

    $('evalLabel').textContent = I18N.t('analysis.evalCalculating');
    $('pvBox').textContent = '...';

    try {
      await streamEval(analysisPath('analysis-evaluate'), { moves: movesSoFar }, (chunk) => {
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

  // ---------------- Motor aç/kapat düğmesi (kullanıcı isteği) ----------------
  // Tercih dil seçimi gibi görsel bir düğme çifti (Açık/Kapalı) ile
  // değiştiriliyor, ama dil tercihinin aksine HESABA değil sadece bu
  // tarayıcıya kaydediliyor (initBoardColorSettings'teki localStorage
  // kalıbıyla aynı) -- çünkü bu, hesap bazında değil cihaz/tarayıcı bazında
  // bir tercih olarak düşünüldü.
  function updateEngineToggleUI() {
    $('engineOnBtn').classList.toggle('active', engineEnabled);
    $('engineOffBtn').classList.toggle('active', !engineEnabled);
  }

  function initEngineToggle() {
    try {
      engineEnabled = localStorage.getItem('analysisEngineEnabled') !== '0';
    } catch { /* localStorage kapalı/engelliyse motor varsayılan olarak açık kalır */ }
    updateEngineToggleUI();

    $('engineOnBtn').addEventListener('click', () => {
      if (engineEnabled) return;
      engineEnabled = true;
      try { localStorage.setItem('analysisEngineEnabled', '1'); } catch { }
      updateEngineToggleUI();
      // Motor yeniden açılınca, o an ekranda duran pozisyon için hemen bir
      // değerlendirme isteği gönderiyoruz -- kullanıcı ayrıca bir hamle
      // yapmak/gezinmek zorunda kalmasın.
      if (currentFen) {
        const myGen = ++generation;
        requestEvalForCurrentPosition(myGen, movesForPath(currentPath));
      }
    });

    $('engineOffBtn').addEventListener('click', () => {
      if (!engineEnabled) return;
      engineEnabled = false;
      try { localStorage.setItem('analysisEngineEnabled', '0'); } catch { }
      updateEngineToggleUI();
      // Sürmekte olan bir değerlendirme isteği varsa iptal ediyoruz (motoru
      // sunucuda boşuna meşgul etmemek için) ve en iyi hamle okunu (mavi ok)
      // kullanıcı isteğiyle HEMEN siliyoruz.
      ++generation;
      if (currentEvalAbort) {
        try { currentEvalAbort.abort(); } catch { /* zaten bitmiş olabilir */ }
        currentEvalAbort = null;
      }
      bestMoveHighlight = null;
      drawBestMoveArrow();
      $('evalLabel').textContent = I18N.t('analysis.engineDisabled');
      $('pvBox').textContent = '-';
    });
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

  // ---------------- Yeni oyun teklifi / komple engelleme / sohbet (kullanıcı isteği) ----------------
  // Kullanıcı isteği: oyun bittikten sonraki bu analiz tahtasında da,
  // OYUNA DÖNMEYE GEREK KALMADAN doğrudan yeni oyun teklif edilebilsin;
  // daha önce eklenen komple engelleme özelliği burada da bir düğme olarak
  // dursun; hem oyuncu+seyirci sohbeti de (birleşik olarak) burada olsun.
  // Bunların HİÇBİRİ freeMode'da (gerçek bir oyuna bağlı olmayan serbest
  // analiz) anlamlı değil -- orada whiteId/blackId/gameId yok.
  let sse = null;
  let rematchOfferBy = null; // null | 'white' | 'black' -- bkz. reloadRematchState
  let opponentUsername = null;
  let opponentIsBlocked = false;
  // NOT: myColor init() içinde (analysis-start cevabı geldikten SONRA)
  // atanıyor -- bu yüzden burada bir kez hesaplayıp sabitlemek yerine, her
  // çağrıldığında GÜNCEL değeri okuyan bir fonksiyon kullanıyoruz.
  function isRealPlayer() { return !freeMode && !!myColor; } // bu bitmiş oyunun iki oyuncusundan biri miyiz?

  async function reloadRematchState() {
    if (freeMode) return;
    try {
      const { state: liveState } = await api('GET', `/api/game/${gameId}`);
      rematchOfferBy = liveState.rematchOfferBy || null;
    } catch { rematchOfferBy = null; }
    renderRematchUi();
  }

  function renderRematchUi() {
    const incomingBanner = $('rematchOfferBanner');
    const actionRow = $('rematchActionRow');
    const offerBtn = $('offerRematchBtn');
    if (!incomingBanner || !actionRow || !offerBtn) return;
    if (!isRealPlayer()) {
      incomingBanner.classList.add('hidden');
      actionRow.classList.add('hidden');
      return;
    }
    const opponentOffered = rematchOfferBy && rematchOfferBy !== myColor;
    incomingBanner.classList.toggle('hidden', !opponentOffered);
    actionRow.classList.toggle('hidden', opponentOffered);
    if (!opponentOffered) {
      const iOffered = !!rematchOfferBy && rematchOfferBy === myColor;
      offerBtn.disabled = iOffered;
      offerBtn.textContent = iOffered ? I18N.t('game.rematchPending') : I18N.t('game.offerRematch');
    }
  }

  if ($('offerRematchBtn')) {
    $('offerRematchBtn').addEventListener('click', async () => {
      try {
        const { state: newState } = await api('POST', `/api/game/${gameId}/offer-rematch`);
        rematchOfferBy = newState.rematchOfferBy || null;
        renderRematchUi();
      } catch (err) { alert(I18N.describeOfferError(err)); }
    });
  }
  if ($('acceptRematchBtn')) {
    $('acceptRematchBtn').addEventListener('click', async () => {
      try {
        await api('POST', `/api/game/${gameId}/respond-rematch`, { accept: true });
        // Kabul edilince sunucu yeni oyunu başlatıp 'match_found' gönderecek
        // -- yönlendirme aşağıdaki SSE dinleyicisinde yapılıyor.
      } catch (err) { alert(I18N.tErr(err)); }
    });
  }
  if ($('declineRematchBtn')) {
    $('declineRematchBtn').addEventListener('click', async () => {
      try {
        await api('POST', `/api/game/${gameId}/respond-rematch`, { accept: false });
        rematchOfferBy = null;
        renderRematchUi();
      } catch (err) { alert(I18N.tErr(err)); }
    });
  }

  async function initBlockOpponentUi() {
    const row = $('blockOpponentRow');
    if (!row) return;
    if (!isRealPlayer()) { row.classList.add('hidden'); return; }
    opponentUsername = myColor === 'white' ? blackUsername : whiteUsername;
    row.classList.remove('hidden');
    try {
      const { usernames } = await api('GET', '/api/block/list');
      opponentIsBlocked = !!opponentUsername && usernames.includes(opponentUsername);
    } catch { opponentIsBlocked = false; }
    renderBlockOpponentButton();
  }

  function renderBlockOpponentButton() {
    const btn = $('blockOpponentBtn');
    if (!btn) return;
    btn.textContent = opponentIsBlocked ? I18N.t('game.unblockOpponentBtn') : I18N.t('game.blockOpponentBtn');
  }

  if ($('blockOpponentBtn')) {
    $('blockOpponentBtn').addEventListener('click', async () => {
      if (!opponentUsername) return;
      try {
        if (opponentIsBlocked) {
          if (!confirm(I18N.t('lobby.unblockConfirm', { username: opponentUsername }))) return;
          await api('POST', '/api/block/remove', { username: opponentUsername });
          opponentIsBlocked = false;
        } else {
          if (!confirm(I18N.t('game.blockOpponentConfirm', { username: opponentUsername }))) return;
          await api('POST', '/api/block/add', { username: opponentUsername });
          opponentIsBlocked = true;
        }
        renderBlockOpponentButton();
        if (window.ChatUI) await ChatUI.reload();
      } catch (err) { alert(I18N.tErr(err)); }
    });
  }

  function connectSse() {
    if (freeMode) return;
    sse = new EventSource('/events');
    sse.addEventListener('rematch_offered', reloadRematchState);
    sse.addEventListener('rematch_declined', reloadRematchState);
    sse.addEventListener('match_found', (e) => {
      const data = JSON.parse(e.data);
      window.location.href = '/game.html?id=' + data.gameId;
    });
    sse.addEventListener('chat_message', (e) => {
      const data = JSON.parse(e.data);
      if (window.ChatUI) ChatUI.handleSseMessage(data);
    });
    sse.onerror = () => { /* tarayıcı otomatik olarak yeniden bağlanmayı dener */ };
  }

  window.addEventListener('beforeunload', () => {
    if (sse) sse.close();
    if (!freeMode) {
      try { fetch(`/api/game/${gameId}/unwatch`, { method: 'POST', keepalive: true }); } catch { /* önemli değil */ }
    }
  });

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
    whiteId = info.whiteId;
    blackId = info.blackId;
    whiteUsername = info.whiteUsername;
    blackUsername = info.blackUsername;
    whiteRating = typeof info.whiteRating === 'number' ? info.whiteRating : null;
    blackRating = typeof info.blackRating === 'number' ? info.blackRating : null;
    whiteProvisional = !!info.whiteProvisional;
    blackProvisional = !!info.blackProvisional;
    clockHistory = info.clockHistory || [];
    // Serbest analizde (freeMode) gerçek bir süre kontrolü kategorisi yok --
    // bunu 'bullet'a düşürürsek puan rozeti YANLIŞLIKLA kullanıcının bullet
    // puanını gösterirdi; bu yüzden freeMode'da bilerek null bırakıyoruz.
    timeControlCategory = freeMode ? null : (info.timeControlCategory || 'bullet');

    // Puan rozeti bu oyunun süre kontrolü kategorisine ait puanı gösteriyor
    // (Elo artık tek bir sayı değil, kategoriye göre ayrı — bkz. store.js).
    // freeMode'da kategori olmadığı için rozet boş ('-') kalır.
    const myRatingValue = (timeControlCategory && me.ratings) ? (me.ratings[timeControlCategory] ?? '-') : '-';
    const myIsProvisional = !!(timeControlCategory && me.provisional && me.provisional[timeControlCategory]);
    $('userRating').innerHTML = typeof myRatingValue === 'number' ? ratingMarkupHtml(myRatingValue, myIsProvisional) : myRatingValue;

    myColor = me.id === whiteId ? 'white' : (me.id === blackId ? 'black' : null);
    flipped = myColor === 'black';

    if (freeMode) {
      // Gerçek bir oyuna bağlı olmadığımız için "Oyuna dön" linkinin bir
      // anlamı yok -- gizleyip yanındaki "Lobiye dön" linkini bırakıyoruz.
      $('backLink').classList.add('hidden');
    } else {
      $('backLink').href = '/game.html?id=' + gameId;
      // Seyirci kaydı (kullanıcı isteği) -- gerçek zamanlı sohbet yayınının
      // kime gideceğini belirlemek için. Gerçek oyuncular da bunu çağırır
      // (zararı yok, bkz. lib/gameManager.js: watchGame).
      try { await api('POST', `/api/game/${gameId}/watch`); } catch { /* önemli değil */ }
      await initBlockOpponentUi();
      await reloadRematchState();
      // Kullanıcı isteği: sohbet SADECE bir oyuna bağlı analizde anlamlı --
      // varsayılan olarak gizli olan #chatSection'ı burada (freeMode
      // DEĞİLKEN) gösteriyoruz (bkz. analysis.html: chatSection açıklaması).
      const chatSectionEl = $('chatSection');
      if (chatSectionEl) chatSectionEl.classList.remove('hidden');
      if (window.ChatUI) await ChatUI.init(gameId, me.id);
      connectSse();
    }

    buildBoardSkeleton();
    renderPlayerNames();
    syncEvalBarOrientation();

    // Kalıcı varyant ağacını yükle (yoksa sunucu, oyun-bazlı analizde
    // gerçek oyunun hamlelerini "isBook" olarak baştan oluşturur; serbest
    // analizde boş bir ağaçla başlar -- bkz. server.js: getOrCreateAnalysisTree).
    let treeResp;
    try {
      treeResp = await api('GET', analysisPath('analysis-tree'));
    } catch (err) {
      $('statusBox').textContent = I18N.t('err.analysisOpenFailedPrefix') + I18N.tErr(err);
      return;
    }
    tree = treeResp.tree;

    // Analiz varsayılan olarak, ağaçtaki ANA HATTIN (her düğümün ilk/en
    // önce eklenen çocuğu) SONUNDA açılıyor -- oyun-bazlı analizde bu,
    // C# masaüstü uygulamasındaki gibi bitmiş oyunun son pozisyonu demek;
    // serbest analizde ise kullanıcının EN SON kaldığı yer demek (moves
    // kalıcı olduğu için "hiç oynanmamış gibi" sıfırlanmıyor).
    currentPath = [];
    redoStack = [];
    let parentId = null;
    while (true) {
      const kids = childrenOf(parentId);
      if (!kids.length) break;
      currentPath.push(kids[0]);
      parentId = kids[0];
    }

    await refreshPosition();
  }

  // ---------------- Dil değişince görünen ekranı yeniden çiz ----------------
  document.title = I18N.t('title.analysis');
  window.addEventListener('langchange', () => {
    document.title = I18N.t('title.analysis');
    if (currentFen) {
      renderPlayerNames();
      renderStatus();
      // Motor KAPALIYKEN eski (motor açıkken alınmış) değerlendirmeyi yeni
      // dilde yeniden göstermek yanıltıcı olur -- "Motor kapalı" yazısını
      // sadece yeni dilde tekrar basıyoruz.
      if (!engineEnabled) {
        $('evalLabel').textContent = I18N.t('analysis.engineDisabled');
      } else if (lastEvalData) {
        renderEval(lastEvalData);
      }
    }
    renderRematchUi();
    renderBlockOpponentButton();
    if (window.ChatUI) ChatUI.refreshTexts();
  });

  initBoardColorSettings();
  initEngineToggle();
  init();
})();
