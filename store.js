// lib/store.js
//
// Basit, bağımlılıksız (npm paketi gerektirmeyen) dosya tabanlı veri deposu.
// Bu sandbox ortamında npm kayıt sunucusuna erişim organizasyon politikası
// tarafından tamamen engellendiği için (better-sqlite3/sqlite3 kurulamadı),
// kalıcılığı düz JSON dosyalarıyla sağlıyoruz. Küçük/orta ölçekte (birkaç
// bin kullanıcı/oyun) bu tamamen yeterli. Gerçek bir sunucuya (Render,
// Railway, kendi VPS'in) taşındığında npm kısıtlaması olmayacağı için
// istersen bunu gerçek bir veritabanına (better-sqlite3, Postgres) kolayca
// yükseltebilirsin — README.md'de bunun nasıl yapılacağı anlatılıyor.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function loadJson(name, fallback) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomik olmayan ama pratikte yeterli bir yazma: önce geçici dosyaya yaz,
// sonra yeniden adlandır (rename işlemi çoğu dosya sisteminde atomiktir,
// bu da yarım yazılmış bir dosyanın okunma riskini azaltır).
function saveJson(name, data) {
  const p = filePath(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

class Store {
  constructor() {
    this.users = loadJson('users', {});       // id -> {id, username, passwordHash, salt, rating, createdAt}
    this.usernameIndex = loadJson('username_index', {}); // lowercased username -> id
    this.games = loadJson('games', {});        // id -> finished game record
    this.nextUserId = loadJson('next_user_id', { value: 1 }).value;
    this.nextGameId = loadJson('next_game_id', { value: 1 }).value;
  }

  _persistUsers() {
    saveJson('users', this.users);
    saveJson('username_index', this.usernameIndex);
    saveJson('next_user_id', { value: this.nextUserId });
  }

  _persistGames() {
    saveJson('games', this.games);
    saveJson('next_game_id', { value: this.nextGameId });
  }

  createUser({ username, passwordHash, salt }) {
    const key = username.toLowerCase();
    if (this.usernameIndex[key]) throw new Error('Bu kullanıcı adı zaten alınmış.');
    const id = String(this.nextUserId++);
    const user = {
      id, username, passwordHash, salt,
      rating: 1200,
      wins: 0, losses: 0, draws: 0,
      createdAt: new Date().toISOString(),
    };
    this.users[id] = user;
    this.usernameIndex[key] = id;
    this._persistUsers();
    return user;
  }

  getUserByUsername(username) {
    const id = this.usernameIndex[username.toLowerCase()];
    return id ? this.users[id] : null;
  }

  getUserById(id) {
    return this.users[id] || null;
  }

  updateUserRating(id, newRating, resultForUser) {
    const u = this.users[id];
    if (!u) return;
    u.rating = newRating;
    if (resultForUser === 'win') u.wins++;
    else if (resultForUser === 'loss') u.losses++;
    else u.draws++;
    this._persistUsers();
  }

  leaderboard(limit = 20) {
    return Object.values(this.users)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit)
      .map(u => ({ username: u.username, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws }));
  }

  // id: canlı oyun sırasında kullanılan AYNI kimlik — böylece oyun bitince
  // istemci /api/game/:id ile aynı adresten (artık kalıcı hale gelmiş)
  // sonucu okumaya devam edebiliyor.
  saveFinishedGame(id, game) {
    this.games[id] = { id, ...game };
    this._persistGames();
    return id;
  }

  getGame(id) {
    return this.games[id] || null;
  }

  recentGamesForUser(userId, limit = 20) {
    return Object.values(this.games)
      .filter(g => g.whiteId === userId || g.blackId === userId)
      .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt))
      .slice(0, limit);
  }
}

module.exports = { Store };
