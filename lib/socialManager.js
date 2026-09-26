// lib/socialManager.js
//
// Kullanıcı isteği: "özel mesaj + arkadaşlık + bildirim zili" özelliği.
// Komple engelleme (blockUser) ve mesaj susturma (muteUser) MEVCUT (bkz.
// gameManager.js) -- bu dosya onlardan TAMAMEN AYRI ama onlarla ETKİLEŞEN
// üç yeni kavramı yönetir:
//   1) Özel mesaj (DM): herhangi bir kullanıcı, profilinden "Mesaj Yaz"
//      düğmesiyle başka birine özel mesaj gönderebilir -- karşı taraf
//      cevap verene kadar art arda en fazla 2 mesaj (arkadaş DEĞİLLERSE).
//   2) Arkadaşlık: bir teklif + karşı tarafın kabul/red etmesiyle kurulur.
//      Arkadaş olan iki kullanıcı SINIRSIZ art arda mesaj atabilir.
//   3) "Sadece mesaj atmasını engelle": komple engellemeden (blockUser)
//      DAHA HAFİF -- sadece yeni özel mesaj göndermeyi engeller, otomatik
//      olarak hem arkadaşlıktan çıkarır hem de (analiz tahtasında/oyun
//      sohbetinde otomatik gizlenmesi için) susturur (bkz. store.js:
//      messageBlockUser).
//
// Ham veri (friendIds, messageBlockedUserIds, dmMessages vb.) store.js'de
// tutuluyor -- burası SADECE iş kuralları/doğrulama (kimin kime ne
// yapabileceği) + gerçek zamanlı (SSE) bildirim gönderme katmanı, tıpkı
// gameManager.js'nin blockUser/muteUser sarmalayıcıları gibi.

const MAX_CONSECUTIVE_DM_MSGS = 2;
const DM_MESSAGE_MAX_LENGTH = 280; // sohbetteki (gameManager.js) sınırla TUTARLI

class SocialManager {
  constructor(store, hub) {
    this.store = store;
    this.hub = hub;
  }

  _requireUser(username) {
    const target = this.store.getUserByUsername(String(username || '').trim());
    if (!target) throw new Error('Oyuncu bulunamadı.');
    return target;
  }

  _isBlockedBetween(aId, bId) {
    return this.store.isBlocked(aId, bId) || this.store.isBlocked(bId, aId);
  }

  // ============================================================
  // ARKADAŞLIK
  // ============================================================

  // Kullanıcı isteği: "engellenen kullanıcılar engelleyen kullanıcıya
  // arkadaşlık teklifi edemez" -- yönü netleştirmek zor olduğu için (kim
  // kimi engellemiş fark etmeksizin) aralarında HERHANGİ bir komple
  // engelleme varsa iki yönde de teklif engelleniyor (isBlockedBetween).
  sendFriendRequest(fromId, targetUsername) {
    const target = this._requireUser(targetUsername);
    if (target.id === fromId) throw new Error('Kendine arkadaşlık teklifi gönderemezsin.');
    if (this._isBlockedBetween(fromId, target.id)) {
      throw new Error('Aranızda bir engelleme olduğu için arkadaşlık teklifi gönderemezsin.');
    }
    if (this.store.isFriend(fromId, target.id)) throw new Error('Zaten arkadaşsınız.');
    if (this.store.hasOutgoingFriendRequest(fromId, target.id)) {
      throw new Error('Zaten bekleyen bir arkadaşlık teklifin var.');
    }
    const fromUser = this.store.getUserById(fromId);
    // Karşı taraf da BİZE zaten teklif göndermişse (iki taraf birbirine aynı
    // anda teklif göndermiş) -- beklemenin bir anlamı yok, direkt arkadaş
    // yapıyoruz (kullanıcı özellikle istemedi ama makul bir varsayım).
    if (this.store.hasOutgoingFriendRequest(target.id, fromId)) {
      this.store.acceptFriendRequest(target.id, fromId);
      this.hub.sendTo(target.id, 'friend_request_accepted', { username: fromUser?.username });
      return { ok: true, username: target.username, autoAccepted: true };
    }
    this.store.createFriendRequest(fromId, target.id);
    this.hub.sendTo(target.id, 'friend_request_received', { fromUsername: fromUser?.username });
    return { ok: true, username: target.username };
  }

  // accept=true/false -- teklifi gönderen KULLANICI ADINA göre (userId,
  // bu teklifi ALAN taraf).
  respondFriendRequest(userId, fromUsername, accept) {
    const fromUser = this._requireUser(fromUsername);
    if (!this.store.hasOutgoingFriendRequest(fromUser.id, userId)) {
      throw new Error('Böyle bir arkadaşlık teklifi yok (zaten yanıtlanmış olabilir).');
    }
    if (accept) {
      this.store.acceptFriendRequest(fromUser.id, userId);
      const me = this.store.getUserById(userId);
      this.hub.sendTo(fromUser.id, 'friend_request_accepted', { username: me?.username });
    } else {
      this.store.declineFriendRequest(fromUser.id, userId);
    }
    return { ok: true, username: fromUser.username };
  }

  unfriend(userId, targetUsername) {
    const target = this._requireUser(targetUsername);
    this.store.unfriend(userId, target.id);
    return { ok: true, username: target.username };
  }

  listFriends(userId) {
    return this.store.getFriendUsernames(userId);
  }

  listIncomingFriendRequests(userId) {
    return this.store.getIncomingFriendRequestUsernames(userId);
  }

