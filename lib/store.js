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
    // YENİ (kullanıcı isteği: özel mesaj özelliği): id -> {id, fromId, toId,
    // text, sentAt, read, deletedForIds} -- bkz. aşağısı, "ÖZEL MESAJLAR"
    // bölümü. Sohbet mesajları gibi bu da HİÇBİR ZAMAN sunucu tarafından
    // otomatik silinmez -- sadece kullanıcının KENDİ isteğiyle (deletedForIds,
    // sadece O KULLANICININ görünümünden kaldırır, karşı taraftakini etkilemez).
    this.dmMessages = loadJson('dm_messages', {});
    this.nextDmId = loadJson('next_dm_id', { value: 1 }).value;
  }

  _persistDm() {
    saveJson('dm_messages', this.dmMessages);
    saveJson('next_dm_id', { value: this.nextDmId });
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
      // YENİ (kullanıcı isteği -- özel mesaj/arkadaşlık özelliği): SADECE bu
      // kullanıcının bana ÖZEL MESAJ atmasını engelleyen, komple engellemeden
      // (blockedUserIds) DAHA HAFİF üçüncü bir liste -- teklif/hızlı eşleşme
      // gibi hiçbir şeyi etkilemez, SADECE yeni özel mesaj göndermesini
      // engeller (bkz. messageBlockUser/isMessageBlocked). Bu listeye
      // eklenen biri OTOMATİK olarak hem arkadaşlıktan çıkarılır hem de
      // (analiz tahtasında otomatik gizlenmesi için) mutedUserIds'e de
      // eklenir -- bkz. messageBlockUser.
      messageBlockedUserIds: [],
      // YENİ: karşılıklı onaylanmış arkadaşlık listesi -- arkadaş olan iki
      // kullanıcı, sohbette (özel mesaj VE canlı oyun sohbetinde) art arda
      // mesaj sınırından MUAF olur (bkz. gameManager.js/socialManager.js).
      friendIds: [],
      // YENİ: bekleyen arkadaşlık teklifleri -- outgoing: BEN kime teklif
      // gönderdim, incoming: BANA kim teklif gönderdi. Teklif kabul/red
      // edilince ikisinden de silinir (bkz. socialManager.js).
      outgoingFriendRequestIds: [],
      incomingFriendRequestIds: [],
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

  // Kullanıcı isteği (özel mesaj/arkadaşlık özelliği): "komple engelleme"
  // artık SADECE eski davranışını (teklif/hızlı eşleşme engeli) değil, İKİ
  // YAN ETKİYİ de otomatik olarak yapıyor -- ARADAN GİREN NOKTA NEREDEN
  // ÇAĞRILIRSA ÇAĞRILSIN (mevcut "Son Oyunların"/blockForm düğmeleri, yeni
  // bildirim/arkadaşlar panelindeki "Engelle" düğmeleri -- hepsi AYNI
  // gameManager.blockUser -> store.blockUser yoluna çıkıyor, tutarlılık
  // için tek bir yerden):
  //   1) İki taraf da (varsa) birbirinin arkadaş listesinden ÇIKARILIR.
  //   2) blockedId, blockerId'nin messageBlockedUserIds VE mutedUserIds
  //      listesine de eklenir -- yani komple engelleme, özel mesaj
  //      göndermeyi de, sohbette görünmeyi de otomatik olarak engeller.
  blockUser(blockerId, blockedId) {
    const u = this.users[blockerId];
    if (!u) return;
    if (!Array.isArray(u.blockedUserIds)) u.blockedUserIds = []; // eski kayıt için güvenlik
    if (!u.blockedUserIds.includes(blockedId)) u.blockedUserIds.push(blockedId);
    this._unfriendBothSides(blockerId, blockedId);
    if (!Array.isArray(u.messageBlockedUserIds)) u.messageBlockedUserIds = [];
    if (!u.messageBlockedUserIds.includes(blockedId)) u.messageBlockedUserIds.push(blockedId);
    if (!Array.isArray(u.mutedUserIds)) u.mutedUserIds = [];
    if (!u.mutedUserIds.includes(blockedId)) u.mutedUserIds.push(blockedId);
    this._persistUsers();
  }

  unblockUser(blockerId, blockedId) {
    const u = this.users[blockerId];
    if (!u || !Array.isArray(u.blockedUserIds)) return;
    u.blockedUserIds = u.blockedUserIds.filter(id => id !== blockedId);
    // blockUser, komple engellerken OTOMATİK olarak hem mesaj-engeli hem
    // susturma da uyguluyordu (kullanıcı isteği: "komple engellersem...
    // sadece mesaj atmasını da engellemiş olurum") -- unblockUser bunun TAM
    // TERSİNİ yapıp o iki yan etkiyi de geri alıyor, aksi halde kullanıcı
    // engeli kaldırdığında (arayüzde bunu ayrıca belirtmeden) hâlâ mesaj
    // alamıyor/göremiyor gibi kafa karıştırıcı bir duruma düşerdi. (Eğer bu
    // kullanıcıyı BAĞIMSIZ olarak -- komple engellemeden önce -- zaten
    // susturmuşsa, bu nadir uç durumda o eski manuel susturma da kalkar;
    // kabul edilebilir bir basitleştirme.)
    if (Array.isArray(u.messageBlockedUserIds)) {
      u.messageBlockedUserIds = u.messageBlockedUserIds.filter(id => id !== blockedId);
    }
    if (Array.isArray(u.mutedUserIds)) {
      u.mutedUserIds = u.mutedUserIds.filter(id => id !== blockedId);
    }
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

  // Kullanıcı isteği (özel mesaj özelliği): oyundaki VEYA oyun sonrası
  // analiz tahtasındaki "Susturulanlar" panelinden birinin susturmasını
  // kaldırmak, o kişiyi ÖZEL MESAJ engelinden de OTOMATİK olarak kurtarır
  // (kişi hiç mesaj-engellenmemişse bu adım zaten no-op, zararsız).
  unmuteUser(muterId, targetId) {
    const u = this.users[muterId];
    if (!u || !Array.isArray(u.mutedUserIds)) return;
    u.mutedUserIds = u.mutedUserIds.filter(id => id !== targetId);
    if (Array.isArray(u.messageBlockedUserIds)) {
      u.messageBlockedUserIds = u.messageBlockedUserIds.filter(id => id !== targetId);
    }
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

  // ============================================================
  // ÖZEL MESAJ ENGELİ (kullanıcı isteği: özel mesaj/arkadaşlık özelliği) --
  // komple engellemeden (blockUser) DAHA HAFİF: SADECE yeni özel mesaj
  // göndermeyi engeller. Uygulanınca (messageBlockUser) otomatik olarak hem
  // arkadaşlıktan çıkarır hem de mutedUserIds'e ekler (bkz. yorumlar
  // yukarıda, mesajBlockedUserIds alanı) -- böylece hem oyun içi/analiz
  // sohbetinde otomatik gizlenir hem de "susturmayı kaldır" düğmesi
  // (unmuteUser, yukarısı) bu engeli de otomatik kaldırabilir.
  // ============================================================

  messageBlockUser(blockerId, targetId) {
    const u = this.users[blockerId];
    if (!u) return;
    if (!Array.isArray(u.messageBlockedUserIds)) u.messageBlockedUserIds = [];
    if (!u.messageBlockedUserIds.includes(targetId)) u.messageBlockedUserIds.push(targetId);
    this._unfriendBothSides(blockerId, targetId);
    if (!Array.isArray(u.mutedUserIds)) u.mutedUserIds = [];
    if (!u.mutedUserIds.includes(targetId)) u.mutedUserIds.push(targetId);
    this._persistUsers();
  }

  // "Otomatik kalkma" (bir mesaj gönderince ya da susturma kaldırılınca)
  // DIŞINDA, ayrı bir "engeli kaldır" düğmesi istenmedi -- ama iç mantık
  // (auto-lift) için burada tek başına bir fonksiyon olması işi kolaylaştırıyor.
  unMessageBlockUser(blockerId, targetId) {
    const u = this.users[blockerId];
    if (!u || !Array.isArray(u.messageBlockedUserIds)) return;
    u.messageBlockedUserIds = u.messageBlockedUserIds.filter(id => id !== targetId);
    this._persistUsers();
  }

  isMessageBlocked(blockerId, targetId) {
    const u = this.users[blockerId];
    if (!u || !Array.isArray(u.messageBlockedUserIds)) return false;
    return u.messageBlockedUserIds.includes(targetId);
  }

  // ============================================================
  // ARKADAŞLIK (kullanıcı isteği: özel mesaj/arkadaşlık özelliği) --
  // arkadaş olan iki kullanıcı birbirine SINIRSIZ art arda özel mesaj
  // atabilir (bkz. socialManager.js: sendDirectMessage). Tek yönlü teklif +
  // karşı tarafın kabul/red etmesiyle çalışır; iki taraf da mutual
  // friendIds listesine eklenir.
  // ============================================================

  isFriend(aId, bId) {
    const u = this.users[aId];
    if (!u || !Array.isArray(u.friendIds)) return false;
    return u.friendIds.includes(bId);
  }

  hasOutgoingFriendRequest(fromId, toId) {
    const u = this.users[fromId];
    if (!u || !Array.isArray(u.outgoingFriendRequestIds)) return false;
    return u.outgoingFriendRequestIds.includes(toId);
  }

  createFriendRequest(fromId, toId) {
    const from = this.users[fromId], to = this.users[toId];
    if (!from || !to) return;
    if (!Array.isArray(from.outgoingFriendRequestIds)) from.outgoingFriendRequestIds = [];
    if (!from.outgoingFriendRequestIds.includes(toId)) from.outgoingFriendRequestIds.push(toId);
    if (!Array.isArray(to.incomingFriendRequestIds)) to.incomingFriendRequestIds = [];
    if (!to.incomingFriendRequestIds.includes(fromId)) to.incomingFriendRequestIds.push(fromId);
    this._persistUsers();
  }

  // Bekleyen teklifi (varsa) her iki taraftan da temizler -- kabul VEYA
  // red, ikisi de önce bunu çağırır.
  _clearFriendRequest(fromId, toId) {
    const from = this.users[fromId], to = this.users[toId];
    if (from && Array.isArray(from.outgoingFriendRequestIds)) {
      from.outgoingFriendRequestIds = from.outgoingFriendRequestIds.filter(id => id !== toId);
    }
    if (to && Array.isArray(to.incomingFriendRequestIds)) {
      to.incomingFriendRequestIds = to.incomingFriendRequestIds.filter(id => id !== fromId);
    }
  }

  acceptFriendRequest(fromId, toId) {
    this._clearFriendRequest(fromId, toId);
    const from = this.users[fromId], to = this.users[toId];
    if (from) {
      if (!Array.isArray(from.friendIds)) from.friendIds = [];
      if (!from.friendIds.includes(toId)) from.friendIds.push(toId);
    }
    if (to) {
      if (!Array.isArray(to.friendIds)) to.friendIds = [];
      if (!to.friendIds.includes(fromId)) to.friendIds.push(fromId);
    }
    this._persistUsers();
  }

  declineFriendRequest(fromId, toId) {
    this._clearFriendRequest(fromId, toId);
    this._persistUsers();
  }

  // Her iki taraftan da (varsa) mutual arkadaşlığı VE bekleyen tekliflerini
  // temizler -- blockUser/messageBlockUser'ın otomatik yan etkisi olarak
  // (yukarısı) VE elle "arkadaşlıktan çık" isteğinde (unfriend) kullanılır.
  _unfriendBothSides(aId, bId) {
    const a = this.users[aId], b = this.users[bId];
    if (a && Array.isArray(a.friendIds)) a.friendIds = a.friendIds.filter(id => id !== bId);
    if (b && Array.isArray(b.friendIds)) b.friendIds = b.friendIds.filter(id => id !== aId);
    this._clearFriendRequest(aId, bId);
    this._clearFriendRequest(bId, aId);
  }

  unfriend(aId, bId) {
    this._unfriendBothSides(aId, bId);
    this._persistUsers();
  }

  getFriendUsernames(userId) {
    const u = this.users[userId];
    if (!u || !Array.isArray(u.friendIds)) return [];
    return u.friendIds.map(id => this.users[id]).filter(Boolean).map(f => f.username);
  }

  getIncomingFriendRequestUsernames(userId) {
    const u = this.users[userId];
    if (!u || !Array.isArray(u.incomingFriendRequestIds)) return [];
    return u.incomingFriendRequestIds.map(id => this.users[id]).filter(Boolean).map(f => f.username);
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

  // ============================================================
  // ÖZEL MESAJLAR (kullanıcı isteği: özel mesaj/arkadaşlık özelliği) --
  // iki kullanıcı arasındaki TÜM mesajlar tek bir düz listede (this.dmMessages)
  // tutuluyor, "konuşma" kavramı sorgu anında (fromId/toId çiftine göre
  // filtrelenerek) hesaplanıyor -- games/challenges'taki gibi küçük ölçekte
  // taramanın yeterli olduğu, ayrı bir "conversation" nesnesi tutmaya hiç
  // gerek olmadığı basit bir yaklaşım.
  // ============================================================

  appendDirectMessage(fromId, toId, text) {
    const id = String(this.nextDmId++);
    const msg = { id, fromId, toId, text, sentAt: Date.now(), read: false, deletedForIds: [] };
    this.dmMessages[id] = msg;
    this._persistDm();
    return msg;
  }

  // aId ile bId arasındaki TÜM mesajlar (viewerId'nin kendisi için SİLMEDİĞİ
  // olanlar), gönderilme zamanına göre artan sırada.
  getConversation(aId, bId, viewerId) {
    return Object.values(this.dmMessages)
      .filter(m => (m.fromId === aId && m.toId === bId) || (m.fromId === bId && m.toId === aId))
      .filter(m => !m.deletedForIds.includes(viewerId))
      .sort((a, b) => a.sentAt - b.sentAt);
  }

  // _trailingStreak (gameManager.js) ile AYNI mantık, art arda mesaj
  // sınırını hesaplamak için -- viewerId'nin SİLDİĞİ mesajlar bile bu
  // sayıma dahil (silme sadece GÖRÜNÜMÜ etkiler, sınırı aşmayı kolaylaştırmaz).
  trailingDmStreak(aId, bId, senderId) {
    const all = Object.values(this.dmMessages)
      .filter(m => (m.fromId === aId && m.toId === bId) || (m.fromId === bId && m.toId === aId))
      .sort((a, b) => a.sentAt - b.sentAt);
    let count = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].fromId === senderId) count++;
      else break;
    }
    return count;
  }

  // Bir kullanıcının GELEN KUTUSU: karşı taraf bazında GRUPLANMIŞ, en son
  // mesaja göre sıralanmış konuşma özetleri -- bildirim zili penceresinde
  // "hangi kullanıcı ne yazmış" listesi için (bkz. socialManager.js: getInbox).
  getInboxConversations(userId) {
    const byOther = new Map(); // otherId -> {lastMessage, unreadCount}
    for (const m of Object.values(this.dmMessages)) {
      let otherId;
      if (m.fromId === userId) otherId = m.toId;
      else if (m.toId === userId) otherId = m.fromId;
      else continue;
      if (m.deletedForIds.includes(userId)) continue;
      const entry = byOther.get(otherId) || { lastMessage: null, unreadCount: 0 };
      if (!entry.lastMessage || m.sentAt > entry.lastMessage.sentAt) entry.lastMessage = m;
      if (m.toId === userId && !m.read) entry.unreadCount++;
      byOther.set(otherId, entry);
    }
    return Array.from(byOther.entries())
      .map(([otherId, entry]) => ({ otherId, ...entry }))
      .sort((a, b) => b.lastMessage.sentAt - a.lastMessage.sentAt);
  }

  // Toplam okunmamış özel mesaj sayısı (zil rozetindeki nokta için --
  // gerçek sayıyı değil sadece ">0 mı" diye kullanıyoruz ama ileride işe
  // yarayabilir diye sayının kendisini döndürüyoruz).
  unreadDmCount(userId) {
    let count = 0;
    for (const m of Object.values(this.dmMessages)) {
      if (m.toId === userId && !m.read && !m.deletedForIds.includes(userId)) count++;
    }
    return count;
  }

  // SADECE arkadaşlardan gelen okunmamış mesaj sayısı ("Arkadaşlarım"
  // düğmesinin turuncu noktası için -- kullanıcı isteği, geneldeki zil
  // rozetinden AYRI bir sayaç).
  unreadDmCountFromIds(userId, fromIds) {
    const set = new Set(fromIds);
    let count = 0;
    for (const m of Object.values(this.dmMessages)) {
      if (m.toId === userId && !m.read && set.has(m.fromId) && !m.deletedForIds.includes(userId)) count++;
    }
    return count;
  }

  markConversationRead(userId, otherId) {
    let changed = false;
    for (const m of Object.values(this.dmMessages)) {
      if (m.toId === userId && m.fromId === otherId && !m.read) { m.read = true; changed = true; }
    }
    if (changed) this._persistDm();
  }

  // messageIds === 'all' -> o konuşmadaki TÜM mesajları (viewerId için) sil.
  // Aksi halde belirtilen id'lerden SADECE bu konuşmaya ait olanları siler
  // (başka bir konuşmadaki bir id'yi kazayla/kötü niyetle silmeye çalışmak
  // sessizce yok sayılır).
  deleteDmMessagesForUser(viewerId, otherId, messageIds) {
    const deleteAll = messageIds === 'all';
    const idSet = deleteAll ? null : new Set(messageIds);
    let changed = false;
    for (const m of Object.values(this.dmMessages)) {
      const inConversation = (m.fromId === viewerId && m.toId === otherId) || (m.fromId === otherId && m.toId === viewerId);
      if (!inConversation) continue;
      if (!deleteAll && !idSet.has(m.id)) continue;
      if (!m.deletedForIds.includes(viewerId)) { m.deletedForIds.push(viewerId); changed = true; }
    }
    if (changed) this._persistDm();
  }
}

module.exports = { Store, RATING_CATEGORIES, GAMES_NEEDED_FOR_ESTABLISHED };
