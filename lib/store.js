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

// Elo puanı artık TEK bir sayı değil, süre kontrolü KATEGORİSİNE göre AYRI
// tutuluyor (Bullet/Blitz/Rapid/Klasik — lichess/chess.com'daki gibi).
// Kategori listesi burada, gameManager.js'deki TIME_CONTROLS eşlemesiyle
// TUTARLI olmalı (her TIME_CONTROLS girdisinin "category" alanı bu
// listedeki değerlerden biri olmalı).
const RATING_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

// Kullanıcı isteği: bir kullanıcı bir kategoride henüz (en fazla 7, yani)
// 8'DEN AZ puanlı (ranked) maç oynadıysa, o kategorideki puanı henüz "oturmuş"
// sayılmıyor -- ön yüzde bunun yanında mavi bir "?" (puanın yanında) ve
// liderlik tablosundaki sırasının yanında mavi bir "*" işareti gösteriliyor
// (bkz. server.js ve public/js/app.js, game.js, analysis.js). Bu eşik SADECE
// puanlı oyunları sayar -- puansız (dostluk) oyunlar zaten Elo'yu hiç
// etkilemediği için bu sayaca da hiç eklenmiyor (bkz. updateUserRating,
// SADECE puanlı oyun sonunda çağrılıyor).
const GAMES_NEEDED_FOR_ESTABLISHED = 8;

function freshRatings() {
  const ratings = {};
  for (const cat of RATING_CATEGORIES) ratings[cat] = 1500;
  return ratings;
}

function freshGamesPlayed() {
  const gp = {};
  for (const cat of RATING_CATEGORIES) gp[cat] = 0;
  return gp;
}