  // ============================================================
  // "SADECE MESAJ ATMASINI ENGELLE" (komple engellemeden daha hafif)
  // ============================================================

  messageBlock(userId, targetUsername) {
    const target = this._requireUser(targetUsername);
    if (target.id === userId) throw new Error('Kendini engelleyemezsin.');
    this.store.messageBlockUser(userId, target.id);
    return { ok: true, username: target.username };
  }

  // ============================================================
  // ÖZEL MESAJ (DM)
  // ============================================================

  // Sunucudaki (gameManager.js: _trailingStreak) ile AYNI mantık -- bir
  // mesaj dizisinin sonundan geriye, aynı göndericinin kaç mesajının ÜST
  // ÜSTE durduğunu sayar. Burada store.trailingDmStreak zaten bu hesabı
  // yapıyor, bu fonksiyon ekstra bir sarmalayıcı değil -- doğrudan onu
  // kullanıyoruz (bkz. sendDirectMessage).

  sendDirectMessage(fromId, toUsername, text) {
    const target = this._requireUser(toUsername);
    if (target.id === fromId) throw new Error('Kendine mesaj gönderemezsin.');

    // Alıcı beni komple engellemiş VEYA sadece mesajlarımı engellemiş --
    // her iki durumda da mesaj gönderemem (komple engelleme zaten otomatik
    // olarak messageBlockedUserIds'e de eklendiği için tek bir kontrol
    // (isMessageBlocked) HER İKİ durumu da kapsıyor, bkz. store.js: blockUser).
    if (this.store.isMessageBlocked(target.id, fromId)) {
      const err = new Error('Bu kullanıcı mesaj almayı engellemiş, ona özel mesaj gönderemezsin.');
      err.code = 'DM_BLOCKED_BY_RECIPIENT';
      throw err;
    }

    const raw = String(text == null ? '' : text).trim();
    if (!raw) throw new Error('Mesaj boş olamaz.');
    if (raw.length > DM_MESSAGE_MAX_LENGTH) throw new Error('Mesaj çok uzun (en fazla 280 karakter).');

    const isFriend = this.store.isFriend(fromId, target.id);
    if (!isFriend) {
      const streak = this.store.trailingDmStreak(fromId, target.id, fromId);
      if (streak >= MAX_CONSECUTIVE_DM_MSGS) {
        const err = new Error('Karşı taraf cevap verene kadar art arda en fazla 2 özel mesaj gönderebilirsin.');
        err.code = 'DM_RATE_LIMIT';
        throw err;
      }
    }

    const msg = this.store.appendDirectMessage(fromId, target.id, raw);

    // Kullanıcı isteği (canlı oyun sohbetindeki AYNI kuralın, tutarlılık
    // için özel mesajlara da uygulanan genellemesi): ben (gönderen), alıcıyı
    // daha önce mesaj-engellemişsem, ona mesaj göndermem bu engeli OTOMATİK
    // olarak kaldırır.
    if (this.store.isMessageBlocked(fromId, target.id)) {
      this.store.unMessageBlockUser(fromId, target.id);
    }

    const fromUser = this.store.getUserById(fromId);
    this.hub.sendTo(target.id, 'dm_message', { fromUsername: fromUser?.username, text: raw });
    return { message: this._publicMessage(msg) };
  }

  _publicMessage(m) {
    return { id: m.id, fromId: m.fromId, toId: m.toId, text: m.text, sentAt: m.sentAt, read: m.read };
  }

  // Belirli bir kullanıcıyla olan TÜM konuşmayı döner (okundu olarak
  // işaretlemez -- bkz. markRead, ayrı çağrılıyor ki liste sayfasında
  // sadece ÖNİZLEME görüp henüz açmadan okunmuş sayılmasın).
  getConversation(userId, otherUsername) {
    const other = this._requireUser(otherUsername);
    const messages = this.store.getConversation(userId, other.id, userId).map(m => this._publicMessage(m));
    return {
      username: other.username,
      isFriend: this.store.isFriend(userId, other.id),
      messages,
    };
  }

  markRead(userId, otherUsername) {
    const other = this._requireUser(otherUsername);
    this.store.markConversationRead(userId, other.id);
    return { ok: true };
  }

  // messageIds: 'all' ya da mesaj id dizisi.
  deleteMessages(userId, otherUsername, messageIds) {
    const other = this._requireUser(otherUsername);
    this.store.deleteDmMessagesForUser(userId, other.id, messageIds);
    return { ok: true };
  }

  // Gelen kutusu (bildirim zili penceresi) -- her konuşma için karşı
  // tarafın kullanıcı adı + son mesaj + okunmamış sayısı.
  getInbox(userId) {
    return this.store.getInboxConversations(userId).map(entry => {
      const otherUser = this.store.getUserById(entry.otherId);
      return {
        username: otherUser?.username || '?',
        lastMessage: this._publicMessage(entry.lastMessage),
        unreadCount: entry.unreadCount,
      };
    });
  }

  // Zil rozetindeki nokta (TÜM okunmamışlar) + "Arkadaşlarım" düğmesindeki
  // nokta (SADECE arkadaşlardan gelen okunmamışlar) -- kullanıcı isteği: bu
  // ikisi AYRI sayaçlar.
  unreadCounts(userId) {
    const total = this.store.unreadDmCount(userId);
    const u = this.store.getUserById(userId);
    const friendIds = (u && Array.isArray(u.friendIds)) ? u.friendIds : [];
    const fromFriends = this.store.unreadDmCountFromIds(userId, friendIds);
    return { total, fromFriends };
  }
}

module.exports = { SocialManager };
