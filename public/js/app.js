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
    resetChallengeState();
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
    renderChallengeTimeControls();
    const list = $('tcList');
    list.innerHTML = '';
    // Bu fonksiyon dil değişince (langchange) de tekrar çağrılıyor (etiketleri
    // yeni dilde yeniden çizmek için) -- ESKİDEN her çağrıda seçimi körü
    // körüne ilk seçeneğe sıfırlıyordu; bu da (örn.) kuyrukta beklerken dil
    // değiştirilirse gerçek seçimin/kuyruk kaydının GÖRSEL olarak kaybolmasına
    // yol açardı. Artık halihazırdaki seçim hâlâ listede varsa onu koruyoruz.
    const activeKey = (selectedTc && tcs.some(tc => tc.key === selectedTc)) ? selectedTc : (tcs.length ? tcs[0].key : null);
    tcs.forEach((tc) => {
      const div = document.createElement('div');
      div.className = 'tc-option' + (tc.key === activeKey ? ' selected' : '');
      div.dataset.key = tc.key;
      div.innerHTML = `<span class="label">${formatTimeControlLabel(tc)}</span><span class="tc-rating">${ratingFor(tc.category)}</span>`;
      div.addEventListener('click', async () => {
        // ÖNEMLİ (bir kullanıcı raporuyla bulunan hata): kuyrukta beklerken
        // (inQueue) bu liste hâlâ tıklanabilir kalıyor -- ama "Oyun Bul"
        // düğmesi gizli olduğu için, ESKİDEN sadece görsel seçim değişiyor,
        // selectedTc güncelleniyor ama SUNUCUYA hiç haber verilmiyordu. Bu
        // yüzden biri kuyrukta beklerken başka bir süre kontrolüne tıklayınca
        // ekranda o seçiliymiş gibi görünse de GERÇEKTE hâlâ İLK seçtiği
        // süre kontrolünün kuyruğunda bekliyordu. Artık kuyruktayken
        // tıklanınca, iptal etmeye gerek kalmadan sunucudaki kuyruk kaydı da
        // (server.js: gameManager.joinQueue zaten kullanıcıyı önce TÜM
        // kuyruklardan siliyor) hemen yeni seçime göre güncelleniyor.
        if (inQueue) {
          if (tc.key === selectedTc) return; // zaten bu süre kontrolüyle aranıyor
          const previousKey = selectedTc;
          document.querySelectorAll('.tc-option').forEach(el => el.classList.toggle('selected', el.dataset.key === tc.key));
          try {
            await api('POST', '/api/queue/join', { timeControlKey: tc.key });
            selectedTc = tc.key;
          } catch (err) {
            // Değişiklik başarısız oldu (ör. bu arada bir oyun başlamış
            // olabilir) -- görünümü GERÇEK (eski) seçime geri al.
            document.querySelectorAll('.tc-option').forEach(el => el.classList.toggle('selected', el.dataset.key === previousKey));
            alert(I18N.tErr(err));
          }
          return;
        }
        document.querySelectorAll('.tc-option').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
        selectedTc = tc.key;
      });
      list.appendChild(div);
    });
    selectedTc = activeKey;
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

  // ---------------- Doğrudan meydan okuma (belirli bir oyuncuya davet) ----------------
  // Kullanıcı isteği: rakip LİSTEDEN değil, kullanıcı adı YAZARAK aranıyor;
  // sadece o an SİTEDE (çevrimiçi) olan oyuncular meydan okunabilir (bu
  // kontrol sunucu tarafında gameManager.createChallenge içinde yapılıyor —
  // burada sadece sunucunun döndürdüğü hatayı gösteriyoruz).
  let outgoingChallenge = null; // { challengeId, targetUsername }
  let incomingChallenge = null; // { challengeId, fromUsername, timeControlKey, colorForTarget }

  function renderChallengeTimeControls() {
    const sel = $('challengeTc');
    if (!sel) return;
    const prevValue = sel.value;
    sel.innerHTML = timeControls.map(tc => `<option value="${tc.key}">${formatTimeControlLabel(tc)}</option>`).join('');
    if (prevValue && timeControls.some(tc => tc.key === prevValue)) sel.value = prevValue;
  }

  function renderOutgoingChallenge() {
    if (outgoingChallenge) {
      $('challengeForm').classList.add('hidden');
      $('challengeOutgoing').classList.remove('hidden');
      $('challengeOutgoingText').textContent = I18N.t('lobby.challengePendingOutgoing', { username: outgoingChallenge.targetUsername });
    } else {
      $('challengeForm').classList.remove('hidden');
      $('challengeOutgoing').classList.add('hidden');
    }
  }

  function colorLabel(c) {
    if (c === 'white') return I18N.t('common.white');
    if (c === 'black') return I18N.t('common.black');
    return I18N.t('common.random');
  }

  function renderIncomingChallenge() {
    const box = $('challengeIncoming');
    if (!incomingChallenge) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const tc = timeControls.find(t => t.key === incomingChallenge.timeControlKey);
    const tcLabel = tc ? formatTimeControlLabel(tc) : incomingChallenge.timeControlKey;
    $('challengeIncomingText').textContent = I18N.t('lobby.challengeIncomingText', {
      username: incomingChallenge.fromUsername,
      timeControl: tcLabel,
      color: colorLabel(incomingChallenge.colorForTarget),
    });
  }

  function resetChallengeState() {
    outgoingChallenge = null;
    incomingChallenge = null;
    renderOutgoingChallenge();
    renderIncomingChallenge();
    $('challengeError').textContent = '';
    $('challengeForm').reset();
  }

  $('challengeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('challengeUsername').value.trim();
    if (!username) return;
    const colorInput = document.querySelector('input[name="challengeColor"]:checked');
    const color = colorInput ? colorInput.value : 'random';
    const timeControlKey = $('challengeTc').value;
    $('challengeError').textContent = '';
    $('challengeSendBtn').disabled = true;
    try {
      const res = await api('POST', '/api/challenge/send', { username, timeControlKey, color });
      outgoingChallenge = { challengeId: res.challengeId, targetUsername: username };
      renderOutgoingChallenge();
    } catch (err) {
      $('challengeError').textContent = I18N.tErr(err);
    } finally {
      $('challengeSendBtn').disabled = false;
    }
  });

  $('challengeCancelBtn').addEventListener('click', async () => {
    if (!outgoingChallenge) return;
    try { await api('POST', '/api/challenge/cancel', { challengeId: outgoingChallenge.challengeId }); } catch { /* zaten geçersizse önemli değil */ }
    outgoingChallenge = null;
    renderOutgoingChallenge();
  });

  $('challengeAcceptBtn').addEventListener('click', async () => {
    if (!incomingChallenge) return;
    const challengeId = incomingChallenge.challengeId;
    try {
      await api('POST', '/api/challenge/respond', { challengeId, accept: true });
      // Kabul başarılıysa sunucu her iki tarafa da 'match_found' gönderiyor
      // (aşağıdaki connectSse() içindeki dinleyici zaten yönlendirmeyi yapar).
    } catch (err) {
      alert(I18N.tErr(err));
    }
    incomingChallenge = null;
    renderIncomingChallenge();
  });

  $('challengeDeclineBtn').addEventListener('click', async () => {
    if (!incomingChallenge) return;
    try { await api('POST', '/api/challenge/respond', { challengeId: incomingChallenge.challengeId, accept: false }); } catch { /* önemli değil */ }
    incomingChallenge = null;
    renderIncomingChallenge();
  });

  function connectSse() {
    if (sse) sse.close();
    sse = new EventSource('/events');
    sse.addEventListener('match_found', (e) => {
      const data = JSON.parse(e.data);
      window.location.href = '/game.html?id=' + data.gameId;
    });
    sse.addEventListener('challenge_received', (e) => {
      const data = JSON.parse(e.data);
      incomingChallenge = {
        challengeId: data.challengeId,
        fromUsername: data.fromUsername,
        timeControlKey: data.timeControlKey,
        colorForTarget: data.colorForTarget,
      };
      renderIncomingChallenge();
    });
    sse.addEventListener('challenge_declined', (e) => {
      const data = JSON.parse(e.data);
      if (outgoingChallenge && outgoingChallenge.challengeId === data.challengeId) {
        const username = outgoingChallenge.targetUsername;
        outgoingChallenge = null;
        renderOutgoingChallenge();
        alert(I18N.t('lobby.challengeDeclinedByTarget', { username }));
      }
    });
    sse.addEventListener('challenge_cancelled', (e) => {
      const data = JSON.parse(e.data);
      if (incomingChallenge && incomingChallenge.challengeId === data.challengeId) {
        incomingChallenge = null;
        renderIncomingChallenge();
      }
    });
    sse.addEventListener('challenge_expired', (e) => {
      const data = JSON.parse(e.data);
      if (outgoingChallenge && outgoingChallenge.challengeId === data.challengeId) {
        const username = outgoingChallenge.targetUsername;
        outgoingChallenge = null;
        renderOutgoingChallenge();
        alert(I18N.t('lobby.challengeExpiredOutgoing', { username }));
      }
      if (incomingChallenge && incomingChallenge.challengeId === data.challengeId) {
        incomingChallenge = null;
        renderIncomingChallenge();
      }
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
    resetChallengeState();
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
      renderOutgoingChallenge();
      renderIncomingChallenge();
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