// Veri klasörü artık DATA_DIR ortam değişkeniyle DIŞARIDAN da ayarlanabiliyor
// (ayarlanmazsa eskisi gibi proje klasörünün içindeki "data" klasörü
// kullanılır — yerel geliştirme ve DATA_DIR tanımlanmamış diğer ortamlar
// için davranış DEĞİŞMEDİ). Bu, Render.com'da eklenecek KALICI BİR DİSKİN
// bağlama (mount) yoluna işaret edebilmek için gerekli: DATA_DIR o disk
// yoluna ayarlanırsa, kullanıcılar/oyunlar artık her yeniden başlamada
// (spin-down/redeploy) SIFIRLANMAYAN, gerçekten kalıcı bir depoda saklanır.
const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : path.join(__dirname, '..', 'data');
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
    // Analiz tahtası varyant AĞAÇLARI -- scopeKey -> tree (bkz. lib/analysisTree.js).
    // scopeKey biçimi: "game:<gameId>:<userId>" (oyun-bazlı analiz, o oyunu
    // analiz eden kullanıcıya özel) veya "free:<userId>" (oyunsuz/serbest
    // analiz -- kullanıcı başına TEK kalıcı taslak ağaç).
    this.analysisTrees = loadJson('analysis_trees', {});
  }

  _persistAnalysisTrees() {
    saveJson('analysis_trees', this.analysisTrees);
  }

  getAnalysisTree(scopeKey) {
    return this.analysisTrees[scopeKey] || null;
  }

  saveAnalysisTree(scopeKey, tree) {
    this.analysisTrees[scopeKey] = tree;
    this._persistAnalysisTrees();
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
      ratings: freshRatings(), // { bullet, blitz, rapid, classical } — hepsi 1500'den başlar
      // YENİ: kategori başına oynanan PUANLI maç sayısı (bkz.
      // GAMES_NEEDED_FOR_ESTABLISHED yukarısı) — global wins/losses/draws'tan
      // AYRI, çünkü bunlar kategoriye göre değil, bkz. updateUserRating.
      gamesPlayed: freshGamesPlayed(),
      wins: 0, losses: 0, draws: 0,
      language: 'tr', // arayüz dili tercihi ('tr' | 'en') — bkz. setUserLanguage
      blockedUserIds: [], // bu kullanıcının ENGELLEDİĞİ kullanıcıların id listesi (bkz. blockUser)
      // YENİ (kullanıcı isteği -- chat/seyirci özelliği): sadece MESAJLARI
      // gizlemek için kullanılan, komple engellemeden (blockedUserIds) AYRI
      // ve daha HAFİF bir liste. Bir kullanıcı burada olan birinin
      // mesajlarını hiçbir sohbette (oyuncu/seyirci/birleşik) GÖRMEZ -- ama
      // o kullanıcıya hâlâ oyun teklifi gönderebilir/alabilir, hızlı
      // eşleştirmede eşleşebilir vs. (bkz. muteUser/isMuted).
      mutedUserIds: [],
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

  // category: 'bullet' | 'blitz' | 'rapid' | 'classical' — SADECE o
  // kategorinin puanı güncelleniyor, diğer üç kategori dokunulmadan kalıyor.
  updateUserRating(id, category, newRating, resultForUser) {
    const u = this.users[id];
    if (!u) return;
    if (!u.ratings) u.ratings = freshRatings(); // eski/eksik kayıt için güvenlik
    if (!u.gamesPlayed) u.gamesPlayed = freshGamesPlayed(); // eski/eksik kayıt için güvenlik
    u.ratings[category] = newRating;
    u.gamesPlayed[category] = (u.gamesPlayed[category] || 0) + 1;
    if (resultForUser === 'win') u.wins++;
    else if (resultForUser === 'loss') u.losses++;
    else u.draws++;
    this._persistUsers();
  }

  // Bir kullanıcının belirli bir kategoride henüz GAMES_NEEDED_FOR_ESTABLISHED
  // (8) puanlı maç oynayıp oynamadığını söyler -- oynamadıysa (7 veya daha
  // az) o kategorideki puanı "geçici/oturmamış" sayılır (kullanıcı isteği:
  // puanın yanında mavi "?" ve liderlik tablosundaki sırasının yanında mavi
  // "*" işareti). Eski/eksik kayıtlar (gamesPlayed alanı olmayan) için
  // güvenli varsayılan 0 -- yani onlar da (haklı olarak) geçici sayılır.
  isProvisional(u, category) {
    const count = u?.gamesPlayed?.[category] ?? 0;
    return count < GAMES_NEEDED_FOR_ESTABLISHED;
  }

  // Bir kullanıcının DÖRT kategorinin hepsi için geçici/oturmamış durumunu
  // tek seferde döndürür (bkz. server.js: /api/me, /api/register, /api/login,
  // /api/player-info -- kullanıcının o an ekranda görünen TÜM süre kontrolü
  // seçeneklerinin yanında doğru işareti gösterebilmesi için).
  provisionalMap(u) {
    const map = {};
    for (const cat of RATING_CATEGORIES) map[cat] = this.isProvisional(u, cat);
    return map;
  }

  // Kullanıcının arayüz dili tercihini ('tr' | 'en') hesabına kaydeder —
  // böylece başka bir cihaz/tarayıcıdan giriş yaptığında da (çerezden
  // BAĞIMSIZ olarak) aynı dil otomatik olarak uygulanabiliyor (bkz.
  // server.js: POST /api/set-language ve public/js/i18n.js).
  setUserLanguage(id, language) {
    const u = this.users[id];
    if (!u) return;
    if (language !== 'tr' && language !== 'en') return;
    u.language = language;
    this._persistUsers();
  }

  // ---- Kullanıcı engelleme (kullanıcı isteği) ----
  // Kalıcı: users[id].blockedUserIds bu kullanıcının ENGELLEDİĞİ kullanıcı
  // id'lerinin listesi. Uygulama mantığı (kim kime teklif gönderebilir, hızlı
  // eşleştirmede kimler eşleşemez) lib/gameManager.js'de -- burası sadece
  // ham veriyi tutuyor.

  blockUser(blockerId, blockedId) {
    const u = this.users[blockerId];
    if (!u) return;
    if (!Array.isArray(u.blockedUserIds)) u.blockedUserIds = []; // eski kayıt için güvenlik
    if (!u.blockedUserIds.includes(blockedId)) u.blockedUserIds.push(blockedId);
    this._persistUsers();
  }

  unblockUser(blockerId, blockedId) {
    const u = this.users[blockerId];
    if (!u || !Array.isArray(u.blockedUserIds)) return;
    u.blockedUserIds = u.blockedUserIds.filter(id => id !== blockedId);
    this._persistUsers();
  }

  // blockerId, blockedId'yi engellemiş mi? (TEK YÖNLÜ sorgu -- iki yönlü
  // kontrol gerekiyorsa çağıran taraf iki kez çağırmalı, bkz. gameManager.js:
  // isBlockedBetween).
  isBlocked(blockerId, blockedId) {
    const u = this.users[blockerId];
    if (!u || !Array.isArray(u.blockedUserIds)) return false;
    return u.blockedUserIds.includes(blockedId);
  }

  // blockerId'nin engellediği kullanıcıların kullanıcı adlarını döndürür
  // (arayüzde listelemek için) -- artık silinmiş bir hesap varsa (olmamalı
  // ama yine de) o kayıt sessizce atlanır.
  getBlockedUsernames(blockerId) {
    const u = this.users[blockerId];
    if (!u || !Array.isArray(u.blockedUserIds)) return [];
    return u.blockedUserIds
      .map(id => this.users[id]?.username)
      .filter(Boolean);
  }

  // ---- Mesaj susturma (kullanıcı isteği: chat/seyirci özelliği) ----
  // blockUser/unblockUser/isBlocked/getBlockedUsernames ile BİREBİR AYNI
  // desen, ama TAMAMEN AYRI bir liste (mutedUserIds) üzerinde çalışıyor --
  // bu ikisi birbirini hiç etkilemez (bkz. yukarısı: mutedUserIds alanı).

  muteUser(muterId, targetId) {
    const u = this.users[muterId];
    if (!u) return;
    if (!Array.isArray(u.mutedUserIds)) u.mutedUserIds = [];
    if (!u.mutedUserIds.includes(targetId)) u.mutedUserIds.push(targetId);
    this._persistUsers();
  }

  unmuteUser(muterId, targetId) {
    const u = this.users[muterId];
    if (!u || !Array.isArray(u.mutedUserIds)) return;
    u.mutedUserIds = u.mutedUserIds.filter(id => id !== targetId);
    this._persistUsers();
  }

  isMuted(muterId, targetId) {
    const u = this.users[muterId];
    if (!u || !Array.isArray(u.mutedUserIds)) return false;
    return u.mutedUserIds.includes(targetId);
  }

  getMutedUsernames(muterId) {
    const u = this.users[muterId];
    if (!u || !Array.isArray(u.mutedUserIds)) return [];
    return u.mutedUserIds
      .map(id => this.users[id]?.username)
      .filter(Boolean);
  }

  // Liderlik tablosu artık belirli bir kategoriye göre sıralanıyor (dört
  // kategoriden biri) — genel/tek bir "puan" diye bir şey kalmadı.
  //
  // Kullanıcı isteği: kullanıcı sayısı arttıkça tablo "sonsuza kadar"
  // uzamasın diye artık TÜM listeyi değil, offset/limit ile bir "sayfa"
  // (varsayılan 10 kişilik) döndürüyoruz -- toplam kişi sayısını da (ön
  // yüzün "İlk 10 / Son 10 / Yukarı / Aşağı" düğmelerini doğru
  // etkinleştirip devre dışı bırakabilmesi için) ayrıca veriyoruz. Her
  // girdiye kendi GERÇEK (1'den başlayan, sayfadan bağımsız) sırasını da
  // ekliyoruz ki ön yüz "#" sütununu index+1 yerine bunu kullanarak doğru
  // göstersin.
  leaderboard(category, offset = 0, limit = 10) {
    const ratingOf = (u) => (u.ratings ? u.ratings[category] : undefined) ?? 1500;
    const sorted = Object.values(this.users).sort((a, b) => ratingOf(b) - ratingOf(a));
    const total = sorted.length;
    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, total - 1)));
    const entries = sorted.slice(safeOffset, safeOffset + limit).map((u, i) => ({
      rank: safeOffset + i + 1,
      username: u.username, rating: ratingOf(u), wins: u.wins, losses: u.losses, draws: u.draws,
      // Kullanıcı isteği: bu kategoride henüz 8 puanlı maç oynamadıysa (7 ya
      // da daha az), ön yüz bu bayrağa bakıp puanın yanına mavi "?" ve
      // sıranın yanına mavi "*" işareti ekliyor (bkz. GAMES_NEEDED_FOR_ESTABLISHED).
      provisional: this.isProvisional(u, category),
    }));
    return { total, offset: safeOffset, entries };
  }

  // Bir kullanıcının belirli bir kategorideki 1'den başlayan sırasını
  // (rank'ını) döndürür -- ön yüzün "varsayılan olarak beni gösteren
  // sayfayı aç" davranışı için (bkz. server.js: /api/leaderboard, offset
  // verilmediğinde bu rank'ı içeren sayfa hesaplanır). Kullanıcı bulunamazsa
  // (olmamalı, ama savunma amaçlı) null döner.
  rankOf(category, userId) {
    const ratingOf = (u) => (u.ratings ? u.ratings[category] : undefined) ?? 1500;
    const sorted = Object.values(this.users).sort((a, b) => ratingOf(b) - ratingOf(a));
    const idx = sorted.findIndex(u => u.id === userId);
    return idx === -1 ? null : idx + 1;
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

  // ---- Oyun sohbeti (kullanıcı isteği: chat/seyirci özelliği) ----
  // Bir oyun BİTTİKTEN sonraki (birleşik) sohbet, canlı oyundan farklı
  // olarak kalıcı depoda saklanıyor -- çünkü analiz tahtası, oyun bittikten
  // GÜNLER sonra bile açılıp sohbete devam edilebilmeli (bkz.
  // gameManager.js: _finalizeGame/getChat/sendChat). Oyun canlıyken
  // (playerChat/spectatorChat) SADECE bellekte tutulur, tıpkı canlı oyunun
  // kendisi gibi -- sunucu o sırada yeniden başlarsa zaten TÜM canlı oyunlar
  // kayboluyor, bu yeni bir kısıtlama değil.
  appendChatMessage(gameId, message) {
    const g = this.games[gameId];
    if (!g) return false;
    if (!Array.isArray(g.chat)) g.chat = [];
    g.chat.push(message);
    this._persistGames();
    return true;
  }

  // Kullanıcı isteği: "Son Oyunların" listesi de artık TÜMÜNÜ değil,
  // offset/limit ile bir sayfa (varsayılan en yeni 10 oyun, offset=0)
  // döndürüyor -- toplam oyun sayısını da (ön yüzün "İlk Oyunlar / Son
  // Oyunlar / daha eski / daha yeni" düğmeleri için) ayrıca veriyoruz.
  recentGamesForUser(userId, offset = 0, limit = 10) {
    const sorted = Object.values(this.games)
      .filter(g => g.whiteId === userId || g.blackId === userId)
      .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));
    const total = sorted.length;
    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, total - 1)));
    const entries = sorted.slice(safeOffset, safeOffset + limit);
    return { total, offset: safeOffset, entries };
  }
}

module.exports = { Store, RATING_CATEGORIES, GAMES_NEEDED_FOR_ESTABLISHED };
