// lib/elo.js — standart Elo derecelendirme hesaplaması.
const K = 32;

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// scoreWhite: 1 (beyaz kazandı), 0 (siyah kazandı), 0.5 (berabere)
function computeNewRatings(whiteRating, blackRating, scoreWhite) {
  const expWhite = expectedScore(whiteRating, blackRating);
  const expBlack = 1 - expWhite;
  const newWhite = Math.round(whiteRating + K * (scoreWhite - expWhite));
  const newBlack = Math.round(blackRating + K * ((1 - scoreWhite) - expBlack));
  return { newWhite, newBlack };
}

module.exports = { computeNewRatings };
