// public/js/challenge-widget.js — Sitenin HERHANGİ bir sayfasında (oyun
// ekranı, analiz tahtası) alınan doğrudan meydan okuma davetlerini ekranın
// SAĞ ALTINDA gösteren, paylaşılan bir bildirim kutusu (kullanıcı isteği:
// "özel oyun teklifi ... teklifi alanın ekranının (site ekranının) sağ
// altında da görünsün" -- Kabul Et/Reddet/Kullanıcıyı Engelle seçenekleriyle
// birlikte). Lobi (index.html) sayfası bu daveti zaten KENDİ İÇİNDE (bkz.
// app.js: #challengeIncoming) gösteriyor -- o kart da CSS ile sağ-alta
// sabitlenmiş durumda (bkz. style.css: .challenge-toast) ve aynı Engelle
// düğmesine sahip -- bu yüzden bu ayrı widget SADECE index.html DIŞINDAKİ
// sayfalara (game.html, analysis.html) ekleniyor; index.html'de İKİ AYRI
// bildirim aynı anda görünmesin diye burası oraya dahil edilmiyor.
//
// Kendi BAĞIMSIZ bir SSE (/events) bağlantısı açar -- sayfanın kendi (oyun/
// analiz) SSE bağlantısına hiç dokunmaz, aynı kullanıcı için birden fazla
// SSE bağlantısı açık olması sorun değildir (bkz. lib/events.js: EventHub
// zaten kullanıcı başına BİRDEN FAZLA bağlantıyı (Set) destekliyor).
(function () {
  let incoming = null; // { challengeId, fromUsername, timeControlKey, colorForTarget, ranked }
  let timeControls = [];
  let widgetEl = null;

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

  function colorLabel(c) {
    if (c === 'white') return I18N.t('common.white');
    if (c === 'black') return I18N.t('common.black');
    return I18N.t('common.random');
  }

  function formatTimeControlLabel(tc) {
    const [minutes, incSeconds] = tc.key.split('+').map(Number);
    let label = I18N.t('tc.minutesShort', { m: minutes });
    if (incSeconds > 0) label += I18N.t('tc.incrementShort', { s: incSeconds });
    label += ' (' + I18N.t('cat.' + tc.category) + ')';
    return label;
  }

  function ensureWidgetEl() {
    if (widgetEl) return widgetEl;
    widgetEl = document.createElement('div');
    widgetEl.id = 'challengeToastWidget';
    widgetEl.className = 'challenge-toast hidden';
    document.body.appendChild(widgetEl);
    return widgetEl;
  }

  function render() {
    const el = ensureWidgetEl();
    if (!incoming) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const tc = timeControls.find(t => t.key === incoming.timeControlKey);
    const tcLabel = tc ? formatTimeControlLabel(tc) : incoming.timeControlKey;
    const text = I18N.t('lobby.challengeIncomingText', {
      username: incoming.fromUsername,
      timeControl: tcLabel,
      color: colorLabel(incoming.colorForTarget),
      rankedNote: incoming.ranked === false ? I18N.t('lobby.challengeUnrankedTag') : '',
    });
    el.innerHTML =
      '<div class="draw-offer-banner">' +
      '<span id="cwText"></span>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap">' +
      '<button class="primary" type="button" id="cwAcceptBtn"></button>' +
      '<button class="secondary" type="button" id="cwDeclineBtn"></button>' +
      '<button class="secondary" type="button" id="cwBlockBtn"></button>' +
      '</div></div>';
    el.querySelector('#cwText').textContent = text;
    el.querySelector('#cwAcceptBtn').textContent = I18N.t('common.accept');
    el.querySelector('#cwDeclineBtn').textContent = I18N.t('common.decline');
    el.querySelector('#cwBlockBtn').textContent = I18N.t('lobby.challengeBlockBtn');
    el.classList.remove('hidden');

    el.querySelector('#cwAcceptBtn').addEventListener('click', async () => {
      const challengeId = incoming.challengeId;
      try {
        await api('POST', '/api/challenge/respond', { challengeId, accept: true });
        // Kabul edilince sunucu 'match_found' gönderecek -- aşağıdaki
        // dinleyici (connectSse) yönlendirmeyi yapacak.
      } catch (err) { alert(I18N.tErr(err)); }
      incoming = null;
      render();
    });
    el.querySelector('#cwDeclineBtn').addEventListener('click', async () => {
      try { await api('POST', '/api/challenge/respond', { challengeId: incoming.challengeId, accept: false }); } catch { /* önemli değil */ }
      incoming = null;
      render();
    });
    el.querySelector('#cwBlockBtn').addEventListener('click', async () => {
      const username = incoming.fromUsername;
      const challengeId = incoming.challengeId;
      if (!confirm(I18N.t('lobby.blockConfirm', { username }))) return;
      try {
        await api('POST', '/api/block/add', { username });
        // Engelleme, bekleyen daveti otomatik geçersiz kılmıyor -- ayrıca
        // reddedelim ki teklif sahibi de bilgilensin (bkz. app.js'teki
        // #challengeDeclineBtn ile aynı mantık).
        try { await api('POST', '/api/challenge/respond', { challengeId, accept: false }); } catch { /* önemli değil */ }
        alert(I18N.t('lobby.blockSuccess', { username }));
      } catch (err) { alert(I18N.tErr(err)); }
      incoming = null;
      render();
    });
  }

  async function loadTimeControls() {
    try {
      const { timeControls: tcs } = await api('GET', '/api/time-controls');
      timeControls = tcs;
    } catch { /* önemli değil -- bulunamazsa ham anahtar (ör. "5+8") gösterilir */ }
  }

  function connectSse() {
    const sse = new EventSource('/events');
    sse.addEventListener('challenge_received', (e) => {
      const data = JSON.parse(e.data);
      incoming = {
        challengeId: data.challengeId,
        fromUsername: data.fromUsername,
        timeControlKey: data.timeControlKey,
        colorForTarget: data.colorForTarget,
        ranked: data.ranked,
      };
      render();
    });
    sse.addEventListener('challenge_cancelled', (e) => {
      const data = JSON.parse(e.data);
      if (incoming && incoming.challengeId === data.challengeId) { incoming = null; render(); }
    });
    // Kabul edilen bir meydan okuma (bu widget'tan ya da başka bir sekmeden/
    // sayfadan kabul edilmiş olabilir) her zaman 'match_found' ile sonuçlanır
    // -- burada da dinleyip yeni oyunun sayfasına geçiyoruz.
    sse.addEventListener('match_found', (e) => {
      const data = JSON.parse(e.data);
      window.location.href = '/game.html?id=' + data.gameId;
    });
    sse.onerror = () => { /* tarayıcı otomatik olarak yeniden bağlanmayı dener */ };
    window.addEventListener('beforeunload', () => sse.close());
  }

  window.addEventListener('langchange', () => render());

  (async function initWidget() {
    await loadTimeControls();
    connectSse();
  })();
})();
