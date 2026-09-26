// public/js/chat.js — Oyun ekranı (game.js) VE analiz tahtası (analysis.js)
// tarafından ORTAK kullanılan sohbet paneli mantığı (kullanıcı isteği:
// chat/seyirci özelliği). İkisi de AYNI /api/game/:id/chat uç noktasını ve
// aynı gerçek-zamanlı 'chat_message' SSE olayını kullanıyor -- canlı oyun
// sırasında oyuncu/seyirci sohbetleri AYRI, oyun bittikten sonra TEK
// birleşik sohbet (bkz. lib/gameManager.js: getChat/sendChat). Bu dosya bu
// iki bağlamı (game.html / analysis.html) TEK bir yerden, aynı DOM
// id'lerini kullanarak yönetiyor -- ikisinin HTML'i de birebir aynı sohbet
// bölümünü içeriyor (bkz. game.html ve analysis.html: #chatSection).
//
// Sunucu, mesajları HİÇBİR ZAMAN silmiyor -- engelleme/susturma sadece
// GÖRÜNTÜLEME anında filtreleniyor (bkz. _isMessageHiddenFor). Bu yüzden
// bir kullanıcıyı susturduğumuzda/engelini kaldırdığımızda, önceden
// gizli/görünür olan mesajların doğru sırada güncellenmesi için tek
// yapmamız gereken şey sohbeti BAŞTAN çekmek (reload()) -- ekstra bir
// "yeniden oynatma" mantığına hiç gerek yok.
(function () {
  const $ = (id) => document.getElementById(id);

  let gameId = null;
  let meId = null;
  let phase = null; // 'live' | 'finished'
  let isPlayerRole = false;
  let primaryMessages = [];   // canlıyken: oyuncu sohbeti; bittikten sonra: birleşik sohbet
  let secondaryMessages = []; // sadece canlı + seyirci iken anlamlı: seyirci sohbeti
  let hasSecondary = false;
  let mutedUsernames = new Set();
  let hidden = false; // kullanıcı "sohbeti gizle" dediyse (kendisi için, bkz. localStorage)

  function hideKey() { return 'chatHidden_' + gameId; }

  async function api(method, pathname, body) {
    const res = await fetch(pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { }
    if (!res.ok) {
      const err = new Error((json && json.error) || I18N.t('err.unknown'));
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

  // Sunucudaki _trailingStreak ile BİREBİR AYNI mantık -- sunucuya hiç
  // sormadan, ANINDA "artık gönderemezsin" geri bildirimi göstermek için.
  // NİHAİ karar hâlâ sunucuda (bkz. gameManager.js: sendChat) -- bu sadece
  // bir ön tahmin/UX kolaylığı.
  function trailingStreak(arr, senderId) {
    let count = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].senderId === senderId) count++;
      else break;
    }
    return count;
  }

  function renderMutedPanel() {
    const list = $('chatMutedList');
    if (!list) return;
    list.innerHTML = '';
    if (!mutedUsernames.size) {
      list.innerHTML = `<li class="hint-text">${I18N.t('chat.mutedListEmpty')}</li>`;
      return;
    }
    mutedUsernames.forEach(username => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = username;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary tiny';
      btn.textContent = I18N.t('chat.unmuteButton');
      btn.addEventListener('click', async () => {
        try {
          await api('POST', '/api/mute/remove', { username });
          mutedUsernames.delete(username);
          renderMutedPanel();
          await reload();
        } catch (err) { alert(I18N.tErr(err)); }
      });
      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function renderMessageList(listEl, messages) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!messages.length) {
      listEl.innerHTML = `<div class="hint-text chat-empty-note">${I18N.t('chat.emptyNote')}</div>`;
      return;
    }
    messages.forEach(m => {
      const isMe = m.senderId === meId;
      const row = document.createElement('div');
      row.className = 'chat-msg' + (isMe ? ' chat-msg-mine' : '');
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      const head = document.createElement('div');
      head.className = 'chat-msg-head';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'chat-msg-sender';
      nameSpan.textContent = m.senderUsername;
      head.appendChild(nameSpan);
      if (!isMe) {
        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = 'chat-mute-btn';
        muteBtn.title = I18N.t('chat.muteButtonTitle');
        muteBtn.textContent = '🔇';
        muteBtn.addEventListener('click', async () => {
          try {
            await api('POST', '/api/mute/add', { username: m.senderUsername });
            mutedUsernames.add(m.senderUsername);
            renderMutedPanel();
            await reload();
          } catch (err) { alert(I18N.tErr(err)); }
        });
        head.appendChild(muteBtn);
      }
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

  function updateRateLimitUi(inputEl, sendBtn, hintEl, messages, limit, hintKey) {
    if (!inputEl) return;
    const streak = trailingStreak(messages, meId);
    const limited = streak >= limit;
    inputEl.disabled = limited;
    if (sendBtn) sendBtn.disabled = limited;
    if (hintEl) {
      hintEl.textContent = limited ? I18N.t(hintKey) : '';
      hintEl.classList.toggle('hidden', !limited);
    }
  }

  function clearRateLimitUi(inputEl, sendBtn, hintEl) {
    if (inputEl) inputEl.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    if (hintEl) { hintEl.textContent = ''; hintEl.classList.add('hidden'); }
  }

  function renderAll() {
    const wrap = $('chatPanelsWrap');
    const toggleBtn = $('chatHideToggleBtn');
    if (toggleBtn) toggleBtn.textContent = hidden ? I18N.t('chat.show') : I18N.t('chat.hide');
    if (wrap) wrap.classList.toggle('hidden', hidden);
    if (hidden) return;

    const primaryTitle = $('primaryChatTitle');
    const secondaryBox = $('secondaryChatBox');
    const primaryForm = $('primaryChatForm');
    const primaryInput = $('primaryChatInput');
    const primarySendBtn = primaryForm ? primaryForm.querySelector('button') : null;
    const primaryHint = $('primaryChatHint');

    if (phase === 'finished') {
      if (primaryTitle) primaryTitle.textContent = I18N.t('chat.mergedChatTitle');
      renderMessageList($('primaryChatMessages'), primaryMessages);
      if (primaryForm) primaryForm.classList.remove('hidden');
      if (secondaryBox) secondaryBox.classList.add('hidden');
      // Kullanıcı isteği: birleşik (oyun sonu) sohbette de canlı oyuncu
      // sohbetiyle AYNI art arda mesaj sınırı geçerli (bkz. gameManager.js:
      // sendChat -- merged dalı da artık _trailingStreak kontrolü yapıyor).
      updateRateLimitUi(primaryInput, primarySendBtn, primaryHint, primaryMessages, 2, 'chat.mergedRateLimitHint');
      return;
    }

    // Canlı oyun.
    if (primaryTitle) primaryTitle.textContent = I18N.t('chat.playerChatTitle');
    renderMessageList($('primaryChatMessages'), primaryMessages);
    if (isPlayerRole) {
      if (primaryForm) primaryForm.classList.remove('hidden');
      updateRateLimitUi(primaryInput, primarySendBtn, primaryHint, primaryMessages, 2, 'chat.playerRateLimitHint');
    } else {
      // Seyirci: oyuncu sohbetini SADECE okuyabilir, yazamaz.
      if (primaryForm) primaryForm.classList.add('hidden');
    }

    if (hasSecondary) {
      if (secondaryBox) secondaryBox.classList.remove('hidden');
      renderMessageList($('secondaryChatMessages'), secondaryMessages);
      const secForm = $('secondaryChatForm');
      const secInput = $('secondaryChatInput');
      const secSendBtn = secForm ? secForm.querySelector('button') : null;
      updateRateLimitUi(secInput, secSendBtn, $('secondaryChatHint'), secondaryMessages, 2, 'chat.spectatorRateLimitHint');
    } else if (secondaryBox) {
      secondaryBox.classList.add('hidden');
    }
  }

  async function reload() {
    let data;
    try {
      data = await api('GET', `/api/game/${gameId}/chat`);
    } catch (err) {
      console.error(I18N.t('chat.loadFailedPrefix') + I18N.tErr(err));
      return;
    }
    phase = data.phase;
    isPlayerRole = !!data.isPlayer;
    if (phase === 'finished') {
      primaryMessages = data.merged || [];
      secondaryMessages = [];
      hasSecondary = false;
    } else {
      primaryMessages = data.playerChat || [];
      secondaryMessages = data.spectatorChat || [];
      hasSecondary = !isPlayerRole && Array.isArray(data.spectatorChat);
    }
    renderAll();
  }

  async function sendFrom(inputEl) {
    const text = (inputEl.value || '').trim();
    if (!text) return;
    try {
      await api('POST', `/api/game/${gameId}/chat`, { text });
      inputEl.value = '';
      // Kendi mesajımız zaten SSE ile geri gelecek (bkz. _broadcastChat --
      // gönderen kendisi de alıcı listesinde) -- burada ekstra bir yerel
      // ekleme yapmıyoruz ki ÇİFT görünmesin.
    } catch (err) {
      alert(I18N.t('chat.sendFailedPrefix') + I18N.tErr(err));
      // Sunucu bir oran sınırı hatası döndürdüyse arayüzü hemen (SSE'yi
      // beklemeden) güncelleyelim.
      renderAll();
    }
  }

  function wireForms() {
    const pf = $('primaryChatForm');
    if (pf) pf.addEventListener('submit', (e) => { e.preventDefault(); sendFrom($('primaryChatInput')); });
    const sf = $('secondaryChatForm');
    if (sf) sf.addEventListener('submit', (e) => { e.preventDefault(); sendFrom($('secondaryChatInput')); });
    const toggleBtn = $('chatHideToggleBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        hidden = !hidden;
        try { localStorage.setItem(hideKey(), hidden ? '1' : '0'); } catch { }
        renderAll();
      });
    }
    const manageBtn = $('chatMuteManageBtn');
    const mutedPanel = $('chatMutedPanel');
    if (manageBtn && mutedPanel) {
      manageBtn.addEventListener('click', () => { mutedPanel.classList.toggle('hidden'); });
    }
  }

  async function loadMutedList() {
    try {
      const { usernames } = await api('GET', '/api/mute/list');
      mutedUsernames = new Set(usernames);
      renderMutedPanel();
    } catch { /* önemli değil, boş listeyle devam edilir */ }
  }

  // Ana sayfa betiği (game.js/analysis.js), KENDİ SSE bağlantısında
  // 'chat_message' olayı geldiğinde bu fonksiyonu çağırır (bu dosya kendi
  // SSE bağlantısını AÇMIYOR -- her sayfa zaten kendi bağlantısını yönetiyor,
  // gereksiz ikinci bir bağlantı açmamak için).
  function handleSseMessage(data) {
    if (!data || data.gameId !== gameId) return;
    const msg = data.message;
    if (!msg) return;
    if (data.channel === 'merged') {
      phase = 'finished';
      if (!primaryMessages.some(m => m.id === msg.id)) primaryMessages.push(msg);
      secondaryMessages = [];
      hasSecondary = false;
    } else if (data.channel === 'player') {
      if (!primaryMessages.some(m => m.id === msg.id)) primaryMessages.push(msg);
    } else if (data.channel === 'spectator') {
      if (!secondaryMessages.some(m => m.id === msg.id)) secondaryMessages.push(msg);
    }
    renderAll();
  }

  // Dil değişince, JS'in DİNAMİK ürettiği metinleri (kutucuk başlıkları,
  // boş liste notları, düğme metinleri) yeniden çizer -- statik olanlar
  // zaten data-i18n ile otomatik çevriliyor.
  function refreshTexts() {
    renderAll();
    renderMutedPanel();
  }

  async function init(newGameId, newMeId) {
    gameId = newGameId;
    meId = newMeId;
    try { hidden = localStorage.getItem(hideKey()) === '1'; } catch { hidden = false; }
    wireForms();
    await loadMutedList();
    await reload();
  }

  window.ChatUI = { init, handleSseMessage, reload, refreshTexts };
})();
