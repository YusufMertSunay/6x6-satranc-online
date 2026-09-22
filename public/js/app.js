// public/js/app.js — lobi mantığı: giriş/kayıt, eşleştirme kuyruğu,
// liderlik tablosu, son oyunlar. Gerçek zamanlı "eşleşme bulundu" bildirimi
// Server-Sent Events (SSE) üzerinden /events uç noktasından geliyor.

(function () {
  let currentUser = null; // { id, username, rating, ... }
  let authMode = 'login'; // 'login' | 'register'
  let sse = null;
  let queueDotsTimer = null;

  const $ = (id) => document.getElementById(id);

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

  // ---------------- Kimlik doğrulama ----------------

  function setAuthMode(mode) {
    authMode = mode;
    $('tabLogin').classList.toggle('active', mode === 'login');
    $('tabRegister').classList.toggle('active', mode === 'register');
    $('authTitle').textContent = mode === 'login' ? I18N.t('auth.login') : I18N.t('auth.register');
    $('authSubmit').textContent = mode === 'login' ? I18N.t('auth.login') : I18N.t('auth.register');
    $('authError').textContent = '';
  }

  $('tabLogin').addEventListener('click', () => setAuthMode('login'));
  $('tabRegister').addEventListener('click', () => setAuthMode('register'));

  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('authUsername').value.trim();
    const password = $('authPassword').value;
    $('authError').textContent = '';
    $('authSubmit').disabled = true;
    try {
      const user = await api('POST', authMode === 'login' ? '/api/login' : '/api/register', { username, password });
      currentUser = user;
      I18N.syncFromAccount(user.language);
      await enterLobby();
    } catch (err) {
      $('authError').textContent = I18N.tErr(err);
    } finally {
      $('authSubmit').disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch { }
    if (sse) sse.close();
    currentUser = null;
    $('userBadge').classList.add('hidden');
    $('lobbyView').classList.add('hidden');
    $('authView').classList.remove('hidden');
    $('authUsername').value = '';
    $('authPassword').value = '';
  });

  // ---------------- Lobi ----------------

  let timeControls = [];
  let selectedTc = null;
  let inQueue = false;
  let leaderboardCategory = 'bullet';

  // Elo puanı artık TEK bir sayı değil, süre kontrolü kategorisine göre
  // (bullet/blitz/rapid/classical) AYRI tutuluyor — her biri 1500'den
  // başlıyor. Her kategori zaten kendi satırında gösterildiği için üstte
  // (profil adının yanında) AYRICA tek bir puan göstermiyoruz — kullanıcı
  // "hangi puanıma bakıyorum" diye kafası karışmasın diye kaldırıldı.
  function ratingFor(category) {
    return (currentUser && currentUser.ratings && currentUser.ratings[category]) ?? 1500;
  }

  // Sunucudan gelen "label" alanı (ör. "3 dk | +2 sn (Blitz)") HÂLÂ Türkçe
  // metin -- dil değişince yeniden çevrilebilsin diye onu KULLANMIYORUZ,
  // bunun yerine "key" (ör. "3+2" = 3 dakika + 2 saniye artış) ve
  // "category" alanlarından etiketi kendimiz, o anki arayüz dilinde
  // üretiyoruz (bkz. lib/gameManager.js: TIME_CONTROLS -- key formatı her
  // zaman "dakika+artışSaniyesi").
  function formatTimeControlLabel(tc) {
    const [minutes, incSeconds] = tc.key.split('+').map(Number);
    let label = I18N.t('tc.minutesShort', { m: minutes });
    if (incSeconds > 0) label += I18N.t('tc.incrementShort', { s: incSeconds });
    label += ' (' + I18N.t('cat.' + tc.category) + ')';
    return label;
  }

  async function loadTimeControls() {
    const { timeControls: tcs } = await api('GET', '/api/time-controls');
    timeControls = tcs;
    const list = $('tcList');
    list.innerHTML = '';
    tcs.forEach((tc, i) => {
      const div = document.createElement('div');
      div.className = 'tc-option' + (i === 0 ? ' selected' : '');
      div.dataset.key = tc.key;
      div.innerHTML = `<span class="label">${formatTimeControlLabel(tc)}</span><span class="tc-rating">${ratingFor(tc.category)}</span>`;
      div.addEventListener('click', () => {
        document.querySelectorAll('.tc-option').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
        selectedTc = tc.key;
      });
      list.appendChild(div);
    });
    if (tcs.length) selectedTc = tcs[0].key;
  }

  async function loadLeaderboard(category) {
    if (category) leaderboardCategory = category;
    const { leaderboard } = await api('GET', '/api/leaderboard?category=' + leaderboardCategory);
    const body = $('leaderboardBody');
    body.innerHTML = '';
    leaderboard.forEach((u, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(u.username)}</td><td>${u.rating}</td><td>${u.wins}/${u.losses}/${u.draws}</td>`;
      body.appendChild(tr);
    });
  }

  $('leaderboardTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-category]');
    if (!btn) return;
    document.querySelectorAll('#leaderboardTabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadLeaderboard(btn.dataset.category);
  });

  async function loadMyGames() {
    const { games } = await api('GET', '/api/my-games');
    const list = $('myGamesList');
    list.innerHTML = '';
    if (!games.length) {
      list.innerHTML = `<li class="hint-text">${I18N.t('lobby.noGamesYet')}</li>`;
      return;
    }
    games.slice(0, 10).forEach(g => {
      const li = document.createElement('li');
      const meWhite = g.whiteId === currentUser.id;
      const oppName = meWhite ? g.blackUsername : g.whiteUsername;
      const resultText = describeResult(g, meWhite);
      li.innerHTML = `<span>vs ${escapeHtml(oppName || '?')} (${escapeHtml(g.timeControlKey)})</span><span>${resultText}</span>`;
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => { window.location.href = '/game.html?id=' + g.id; });
      list.appendChild(li);
    });
  }

  function describeResult(g, meWhite) {
    if (g.winnerColor === null) return I18N.t('result.draw');
    const iWon = (g.winnerColor === 'white' && meWhite) || (g.winnerColor === 'black' && !meWhite);
    return iWon ? I18N.t('result.won') : I18N.t('result.lost');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function checkActiveGame() {
    const { gameId } = await api('GET', '/api/my-active-game');
    if (gameId) {
      $('activeGameBanner').classList.remove('hidden');
      $('resumeGameBtn').onclick = () => { window.location.href = '/game.html?id=' + gameId; };
    } else {
      $('activeGameBanner').classList.add('hidden');
    }
    return gameId;
  }

  $('findMatchBtn').addEventListener('click', async () => {
    if (!selectedTc || inQueue) return;
    try {
      await api('POST', '/api/queue/join', { timeControlKey: selectedTc });
      inQueue = true;
      $('findMatchBtn').classList.add('hidden');
      $('queueStatus').classList.remove('hidden');
      let dots = 0;
      queueDotsTimer = setInterval(() => {
        dots = (dots + 1) % 4;
        $('queueDots').textContent = '.'.repeat(dots);
      }, 500);
    } catch (err) {
      alert(I18N.tErr(err));
    }
  });

  $('cancelQueueBtn').addEventListener('click', async () => {
    try { await api('POST', '/api/queue/leave'); } catch { }
    inQueue = false;
    clearInterval(queueDotsTimer);
    $('findMatchBtn').classList.remove('hidden');
    $('queueStatus').classList.add('hidden');
  });

  function connectSse() {
    if (sse) sse.close();
    sse = new EventSource('/events');
    sse.addEventListener('match_found', (e) => {
      const data = JSON.parse(e.data);
      window.location.href = '/game.html?id=' + data.gameId;
    });
    sse.onerror = () => { /* tarayıcı otomatik olarak yeniden bağlanmayı dener */ };
  }

  async function enterLobby() {
    $('authView').classList.add('hidden');
    $('lobbyView').classList.remove('hidden');
    $('userBadge').classList.remove('hidden');
    $('userName').textContent = currentUser.username;
    // Puan rozeti loadTimeControls() içinde, ilk (varsayılan seçili) süre
    // kontrolünün kategorisine göre dolduruluyor.
    connectSse();
    await Promise.all([loadTimeControls(), loadLeaderboard(), loadMyGames()]);
    const activeGameId = await checkActiveGame();
    if (activeGameId) {
      // Devam eden bir oyun varsa doğrudan oraya yönlendirelim.
      window.location.href = '/game.html?id=' + activeGameId;
    }
  }

  // ---------------- Dil değişince görünen ekranı yeniden çiz ----------------
  // Statik metinler zaten I18N.applyStaticTranslations() ile güncelleniyor
  // (bkz. i18n.js: setLang) -- burada sadece JS'in DİNAMİK olarak ürettiği
  // (sunucudan gelen veriyle doldurulan) kısımları yeniden çiziyoruz.
  document.title = I18N.t('title.lobby');
  window.addEventListener('langchange', () => {
    document.title = I18N.t('title.lobby');
    if (!$('authView').classList.contains('hidden')) setAuthMode(authMode);
    if (!$('lobbyView').classList.contains('hidden')) {
      loadTimeControls();
      loadLeaderboard();
      loadMyGames();
    }
  });

  // ---------------- Başlangıç: oturum var mı kontrol et ----------------
  (async function init() {
    try {
      const me = await api('GET', '/api/me');
      currentUser = me;
      I18N.syncFromAccount(me.language);
      await enterLobby();
    } catch {
      $('authView').classList.remove('hidden');
    }
  })();
})();
