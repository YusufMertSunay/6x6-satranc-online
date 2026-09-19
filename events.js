// lib/events.js
//
// Gerçek zamanlı sunucu -> tarayıcı iletişimi için Server-Sent Events (SSE)
// merkezi. Socket.io kurulamadığı için (npm engelli) SSE kullanıyoruz — SSE,
// HTTP'nin (Node'un YERLEŞİK http modülünün) üzerine kurulu, ekstra paket
// gerektirmeyen, tek yönlü (sunucudan tarayıcıya) bir push mekanizmasıdır.
// Tarayıcıdan sunucuya yön ise zaten normal HTTP POST istekleriyle çalışıyor
// (hamle gönderme, teslim olma, vs.) — bu da çift yönlü gerçek zamanlı
// iletişim için yeterli, çünkü satranç hamleleri saniyede binlerce olay
// gerektirmiyor.

class EventHub {
  constructor() {
    this.clientsByUser = new Map(); // userId -> Set(res)
  }

  addClient(userId, res) {
    if (!this.clientsByUser.has(userId)) this.clientsByUser.set(userId, new Set());
    this.clientsByUser.get(userId).add(res);
  }

  removeClient(userId, res) {
    const set = this.clientsByUser.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.clientsByUser.delete(userId);
  }

  sendTo(userId, event, data) {
    const set = this.clientsByUser.get(userId);
    if (!set) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try { res.write(payload); } catch { /* bağlantı kopmuşsa önemli değil */ }
    }
  }

  isOnline(userId) {
    return this.clientsByUser.has(userId);
  }
}

module.exports = { EventHub };
