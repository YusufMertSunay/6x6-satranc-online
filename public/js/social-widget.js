// public/js/social-widget.js — Kullanıcı isteği: "özel mesaj + arkadaşlık +
// bildirim zili" özelliği. challenge-widget.js ile AYNI mimari desen: sitenin
// HER sayfasına (lobi/oyun/analiz -- bkz. index.html, game.html, analysis.html)
// eklenen, kendi DOM'unu KENDİSİ oluşturan, kendi BAĞIMSIZ SSE bağlantısını
// açan paylaşılan bir bileşen. Sunucu tarafı için bkz. lib/socialManager.js,
// lib/store.js (friendIds/messageBlockedUserIds/dmMessages) ve server.js'deki
// /api/friends/* + /api/dm/* uçları.
//
// Görsel yerleşim (kullanıcı isteği): ekranın SAĞ ÜSTÜNDE küçük bir zil
// ikonu (gelen özel mesajlar), ekranın SOL ALTINDA "Arkadaşlarım" düğmesi --
// ikisi de CSS ile sabit (fixed) konumlandırılıyor (bkz. style.css:
// .social-bell-btn / .social-friends-btn) ki HANGİ sayfada olursa olsun
// aynı yerde görünsün.
//
// index.html'de kullanıcı GİRİŞ YAPMADAN ÖNCE de bu script çalışıyor (auth
// ekranı) -- bu yüzden (challenge-widget.js'nin aksine, o SADECE zaten giriş
// yapılmış sayfalara ekleniyor) burada bir "activate/deactivate" mekanizması
// var: sayfa yüklenince KENDİSİ /api/me ile oturum olup olmadığına bakıyor
// (game.html/analysis.html'de bu her zaman başarılı olur), index.html'de ise
// oturum yoksa arayüz gizli kalıyor ve app.js, giriş/kayıt/çıkış anlarında
// window.SocialWidget.activate(user)/deactivate() ile bize haber veriyor.
(function () {
  const $ = (id) => document.getElementById(id);

  let active = false;
  let meId = null;
  let sse = null;

  // O an açık olan konuşma penceresinin durumu -- 'returnTo' geri (◄) düğmesi
  // basılınca hangi listeye (gelen kutusu mu, arkadaşlar mı) dönüleceğini
  // belirtir; hiçbir listeden açılmadıysa (profil penceresinden "Mesaj Yaz"
  // ile açıldıysa) null'dur ve geri düğmesi gösterilmez.
  let conv = null; // { username, isFriend, messages, returnTo, selected: Set }

  async function api(method, pathname, body) {
    const res = await fetch(pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { }
    if (!res.ok) {
      const err = new Error((json && json.error) || (window.I18N ? I18N.t('err.unknown') : 'Hata'));
      err.payload = json;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  function formatTime(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ============================================================
  // DOM iskeletini bir kere oluşturur (bkz. challenge-widget.js:
  // ensureWidgetEl ile aynı desen).
  // ============================================================
  let dom = null;
  function ensureDom() {
    if (dom) return dom;

    const bellBtn = document.createElement('button');
    bellBtn.type = 'button';
    bellBtn.id = 'socialBellBtn';
    bellBtn.className = 'social-bell-btn hidden';
    bellBtn.innerHTML = '🔔<span class="social-badge-dot hidden" id="socialBellDot"></span>';
    document.body.appendChild(bellBtn);

    const friendsBtn = document.createElement('button');
    friendsBtn.type = 'button';
    friendsBtn.id = 'socialFriendsBtn';
    friendsBtn.className = 'social-friends-btn hidden';
    friendsBtn.innerHTML = '<span id="socialFriendsBtnText"></span><span class="social-badge-dot hidden" id="socialFriendsDot"></span>';
    document.body.appendChild(friendsBtn);

    const inboxModal = document.createElement('div');
    inboxModal.id = 'socialInboxModal';
    inboxModal.className = 'modal-overlay hidden';
    inboxModal.innerHTML =
      '<div class="card social-modal-box">' +
      '<div class="player-profile-header">' +
      '<h3 id="socialInboxTitle"></h3>' +
      '<button type="button" class="secondary tiny" id="socialInboxCloseBtn"></button>' +
      '</div>' +
      '<ul class="games-list" id="socialInboxList"></ul>' +
      '</div>';
    document.body.appendChild(inboxModal);

    const friendsModal = document.createElement('div');
    friendsModal.id = 'socialFriendsModal';
    friendsModal.className = 'modal-overlay hidden';
    friendsModal.innerHTML =
      '<div class="card social-modal-box">' +
      '<div class="player-profile-header">' +
      '<h3 id="socialFriendsTitle"></h3>' +
      '<button type="button" class="secondary tiny" id="socialFriendsCloseBtn"></button>' +
      '</div>' +
      '<div id="socialIncomingRequestsBox" class="hidden">' +
      '<h4 id="socialIncomingRequestsTitle" style="margin-bottom:6px"></h4>' +
      '<ul class="games-list" id="socialIncomingRequestsList"></ul>' +
      '</div>' +
      '<ul class="games-list" id="socialFriendsList"></ul>' +
      '</div>';
    document.body.appendChild(friendsModal);

    const convModal = document.createElement('div');
    convModal.id = 'socialConvModal';
    convModal.className = 'modal-overlay hidden';
    convModal.innerHTML =
      '<div class="card social-modal-box">' +
      '<div class="player-profile-header">' +
      '<button type="button" class="secondary tiny hidden" id="socialConvBackBtn"></button>' +
      '<h3 id="socialConvUsername"></h3>' +
      '<button type="button" class="secondary tiny" id="socialConvCloseBtn"></button>' +
      '</div>' +
      '<p class="hint-text hidden" id="socialConvFriendNote"></p>' +
      '<div class="social-conv-actions">' +
      '<button type="button" class="secondary tiny" id="socialConvMessageBlockBtn"></button>' +
      '<button type="button" class="danger tiny" id="socialConvFullBlockBtn"></button>' +
      '<button type="button" class="secondary tiny" id="socialConvDeleteSelectedBtn"></button>' +
      '<button type="button" class="danger tiny" id="socialConvDeleteAllBtn"></button>' +
      '</div>' +
      '<div class="chat-messages" id="socialConvMessages" style="max-height:320px"></div>' +
      '<div class="error-text" id="socialConvError"></div>' +
      '<div class="hint-text hidden" id="socialConvRateHint"></div>' +
      '<form class="chat-form" id="socialConvForm">' +
      '<input type="text" id="socialConvInput" autocomplete="off">' +
      '<button class="primary" type="submit" id="socialConvSendBtn"></button>' +
      '</form>' +
      '</div>';
    document.body.appendChild(convModal);

    dom = { bellBtn, friendsBtn, inboxModal, friendsModal, convModal };
    wireStaticListeners();
    return dom;
  }

  function closeAllModals() {
    $('socialInboxModal').classList.add('hidden');
    $('socialFriendsModal').classList.add('hidden');
    $('socialConvModal').classList.add('hidden');
  }

  function wireStaticListeners() {
    $('socialBellBtn').addEventListener('click', openInbox);
    $('socialFriendsBtn').addEventListener('click', openFriends);
    $('socialInboxCloseBtn').addEventListener('click', () => $('socialInboxModal').classList.add('hidden'));
    $('socialFriendsCloseBtn').addEventListener('click', () => $('socialFriendsModal').classList.add('hidden'));
    $('socialConvCloseBtn').addEventListener('click', () => { $('socialConvModal').classList.add('hidden'); conv = null; });
    $('socialConvBackBtn').addEventListener('click', () => {
      const returnTo = conv ? conv.returnTo : null;
      $('socialConvModal').classList.add('hidden');
      conv = null;
      if (returnTo === 'inbox') openInbox();
      else if (returnTo === 'friends') openFriends();
    });
    // Karartılmış arka plana tıklanınca kapansın (playerProfileModal ile
    // aynı desen, bkz. app.js).
    ['socialInboxModal', 'socialFriendsModal', 'socialConvModal'].forEach(id => {
      $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).classList.add('hidden'); });
    });
    $('socialConvForm').addEventListener('submit', (e) => { e.preventDefault(); sendConvMessage(); });
    $('socialConvMessageBlockBtn').addEventListener('click', onMessageBlockClick);
    $('socialConvFullBlockBtn').addEventListener('click', onFullBlockClick);
    $('socialConvDeleteSelectedBtn').addEventListener('click', onDeleteSelectedClick);
    $('socialConvDeleteAllBtn').addEventListener('click', onDeleteAllClick);
  }

  function applyStaticTexts() {
    if (!dom) return;
    $('socialBellBtn').title = I18N.t('social.bellTitle');
    $('socialFriendsBtnText').textContent = I18N.t('social.friendsButtonText');
    $('socialInboxTitle').textContent = I18N.t('social.inboxTitle');
    $('socialInboxCloseBtn').textContent = I18N.t('common.close');
    $('socialFriendsTitle').textContent = I18N.t('social.friendsTitle');
    $('socialFriendsCloseBtn').textContent = I18N.t('common.close');
    $('socialIncomingRequestsTitle').textContent = I18N.t('social.incomingRequestsTitle');
    $('socialConvCloseBtn').textContent = I18N.t('common.close');
    $('socialConvBackBtn').textContent = I18N.t('social.backBtn');
    $('socialConvMessageBlockBtn').textContent = I18N.t('social.messageBlockBtn');
    $('socialConvFullBlockBtn').textContent = I18N.t('social.fullBlockBtn');
    $('socialConvDeleteSelectedBtn').textContent = I18N.t('social.deleteSelectedBtn');
    $('socialConvDeleteAllBtn').textContent = I18N.t('social.deleteAllBtn');
    $('socialConvInput').placeholder = I18N.t('social.conversationPlaceholder');
    $('socialConvSendBtn').textContent = I18N.t('social.sendBtn');
  }

  // ============================================================
  // Rozetler (bell/arkadaşlar düğmesinin sağ üstündeki turuncu nokta) --
  // kullanıcı isteği: "belli olacak kadar büyük" -- bkz. style.css:
  // .social-badge-dot.
  // ============================================================
  async function refreshBadges() {
    if (!active) return;
    try {
      const [counts, incoming] = await Promise.all([
        api('GET', '/api/dm/unread-counts'),
        api('GET', '/api/friends/incoming'),
      ]);
      $('socialBellDot').classList.toggle('hidden', counts.total <= 0);
      // Kullanıcı isteği: "Arkadaşlarım" düğmesindeki nokta SADECE
      // arkadaşlardan gelen okunmamış mesajlar için yanıyor -- ayrıca (kendi
      // kararımız, kullanıcı özellikle belirtmedi ama makul bir genelleme)
      // bekleyen bir arkadaşlık teklifi varken de yanıyor, çünkü bu pencere
      // aynı zamanda o tekliflerin gösterildiği tek yer.
      const friendsDotOn = counts.fromFriends > 0 || (incoming.usernames && incoming.usernames.length > 0);
      $('socialFriendsDot').classList.toggle('hidden', !friendsDotOn);
    } catch { /* önemli değil -- bir sonraki denemede düzelir */ }
  }

  // ============================================================
  // Gelen kutusu (zil ikonu)
  // ============================================================
  async function openInbox() {
    ensureDom();
    try {
      const { conversations } = await api('GET', '/api/dm/inbox');
      const list = $('socialInboxList');
      list.innerHTML = '';
      if (!conversations.length) {
        list.innerHTML = `<li class="hint-text">${I18N.t('social.inboxEmpty')}</li>`;
      } else {
        conversations.forEach(c => list.appendChild(buildInboxRow(c, 'inbox')));
      }
      closeAllModals();
      $('socialInboxModal').classList.remove('hidden');
    } catch (err) { alert(I18N.tErr(err)); }
  }

  function buildInboxRow(c, returnTo) {
    const li = document.createElement('li');
    li.style.cursor = 'pointer';
    const left = document.createElement('span');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = c.username;
    nameSpan.style.fontWeight = '700';
    left.appendChild(nameSpan);
    if (c.lastMessage) {
      const preview = document.createElement('span');
      preview.className = 'hint-text';
      preview.style.marginLeft = '8px';
      const text = c.lastMessage.text.length > 40 ? c.lastMessage.text.slice(0, 40) + '…' : c.lastMessage.text;
      preview.textContent = text;
      left.appendChild(preview);
    }
    const right = document.createElement('span');
    if (c.unreadCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'social-badge-dot social-badge-dot-inline';
      badge.title = String(c.unreadCount);
      right.appendChild(badge);
    }
    li.appendChild(left);
    li.appendChild(right);
    li.addEventListener('click', () => openConversation(c.username, returnTo));
    return li;
  }

  // ============================================================
  // Arkadaşlarım
  // ============================================================
  async function openFriends() {
    ensureDom();
    try {
      const [{ usernames: friends }, { usernames: incoming }, inboxData] = await Promise.all([
        api('GET', '/api/friends/list'),
        api('GET', '/api/friends/incoming'),
        api('GET', '/api/dm/inbox'),
      ]);
      const inboxByUsername = new Map(inboxData.conversations.map(c => [c.username.toLowerCase(), c]));

      const incomingBox = $('socialIncomingRequestsBox');
      incomingBox.classList.toggle('hidden', incoming.length === 0);
      const incomingList = $('socialIncomingRequestsList');
      incomingList.innerHTML = '';
      incoming.forEach(username => incomingList.appendChild(buildIncomingRequestRow(username)));

      const list = $('socialFriendsList');
      list.innerHTML = '';
      if (!friends.length) {
        list.innerHTML = `<li class="hint-text">${I18N.t('social.friendsEmpty')}</li>`;
      } else {
        friends.forEach(username => {
          const c = inboxByUsername.get(username.toLowerCase()) || { username, lastMessage: null, unreadCount: 0 };
          list.appendChild(buildFriendRow(c));
        });
      }
      closeAllModals();
      $('socialFriendsModal').classList.remove('hidden');
    } catch (err) { alert(I18N.tErr(err)); }
  }

  function buildIncomingRequestRow(username) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = username;
    const btns = document.createElement('span');
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'primary tiny';
    acceptBtn.textContent = I18N.t('common.accept');
    acceptBtn.style.marginRight = '6px';
    acceptBtn.addEventListener('click', async () => {
      try { await api('POST', '/api/friends/respond', { username, accept: true }); refreshBadges(); await openFriends(); }
      catch (err) { alert(I18N.tErr(err)); }
    });
    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'secondary tiny';
    declineBtn.textContent = I18N.t('common.decline');
    declineBtn.addEventListener('click', async () => {
      try { await api('POST', '/api/friends/respond', { username, accept: false }); await openFriends(); }
      catch (err) { alert(I18N.tErr(err)); }
    });
    btns.appendChild(acceptBtn);
    btns.appendChild(declineBtn);
    li.appendChild(span);
    li.appendChild(btns);
    return li;
  }

  function buildFriendRow(c) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.style.cursor = 'pointer';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = c.username;
    nameSpan.style.fontWeight = '700';
    left.appendChild(nameSpan);
    if (c.unreadCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'social-badge-dot social-badge-dot-inline';
      badge.style.marginLeft = '6px';
      left.appendChild(badge);
    }
    left.addEventListener('click', () => openConversation(c.username, 'friends'));

    const right = document.createElement('span');
    right.style.display = 'flex';
    right.style.gap = '6px';
    right.style.flexWrap = 'wrap';

    const msgBtn = document.createElement('button');
    msgBtn.type = 'button';
    msgBtn.className = 'secondary tiny';
    msgBtn.textContent = I18N.t('lobby.profileMessageBtn');
    msgBtn.addEventListener('click', () => openConversation(c.username, 'friends'));

    const unfriendBtn = document.createElement('button');
    unfriendBtn.type = 'button';
    unfriendBtn.className = 'secondary tiny';
    unfriendBtn.textContent = I18N.t('social.unfriendBtn');
    unfriendBtn.addEventListener('click', async () => {
      if (!confirm(I18N.t('social.unfriendConfirm', { username: c.username }))) return;
      try { await api('POST', '/api/friends/unfriend', { username: c.username }); await openFriends(); }
      catch (err) { alert(I18N.tErr(err)); }
    });

    const msgBlockBtn = document.createElement('button');
    msgBlockBtn.type = 'button';
    msgBlockBtn.className = 'secondary tiny';
    msgBlockBtn.textContent = I18N.t('social.messageBlockBtn');
    msgBlockBtn.addEventListener('click', async () => {
      if (!confirm(I18N.t('social.messageBlockConfirm', { username: c.username }))) return;
      try { await api('POST', '/api/dm/message-block', { username: c.username }); await openFriends(); }
      catch (err) { alert(I18N.tErr(err)); }
    });

    const fullBlockBtn = document.createElement('button');
    fullBlockBtn.type = 'button';
    fullBlockBtn.className = 'danger tiny';
    fullBlockBtn.textContent = I18N.t('social.fullBlockBtn');
    fullBlockBtn.addEventListener('click', async () => {
      if (!confirm(I18N.t('social.fullBlockConfirm', { username: c.username }))) return;
      try { await api('POST', '/api/block/add', { username: c.username }); await openFriends(); }
      catch (err) { alert(I18N.tErr(err)); }
    });

    right.appendChild(msgBtn);
    right.appendChild(unfriendBtn);
    right.appendChild(msgBlockBtn);
    right.appendChild(fullBlockBtn);
    li.appendChild(left);
    li.appendChild(right);
    return li;
  }

  // ============================================================
  // Konuşma penceresi (özel mesajlar) -- hem gelen kutusundan hem
  // Arkadaşlarım'dan hem de oyuncu profili penceresindeki "Mesaj Yaz"
  // düğmesinden (bkz. app.js) AÇILABİLEN, PAYLAŞILAN tek bir pencere.
  // ============================================================
  async function openConversation(username, returnTo) {
    ensureDom();
    try {
      const data = await api('GET', '/api/dm/conversation?username=' + encodeURIComponent(username));
      conv = { username: data.username, isFriend: data.isFriend, messages: data.messages, returnTo, selected: new Set() };
      renderConversation();
      closeAllModals();
      $('socialConvModal').classList.remove('hidden');
      $('socialConvInput').focus();
      // Pencereyi açar açmaz okunmuş sayalım (kullanıcı isteği: zil/Arkadaşlarım
      // rozetleri sadece OKUNMAMIŞ mesajlar için yanıyor).
      try { await api('POST', '/api/dm/mark-read', { username: data.username }); } catch { /* önemli değil */ }
      refreshBadges();
    } catch (err) { alert(I18N.tErr(err)); }
  }

  // Sunucudaki store.trailingDmStreak ile AYNI mantık (bkz. chat.js:
  // trailingStreak) -- anında istemci-taraflı geri bildirim için.
  function trailingStreak(messages, senderId) {
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].fromId === senderId) count++;
      else break;
    }
    return count;
  }

  function renderConversation() {
    if (!conv) return;
    $('socialConvBackBtn').classList.toggle('hidden', !conv.returnTo);
    $('socialConvUsername').textContent = conv.username;
    $('socialConvFriendNote').classList.toggle('hidden', !conv.isFriend);
    if (conv.isFriend) $('socialConvFriendNote').textContent = I18N.t('social.friendTag').trim();

    const listEl = $('socialConvMessages');
    listEl.innerHTML = '';
    if (!conv.messages.length) {
      listEl.innerHTML = `<div class="hint-text chat-empty-note">${I18N.t('social.noMessagesYet')}</div>`;
    } else {
      conv.messages.forEach(m => {
        const isMe = m.fromId === meId;
        const row = document.createElement('div');
        row.className = 'chat-msg' + (isMe ? ' chat-msg-mine' : '');
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        const head = document.createElement('div');
        head.className = 'chat-msg-head';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'social-msg-checkbox';
        checkbox.checked = conv.selected.has(m.id);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) conv.selected.add(m.id); else conv.selected.delete(m.id);
        });
        head.appendChild(checkbox);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'chat-msg-sender';
        nameSpan.textContent = isMe ? '' : conv.username;
        head.appendChild(nameSpan);
        const timeSpan = document.createElement('span');
        timeSpan.className = 'chat-msg-time';
        timeSpan.textContent = formatTime(m.sentAt);
        head.appendChild(timeSpan);
        const textDiv = document.createElement('div');
        textDiv.className = 'chat-msg-text';
        textDiv.textContent = m.text;
        bubble.appendChild(head);
        bubble.appendChild(textDiv);
        row.appendChild(bubble);
        listEl.appendChild(row);
      });
      listEl.scrollTop = listEl.scrollHeight;
    }

    // Kullanıcı isteği: arkadaş DEĞİLLERSE karşı taraf cevap verene kadar
    // art arda en fazla 2 mesaj -- arkadaşsanız SINIRSIZ.
    const input = $('socialConvInput');
    const sendBtn = $('socialConvSendBtn');
    const hint = $('socialConvRateHint');
    if (!conv.isFriend && trailingStreak(conv.messages, meId) >= 2) {
      input.disabled = true;
      sendBtn.disabled = true;
      hint.textContent = I18N.t('social.rateLimitHint');
      hint.classList.remove('hidden');
    } else {
      input.disabled = false;
      sendBtn.disabled = false;
      hint.textContent = '';
      hint.classList.add('hidden');
    }
    $('socialConvError').textContent = '';
  }

  async function sendConvMessage() {
    if (!conv) return;
    const input = $('socialConvInput');
    const text = (input.value || '').trim();
    if (!text) return;
    try {
      const { message } = await api('POST', '/api/dm/send', { username: conv.username, text });
      conv.messages.push(message);
      input.value = '';
      renderConversation();
    } catch (err) {
      $('socialConvError').textContent = I18N.t('social.sendFailedPrefix') + I18N.tErr(err);
    }
  }

  async function onMessageBlockClick() {
    if (!conv) return;
    if (!confirm(I18N.t('social.messageBlockConfirm', { username: conv.username }))) return;
    try {
      await api('POST', '/api/dm/message-block', { username: conv.username });
      conv.isFriend = false;
      renderConversation();
    } catch (err) { alert(I18N.tErr(err)); }
  }

  async function onFullBlockClick() {
    if (!conv) return;
    if (!confirm(I18N.t('social.fullBlockConfirm', { username: conv.username }))) return;
    try {
      await api('POST', '/api/block/add', { username: conv.username });
      conv.isFriend = false;
      renderConversation();
    } catch (err) { alert(I18N.tErr(err)); }
  }

  async function onDeleteSelectedClick() {
    if (!conv) return;
    if (!conv.selected.size) { alert(I18N.t('social.deleteNoneSelected')); return; }
    if (!confirm(I18N.t('social.deleteSelectedConfirm', { count: conv.selected.size }))) return;
    try {
      const ids = Array.from(conv.selected);
      await api('POST', '/api/dm/delete', { username: conv.username, messageIds: ids });
      conv.messages = conv.messages.filter(m => !conv.selected.has(m.id));
      conv.selected.clear();
      renderConversation();
    } catch (err) { alert(I18N.tErr(err)); }
  }

  async function onDeleteAllClick() {
    if (!conv) return;
    if (!confirm(I18N.t('social.deleteAllConfirm', { username: conv.username }))) return;
    try {
      await api('POST', '/api/dm/delete', { username: conv.username, messageIds: 'all' });
      conv.messages = [];
      conv.selected.clear();
      renderConversation();
    } catch (err) { alert(I18N.tErr(err)); }
  }

  // ============================================================
  // Gerçek zamanlı (SSE) bildirimler -- kendi BAĞIMSIZ bağlantısı (bkz.
  // dosya başındaki açıklama / challenge-widget.js ile aynı mantık).
  // ============================================================
  function connectSse() {
    if (sse) sse.close();
    sse = new EventSource('/events');
    sse.addEventListener('dm_message', (e) => {
      const data = JSON.parse(e.data);
      if (conv && conv.username.toLowerCase() === (data.fromUsername || '').toLowerCase()) {
        // Konuşma zaten açıksa mesajı doğrudan ekleyip hemen okundu sayalım.
        conv.messages.push({ id: 'tmp_' + Date.now(), fromId: null, toId: meId, text: data.text, sentAt: Date.now(), read: true, senderIsOther: true });
        // fromId'yi bilmiyoruz (SSE payload'ında yok) ama bu satır SADECE
        // "karşı taraftan geldi" olarak render edilmesi için yeterli --
        // isMe kontrolü fromId === meId olduğundan, null zaten "ben değilim"
        // anlamına geliyor. Doğru sıralama/kalıcılık için pencere kapanıp
        // yeniden açıldığında sunucudan gerçek veriyle yeniden çekilecek.
        renderConversation();
        api('POST', '/api/dm/mark-read', { username: conv.username }).catch(() => { });
      }
      refreshBadges();
      if (!$('socialInboxModal').classList.contains('hidden')) openInbox();
      if (!$('socialFriendsModal').classList.contains('hidden')) openFriends();
    });
    sse.addEventListener('friend_request_received', () => {
      refreshBadges();
      if (!$('socialFriendsModal').classList.contains('hidden')) openFriends();
    });
    sse.addEventListener('friend_request_accepted', (e) => {
      const data = JSON.parse(e.data);
      alert(I18N.t('social.friendRequestAcceptedNotice', { username: data.username }));
      refreshBadges();
      if (!$('socialFriendsModal').classList.contains('hidden')) openFriends();
    });
    sse.onerror = () => { /* tarayıcı otomatik olarak yeniden bağlanmayı dener */ };
  }

  // ============================================================
  // Etkinleştirme / devre dışı bırakma (bkz. dosya başındaki açıklama).
  // ============================================================
  function activate(me) {
    ensureDom();
    meId = me.id;
    active = true;
    $('socialBellBtn').classList.remove('hidden');
    $('socialFriendsBtn').classList.remove('hidden');
    applyStaticTexts();
    connectSse();
    refreshBadges();
  }

  function deactivate() {
    active = false;
    meId = null;
    conv = null;
    if (sse) { sse.close(); sse = null; }
    if (dom) {
      $('socialBellBtn').classList.add('hidden');
      $('socialFriendsBtn').classList.add('hidden');
      closeAllModals();
    }
  }

  window.addEventListener('langchange', () => {
    applyStaticTexts();
    if (conv) renderConversation();
  });

  window.addEventListener('beforeunload', () => { if (sse) sse.close(); });

  window.SocialWidget = { activate, deactivate, openConversation, refreshBadges };

  // Sayfa yüklendiğinde: game.html/analysis.html'de kullanıcı zaten giriş
  // yapmış olduğu için (bkz. dosya başındaki açıklama) burada KENDİ /api/me
  // isteğimizle doğrudan etkinleştiriyoruz -- index.html'de ise oturum
  // yoksa bu istek 401 döner ve arayüz gizli kalır, app.js daha sonra
  // activate() ile bize haber verir.
  (async function initWidget() {
    try {
      const res = await fetch('/api/me');
      if (!res.ok) return;
      const me = await res.json();
      activate(me);
    } catch { /* önemli değil */ }
  })();
})();
