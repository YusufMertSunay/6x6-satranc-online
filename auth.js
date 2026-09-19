// lib/auth.js
//
// bcrypt kütüphanesi kurulamadığı için (npm engelli) Node'un KENDİ crypto
// modülündeki scrypt fonksiyonunu kullanıyoruz — bu da parola hash'leme için
// yaygın kabul gören, güvenli bir yöntemdir (bcrypt kadar yaygın değil ama
// kriptografik olarak sağlam ve ek bağımlılık gerektirmiyor).

const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, passwordHash: hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Basit oturum yönetimi: rastgele token -> userId eşlemesi, bellekte tutuluyor.
// (Sunucu yeniden başlarsa herkesin oturumu düşer — küçük ölçek için kabul
// edilebilir; gerçek üretimde imzalı bir cookie/JWT ya da kalıcı bir oturum
// deposu tercih edilir.)
class SessionManager {
  constructor() {
    this.sessions = new Map(); // token -> userId
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, userId);
    return token;
  }

  getUserId(token) {
    return this.sessions.get(token) || null;
  }

  destroySession(token) {
    this.sessions.delete(token);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

module.exports = { hashPassword, verifyPassword, SessionManager, parseCookies };
