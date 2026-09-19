// lib/notation.js
//
// UCI hamlelerini (ör. "e2e4", "e7e8q", "d1b1") standart cebirsel gösterime
// (SAN — ör. "e4", "exd5", "Qa5", "Bxb2", "O-O-O", "Nf3+", "Qh5#") çevirir.
// Bu, motora İKİNCİ bir kural uygulaması olarak SORULMUYOR — motor hamlenin
// yasallığını zaten onaylamış oluyor, biz sadece o hamleyi OKUNABİLİR hale
// getiriyoruz (saf gösterim/metin işi, oyun mantığını etkilemiyor).

const PIECE_LETTER = { n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };

// FEN'in tahta kısmını { "e4": "P", "d5": "p", ... } şeklinde bir kareye eşler.
function fenToSquareMap(fen) {
  const board = fen.split(' ')[0];
  const rows = board.split('/');
  const map = {};
  for (let r = 0; r < rows.length; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { file += parseInt(ch, 10); continue; }
      const rank = rows.length - r;
      const square = String.fromCharCode('a'.charCodeAt(0) + file) + rank;
      map[square] = ch;
      file++;
    }
  }
  return map;
}

// fenBeforeMove: hamle uygulanmadan ÖNCEKİ pozisyonun FEN'i.
// uciMove: motorun ürettiği/onayladığı UCI hamlesi (ör. "e2e4", "e7e8q").
// legalMovesAtFenBeforeMove: o pozisyondaki TÜM yasal hamleler — aynı türden
// başka bir taş da aynı kareye gidebiliyor mu diye (belirsizlik giderme için)
// kullanılıyor. Şah/mat işareti (+/#) burada EKLENMİYOR; onu çağıran taraf
// (gameManager), hamleden SONRAKİ pozisyonu bildiği için sona ekliyor.
function moveToSan(fenBeforeMove, uciMove, legalMovesAtFenBeforeMove) {
  const from = uciMove.slice(0, 2);
  const to = uciMove.slice(2, 4);
  const promo = uciMove.length > 4 ? uciMove[4] : null;

  const squareMap = fenToSquareMap(fenBeforeMove);
  const movedChar = squareMap[from];
  if (!movedChar) return uciMove; // beklenmedik durum — en azından ham hamleyi gösterelim

  const pieceType = movedChar.toLowerCase();
  const fromFile = from[0], fromRank = from[1];
  const toFile = to[0];

  // --- Roklanma: bu varyantta SADECE vezir kanadı roku var (variants.ini),
  // şah her zaman 2 kare gider — bu yüzden tek olasılık "O-O-O". ---
  if (pieceType === 'k') {
    const fileDist = Math.abs(fromFile.charCodeAt(0) - toFile.charCodeAt(0));
    // Bu varyantta TEK bir roklanma türü var (vezir kanadı, variants.ini) —
    // gerçek satrançtaki gibi ayrım (O-O / O-O-O) yapmaya gerek olmadığından
    // kısa "O-O" gösterimi kullanılıyor.
    if (fileDist === 2) return 'O-O';
  }

  const targetChar = squareMap[to] || null;
  let isCapture = !!targetChar;

  // --- Geçerken alma (piyon çapraz gidiyor ama hedef kare boş) ---
  if (pieceType === 'p' && fromFile !== toFile && !targetChar) {
    isCapture = true;
  }

  if (pieceType === 'p') {
    let san = isCapture ? (fromFile + 'x' + to) : to;
    if (promo) san += '=' + promo.toUpperCase();
    return san;
  }

  const letter = PIECE_LETTER[pieceType] || '';

  // --- Belirsizlik giderme: aynı türden başka bir taş da aynı kareye
  // gidebiliyorsa, kalkış dosyası ve/veya sırası eklenir (standart SAN
  // kuralı: önce dosya farkına, olmazsa sıra farkına, o da olmazsa ikisine
  // birden bakılır). ---
  const others = (legalMovesAtFenBeforeMove || []).filter(m => {
    if (m === uciMove) return false;
    const mFrom = m.slice(0, 2), mTo = m.slice(2, 4);
    if (mTo !== to) return false;
    const mChar = squareMap[mFrom];
    return mChar && mChar.toLowerCase() === pieceType;
  });

  let disambiguator = '';
  if (others.length > 0) {
    const shareFile = others.some(m => m[0] === fromFile);
    const shareRank = others.some(m => m[1] === fromRank);
    if (!shareFile) disambiguator = fromFile;
    else if (!shareRank) disambiguator = fromRank;
    else disambiguator = from;
  }

  return letter + disambiguator + (isCapture ? 'x' : '') + to;
}

module.exports = { fenToSquareMap, moveToSan };
