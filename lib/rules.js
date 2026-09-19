// lib/rules.js
//
// AnalysisForm.cs'teki IsInsufficientMaterial() ve kare/koordinat çevirme
// mantığının Node.js karşılığı. Motorun kendisine sormadığımız TEK şey bu —
// çünkü klasik "yetersiz taş" kuralı motora sorulduğunda anlamlı bir cevap
// gelmiyor (motor mat kuramasa bile "en iyi hamle" aramaya devam ediyor).

const BOARD_SIZE = 6;

function squareToRc(sq) {
  const c = sq.charCodeAt(0) - 'a'.charCodeAt(0);
  const rank = parseInt(sq.substring(1), 10);
  const r = BOARD_SIZE - rank;
  return { r, c };
}

function rcToSquare(r, c) {
  return String.fromCharCode('a'.charCodeAt(0) + c) + (BOARD_SIZE - r);
}

// Klasik satranç kuralı: piyon, kale ya da vezir yoksa ve kalan hafif taş
// (fil/at) sayısı mat kurmaya yetmiyorsa (0, 1, ya da iki fil ikisi de aynı
// renk karede), pozisyon berabere sayılır.
function isInsufficientMaterial(fen) {
  const boardPart = fen.split(' ')[0];
  const rows = boardPart.split('/');

  let pawns = 0, rooks = 0, queens = 0, knights = 0, bishops = 0;
  const bishopColors = [];

  for (let r = 0; r < rows.length; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { c += parseInt(ch, 10); continue; }
      switch (ch.toLowerCase()) {
        case 'p': pawns++; break;
        case 'r': rooks++; break;
        case 'q': queens++; break;
        case 'n': knights++; break;
        case 'b': bishops++; bishopColors.push((r + c) % 2); break;
      }
      c++;
    }
  }

  if (pawns > 0 || rooks > 0 || queens > 0) return false;

  const minors = knights + bishops;
  if (minors === 0) return true;
  if (minors === 1) return true;
  if (minors === 2 && bishops === 2 && new Set(bishopColors).size === 1) return true;

  return false;
}

function parseFenParts(fen) {
  const parts = fen.split(' ');
  return {
    board: parts[0],
    turn: parts[1], // 'w' | 'b'
    castling: parts[2],
    ep: parts[3],
    halfmove: parseInt(parts[4] || '0', 10),
    fullmove: parseInt(parts[5] || '1', 10),
  };
}

module.exports = { BOARD_SIZE, squareToRc, rcToSquare, isInsufficientMaterial, parseFenParts };
