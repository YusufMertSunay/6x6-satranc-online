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

  // ---- Liderlik tablosu / son oyunlar sayfalama (kullanıcı isteği) ----
  // Her ikisi de sonsuza kadar büyümesin diye artık sunucudan HER ZAMAN en
  // fazla PAGE_SIZE kadar satır isteniyor (bkz. server.js: /api/leaderboard,
  // /api/my-games). "offset" gönderilmezse sunucu akıllı bir varsayılan
  // seçiyor (liderlik tablosunda kullanıcının kendi sırasını içeren dilim,
  // son oyunlarda ise en yeni oyunlar); "leaderboardOffset"/"myGamesOffset"
  // burada `null` iken bu varsayılanı kullanıyoruz, bir sayı olduğunda ise
  // (düğmelerden biri tıklandığında) TAM O sayfayı istiyoruz.
  const PAGE_SIZE = 10;
  let leaderboardOffset = null;
  let leaderboardTotal = 0;
  let myGamesOffset = null;
  let myGamesTotal = 0;

  // ---- Oyuncu profili (kullanıcı isteği) ----
  // "Oyuncu Ara" formundan ya da herhangi bir liderlik tablosundaki
  // kullanıcı adına tıklanınca açılan pencerenin kendi (bağımsız) sayfalama
  // durumu -- ana liderlik tablosu/son oyunlar ile KARIŞMASIN diye ayrı
  // değişkenlerde tutuluyor (aynı /api/leaderboard, /api/my-games uçları
  // bu kez ?username= parametresiyle çağrılıyor, bkz. aşağısı).
  let profileUsername = null; // pencere açıkken incelenen oyuncu, kapalıyken null
  let profileLbCategory = 'bullet';
  let profileLbOffset = null;
  let profileLbTotal = 0;
  let profileGamesOffset = null;
  let profileGamesTotal = 0;

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
  // Kullanıcı isteği: "5+8" süre kontrolünün yanında "(Geliştiricinin
  // Tavsiyesi)" notu görünsün -- bu not hem hızlı eşleştirme listesinde
  // (#tcList) hem de özel eşleştirme (doğrudan meydan okuma) açılır
  // menüsünde çıkıyor, çünkü ikisi de aynı formatTimeControlLabel
  // fonksiyonunu kullanıyor (bkz. renderChallengeTimeControls).
  const DEVELOPER_PICK_TC_KEY = '5+8';

  function formatTimeControlLabel(tc) {
    const [minutes, incSeconds] = tc.key.split('+').map(Number);
    let label = I18N.t('tc.minutesShort', { m: minutes });
    if (incSeconds > 0) label += I18N.t('tc.incrementShort', { s: incSeconds });
    label += ' (' + I18N.t('cat.' + tc.category) + ')';
    if (tc.key === DEVELOPER_PICK_TC_KEY) label += I18N.t('tc.developerPick');
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
            alert(I18N.describeOfferError(err));
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

  // Liderlik tablosu satırını oluşturur -- hem ana lobi tablosunda hem de
  // oyuncu profili penceresindeki mini tabloda AYNEN kullanılıyor (kullanıcı
  // isteği: birinin üzerine tıklayınca onun profili açılsın -- bu davranış
  // HER İKİ tabloda da geçerli, profildeki tablodan da başka birine
  // atlanabilir). highlightUsername verilirse (profil penceresinde,
  // incelenen oyuncuyu diğerlerinden ayırt etmek için) o satır vurgulanır.
  function buildLeaderboardRow(u, highlightUsername) {
    const tr = document.createElement('tr');
    if (highlightUsername && u.username.toLowerCase() === highlightUsername.toLowerCase()) {
      tr.className = 'highlighted-row';
    }
    const tdRank = document.createElement('td');
    tdRank.textContent = u.rank;
    const tdUser = document.createElement('td');
    tdUser.textContent = u.username;
    tdUser.className = 'username-cell';
    tdUser.title = I18N.t('lobby.playerSearchTitle');
    tdUser.addEventListener('click', () => openPlayerProfile(u.username));
    const tdRating = document.createElement('td');
    tdRating.textContent = u.rating;
    const tdRecord = document.createElement('td');
    tdRecord.textContent = `${u.wins}/${u.losses}/${u.draws}`;
    tr.appendChild(tdRank);
    tr.appendChild(tdUser);
    tr.appendChild(tdRating);
    tr.appendChild(tdRecord);
    return tr;
  }

  // offset === null  -> sunucudan varsayılan (kullanıcının kendi sırasını
  //                     içeren) dilimi iste.
  // offset === sayı  -> TAM o dilimi iste (düğmelerden biri tıklandığında).
  async function loadLeaderboard(category, offset) {
    if (category) { leaderboardCategory = category; leaderboardOffset = null; }
    else if (offset !== undefined) leaderboardOffset = offset;
    let path = '/api/leaderboard?category=' + leaderboardCategory + '&limit=' + PAGE_SIZE;
    if (leaderboardOffset !== null) path += '&offset=' + leaderboardOffset;
    const data = await api('GET', path);
    // Sunucu, gönderdiğimiz offset'i sınırlara göre düzeltmiş (clamp etmiş)
    // olabilir (ör. çok büyük bir offset istendiğinde) -- gerçek değeri
    // kendisinden alıp burada senkron tutuyoruz ki düğmelerin
    // aktif/pasif durumu ve "31-40 / 214" metni hep DOĞRU sayfayı yansıtsın.
    leaderboardOffset = data.offset;
    leaderboardTotal = data.total;
    const body = $('leaderboardBody');
    body.innerHTML = '';
    data.leaderboard.forEach((u) => body.appendChild(buildLeaderboardRow(u)));
    renderLeaderboardPagination();
  }

  function renderLeaderboardPagination() {
    const total = leaderboardTotal;
    const offset = leaderboardOffset;
    const lastOffset = total > PAGE_SIZE ? total - PAGE_SIZE : 0;
    const start = total === 0 ? 0 : offset + 1;
    const end = Math.min(offset + PAGE_SIZE, total);
    $('lbRangeText').textContent = total === 0 ? I18N.t('lobby.paginationEmpty') : I18N.t('lobby.paginationRange', { start, end, total });
    $('lbFirstBtn').disabled = offset <= 0;
    $('lbUpBtn').disabled = offset <= 0;
    $('lbDownBtn').disabled = offset >= lastOffset;
    $('lbLastBtn').disabled = offset >= lastOffset;
  }

  $('leaderboardTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-category]');
    if (!btn) return;
    document.querySelectorAll('#leaderboardTabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadLeaderboard(btn.dataset.category);
  });

  $('lbFirstBtn').addEventListener('click', () => loadLeaderboard(null, 0));
  $('lbUpBtn').addEventListener('click', () => loadLeaderboard(null, Math.max(0, leaderboardOffset - PAGE_SIZE)));
  $('lbDownBtn').addEventListener('click', () => {
    const lastOffset = leaderboardTotal > PAGE_SIZE ? leaderboardTotal - PAGE_SIZE : 0;
    loadLeaderboard(null, Math.min(lastOffset, leaderboardOffset + PAGE_SIZE));
  });
  $('lbLastBtn').addEventListener('click', () => {
    const lastOffset = leaderboardTotal > PAGE_SIZE ? leaderboardTotal - PAGE_SIZE : 0;
    loadLeaderboard(null, lastOffset);
  });

  // offset === undefined -> mevcut sayfayı (veya hiç yüklenmediyse
  //                          varsayılan/en yeni 10 oyunu) yeniden çiz.
  // offset === sayı       -> TAM o dilimi iste (düğmelerden biri tıklandığında).
  async function loadMyGames(offset) {
    if (offset !== undefined) myGamesOffset = offset;
    // Oyun geçmişindeki rakiplerin hangilerinin ZATEN engellenmiş olduğunu
    // bilmemiz gerekiyor -- engellenmiş bir rakibin yanında tekrar "Engelle"
    // düğmesi göstermiyoruz (bkz. aşağısı). /api/block/list ucuz bir çağrı
    // olduğu için burada ayrıca (loadBlockedList'ten bağımsız) çekiyoruz --
    // böylece bu iki fonksiyonun çağrılma sırası önemli olmuyor.
    let path = '/api/my-games?limit=' + PAGE_SIZE;
    if (myGamesOffset !== null && myGamesOffset !== undefined) path += '&offset=' + myGamesOffset;
    const [data, { usernames: blockedUsernames }] = await Promise.all([
      api('GET', path),
      api('GET', '/api/block/list'),
    ]);
    const games = data.games;
    myGamesOffset = data.offset;
    myGamesTotal = data.total;
    const blockedSet = new Set(blockedUsernames);
    const list = $('myGamesList');
    list.innerHTML = '';
    if (!games.length) {
      list.innerHTML = `<li class="hint-text">${I18N.t('lobby.noGamesYet')}</li>`;
      renderMyGamesPagination();
      return;
    }
    games.forEach(g => {
      const li = document.createElement('li');
      const meWhite = g.whiteId === currentUser.id;
      const oppName = meWhite ? g.blackUsername : g.whiteUsername;
      const resultText = describeResult(g, meWhite);

      const left = document.createElement('span');
      left.textContent = `vs ${oppName || '?'} (${g.timeControlKey})`;

      const right = document.createElement('span');
      right.className = 'game-history-right';
      const resultSpan = document.createElement('span');
      resultSpan.textContent = resultText;
      right.appendChild(resultSpan);

      // Kullanıcı isteği: rakibi kullanıcı adını TEK TEK YAZMADAN, oyun
      // geçmişinden tek bir düğmeyle engelleyebilsin (manuel yazma seçeneği
      // -- aşağıdaki #blockForm -- de aynen duruyor). Rakip zaten
      // engellenmişse veya bilinmiyorsa düğmeyi hiç göstermiyoruz.
      if (oppName && !blockedSet.has(oppName)) {
        const blockBtn = document.createElement('button');
        blockBtn.type = 'button';
        blockBtn.className = 'secondary tiny';
        blockBtn.textContent = I18N.t('lobby.blockButton');
        blockBtn.title = I18N.t('lobby.blockFromHistoryTitle');
        blockBtn.addEventListener('click', async (e) => {
          e.stopPropagation(); // satırın kendi tıklama olayı (oyuna git) tetiklenmesin
          if (!confirm(I18N.t('lobby.blockConfirm', { username: oppName }))) return;
          try {
            const res = await blockUserRequest(oppName);
            alert(I18N.t('lobby.blockSuccess', { username: res.username }));
          } catch (err) {
            alert(I18N.tErr(err));
          }
        });
        right.appendChild(blockBtn);
      }

      li.appendChild(left);
      li.appendChild(right);
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => { window.location.href = '/game.html?id=' + g.id; });
      list.appendChild(li);
    });
    renderMyGamesPagination();
  }

  // Oyunlar en yeniden en eskiye sıralı geldiği için (bkz. store.js:
  // recentGamesForUser) offset=0 HER ZAMAN "en son oyunlar", en büyük offset
  // ise "en eski oyunlar" demek -- yani "İlk Oyunlar" (en eski) düğmesi
  // BÜYÜK offset'e, "Son Oyunlar" (en yeni) düğmesi offset=0'a gider ve
  // "Daha Eski" ileri (+PAGE_SIZE), "Daha Yeni" ise geri (-PAGE_SIZE) sarar.
  function renderMyGamesPagination() {
    const total = myGamesTotal;
    const offset = myGamesOffset;
    const lastOffset = total > PAGE_SIZE ? total - PAGE_SIZE : 0;
    const start = total === 0 ? 0 : offset + 1;
    const end = Math.min(offset + PAGE_SIZE, total);
    $('gamesRangeText').textContent = total === 0 ? I18N.t('lobby.paginationEmpty') : I18N.t('lobby.paginationRange', { start, end, total });
    $('gamesLastBtn').disabled = offset <= 0;
    $('gamesNewerBtn').disabled = offset <= 0;
    $('gamesOlderBtn').disabled = offset >= lastOffset;
    $('gamesFirstBtn').disabled = offset >= lastOffset;
  }

  $('gamesLastBtn').addEventListener('click', () => loadMyGames(0));
  $('gamesNewerBtn').addEventListener('click', () => loadMyGames(Math.max(0, myGamesOffset - PAGE_SIZE)));
  $('gamesOlderBtn').addEventListener('click', () => {
    const lastOffset = myGamesTotal > PAGE_SIZE ? myGamesTotal - PAGE_SIZE : 0;
    loadMyGames(Math.min(lastOffset, myGamesOffset + PAGE_SIZE));
  });
  $('gamesFirstBtn').addEventListener('click', () => {
    const lastOffset = myGamesTotal > PAGE_SIZE ? myGamesTotal - PAGE_SIZE : 0;
    loadMyGames(lastOffset);
  });

  function describeResult(g, meWhite) {
    if (g.winnerColor === null) return I18N.t('result.draw');
    const iWon = (g.winnerColor === 'white' && meWhite) || (g.winnerColor === 'black' && !meWhite);
    return iWon ? I18N.t('result.won') : I18N.t('result.lost');
  }

  // describeResult ile aynı mantık ama BAŞKA bir oyuncunun profilinde
  // gösterildiği için 2. şahıs ("Kazandın/Kaybettin") yerine 3. şahıs
  // ("Kazandı/Kaybetti") kullanıyor -- kullanıcı isteği: oyuncu profili.
  function describeResultThirdPerson(g, targetWhite) {
    if (g.winnerColor === null) return I18N.t('result.draw');
    const targetWon = (g.winnerColor === 'white' && targetWhite) || (g.winnerColor === 'black' && !targetWhite);
    return targetWon ? I18N.t('result.wonThirdPerson') : I18N.t('result.lostThirdPerson');
  }

  // ---------------- Oyuncu profili penceresi (kullanıcı isteği) ----------------
  // Bir oyuncuyu isimle arayınca (#playerSearchForm) ya da HERHANGİ bir
  // liderlik tablosundaki (ana lobi ya da bu pencerenin kendi mini
  // tablosu) kullanıcı adına tıklanınca açılır. Üç şeyi gösterir: o an
  // canlı bir oyunu varsa seyirci olarak izleme seçeneği, oyun geçmişi ve
  // liderlik tablosundaki (kendi sırasını içeren) yeri -- üçü de zaten var
  // olan uçların (varsa ?username= ile) yeniden kullanılmasıyla elde ediliyor.
  // onError verilmezse (ör. liderlik tablosundaki bir satıra tıklanınca --
  // orada hatayı göstermek için doğal bir yer yok) hata basit bir uyarı
  // penceresiyle gösterilir. #playerSearchForm'un submit dinleyicisi kendi
  // onError'ını (hatayı formun altında göstermek için) veriyor.
  async function openPlayerProfile(username, onError) {
    try {
      const info = await api('GET', '/api/player-info?username=' + encodeURIComponent(username));
      profileUsername = info.username; // sunucudaki GERÇEK (büyük/küçük harfi doğru) kullanıcı adı
      profileLbCategory = 'bullet';
      profileLbOffset = null;
      profileGamesOffset = null;
      renderProfileHeader(info);
      document.querySelectorAll('#profileLbTabs button').forEach(b => b.classList.toggle('active', b.dataset.category === 'bullet'));
      $('playerProfileModal').classList.remove('hidden');
      await Promise.all([loadProfileLeaderboard(), loadProfileGames()]);
    } catch (err) {
      if (onError) onError(err);
      else alert(I18N.tErr(err));
    }
  }

  function closePlayerProfile() {
    $('playerProfileModal').classList.add('hidden');
    profileUsername = null;
  }

  $('profileCloseBtn').addEventListener('click', closePlayerProfile);
  // Karartılmış arka plana (overlay'in kendisine) tıklanınca da kapansın --
  // ama pencerenin İÇİNE (kart) tıklanınca kapanmasın diye hedefi kontrol
  // ediyoruz (aynı desen: promotionModal zaten böyle bir davranışa sahip
  // değil ama bu genel bir modal-overlay iyileştirmesi, zararsız).
  $('playerProfileModal').addEventListener('click', (e) => {
    if (e.target === $('playerProfileModal')) closePlayerProfile();
  });

  function renderProfileHeader(info) {
    $('profileUsername').textContent = info.username;
    $('profileRecordLine').textContent = `${info.wins}/${info.losses}/${info.draws}`;
    const banner = $('profileActiveGameBanner');
    if (info.activeGameId) {
      banner.classList.remove('hidden');
      $('profileWatchBtn').onclick = () => { window.location.href = '/game.html?id=' + info.activeGameId; };
    } else {
      banner.classList.add('hidden');
    }
  }

  $('playerSearchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('playerSearchUsername').value.trim();
    if (!username) return;
    $('playerSearchError').textContent = '';
    $('playerSearchBtn').disabled = true;
    try {
      await openPlayerProfile(username, (err) => { $('playerSearchError').textContent = I18N.tErr(err); });
    } finally {
      $('playerSearchBtn').disabled = false;
    }
  });

  // ---- Profil penceresi: mini liderlik tablosu (ana tablo ile aynı mantık,
  // ama HER ZAMAN incelenen oyuncuya göre -- ?username= ile) ----
  async function loadProfileLeaderboard(category, offset) {
    if (category) { profileLbCategory = category; profileLbOffset = null; }
    else if (offset !== undefined) profileLbOffset = offset;
    let path = '/api/leaderboard?category=' + profileLbCategory + '&limit=' + PAGE_SIZE + '&username=' + encodeURIComponent(profileUsername);
    if (profileLbOffset !== null) path += '&offset=' + profileLbOffset;
    const data = await api('GET', path);
    profileLbOffset = data.offset;
    profileLbTotal = data.total;
    const body = $('profileLbBody');
    body.innerHTML = '';
    data.leaderboard.forEach((u) => body.appendChild(buildLeaderboardRow(u, profileUsername)));
    renderProfileLbPagination();
  }

  function renderProfileLbPagination() {
    const total = profileLbTotal;
    const offset = profileLbOffset;
    const lastOffset = total > PAGE_SIZE ? total - PAGE_SIZE : 0;
    const start = total === 0 ? 0 : offset + 1;
    const end = Math.min(offset + PAGE_SIZE, total);
    $('profileLbRangeText').textContent = total === 0 ? I18N.t('lobby.paginationEmpty') : I18N.t('lobby.paginationRange', { start, end, total });
    $('profileLbFirstBtn').disabled = offset <= 0;
    $('profileLbUpBtn').disabled = offset <= 0;
    $('profileLbDownBtn').disabled = offset >= lastOffset;
    $('profileLbLastBtn').disabled = offset >= lastOffset;
  }

  $('profileLbTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-category]');
    if (!btn) return;
    document.querySelectorAll('#profileLbTabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadProfileLeaderboard(btn.dataset.category);
  });
  $('profileLbFirstBtn').addEventListener('click', () => loadProfileLeaderboard(null, 0));
  $('profileLbUpBtn').addEventListener('click', () => loadProfileLeaderboard(null, Math.max(0, profileLbOffset - PAGE_SIZE)));
  $('profileLbDownBtn').addEventListener('click', () => {
    const lastOffset = profileLbTotal > PAGE_SIZE ? profileLbTotal - PAGE_SIZE : 0;
    loadProfileLeaderboard(null, Math.min(lastOffset, profileLbOffset + PAGE_SIZE));
  });
  $('profileLbLastBtn').addEventListener('click', () => {
    const lastOffset = profileLbTotal > PAGE_SIZE ? profileLbTotal - PAGE_SIZE : 0;
    loadProfileLeaderboard(null, lastOffset);
  });

  // ---- Profil penceresi: oyun geçmişi (ana "Son Oyunların" ile aynı
  // mantık, ama HER ZAMAN incelenen oyuncuya göre -- ?username= ile) ----
  async function loadProfileGames(offset) {
    if (offset !== undefined) profileGamesOffset = offset;
    let path = '/api/my-games?limit=' + PAGE_SIZE + '&username=' + encodeURIComponent(profileUsername);
    if (profileGamesOffset !== null && profileGamesOffset !== undefined) path += '&offset=' + profileGamesOffset;
    const data = await api('GET', path);
    profileGamesOffset = data.offset;
    profileGamesTotal = data.total;
    const list = $('profileGamesList');
    list.innerHTML = '';
    if (!data.games.length) {
      list.innerHTML = `<li class="hint-text">${I18N.t('lobby.noGamesYet')}</li>`;
      renderProfileGamesPagination();
      return;
    }
    data.games.forEach(g => {
      const li = document.createElement('li');
      const targetIsWhite = (g.whiteUsername || '').toLowerCase() === profileUsername.toLowerCase();
      const oppName = targetIsWhite ? g.blackUsername : g.whiteUsername;
      const left = document.createElement('span');
      left.textContent = `vs ${oppName || '?'} (${g.timeControlKey})`;
      const right = document.createElement('span');
      right.textContent = describeResultThirdPerson(g, targetIsWhite);
      li.appendChild(left);
      li.appendChild(right);
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => { window.location.href = '/game.html?id=' + g.id; });
      list.appendChild(li);
    });
    renderProfileGamesPagination();
  }

  function renderProfileGamesPagination() {
    const total = profileGamesTotal;
    const offset = profileGamesOffset;
    const lastOffset = total > PAGE_SIZE ? total - PAGE_SIZE : 0;
    const start = total === 0 ? 0 : offset + 1;
    const end = Math.min(offset + PAGE_SIZE, total);
    $('profileGamesRangeText').textContent = total === 0 ? I18N.t('lobby.paginationEmpty') : I18N.t('lobby.paginationRange', { start, end, total });
    $('profileGamesLastBtn').disabled = offset <= 0;
    $('profileGamesNewerBtn').disabled = offset <= 0;
    $('profileGamesOlderBtn').disabled = offset >= lastOffset;
    $('profileGamesFirstBtn').disabled = offset >= lastOffset;
  }

  $('profileGamesLastBtn').addEventListener('click', () => loadProfileGames(0));
  $('profileGamesNewerBtn').addEventListener('click', () => loadProfileGames(Math.max(0, profileGamesOffset - PAGE_SIZE)));
  $('profileGamesOlderBtn').addEventListener('click', () => {
    const lastOffset = profileGamesTotal > PAGE_SIZE ? profileGamesTotal - PAGE_SIZE : 0;
    loadProfileGames(Math.min(lastOffset, profileGamesOffset + PAGE_SIZE));
  });
  $('profileGamesFirstBtn').addEventListener('click', () => {
    const lastOffset = profileGamesTotal > PAGE_SIZE ? profileGamesTotal - PAGE_SIZE : 0;
    loadProfileGames(lastOffset);
  });

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
      // describeOfferError kullanıyoruz -- hızlı eşleştirme iptal suistimali
      // cezası (QUICK_MATCH_CANCEL_BLOCKED) "{duration} sonra tekrar dene"
      // şeklinde, süre doldurulmuş olarak gösterilsin diye (kullanıcı isteği).
      alert(I18N.describeOfferError(err));
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
  let outgoingChallenge = null; // { challengeId, targetUsername, ranked }
  let incomingChallenge = null; // { challengeId, fromUsername, timeControlKey, colorForTarget, ranked }

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
      let text = I18N.t('lobby.challengePendingOutgoing', { username: outgoingChallenge.targetUsername });
      if (outgoingChallenge.ranked === false) text += I18N.t('lobby.challengeUnrankedTag');
      $('challengeOutgoingText').textContent = text;
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
      rankedNote: incomingChallenge.ranked === false ? I18N.t('lobby.challengeUnrankedTag') : '',
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
    const rankedInput = document.querySelector('input[name="challengeRanked"]:checked');
    const ranked = !rankedInput || rankedInput.value !== 'unranked';
    const timeControlKey = $('challengeTc').value;
    $('challengeError').textContent = '';
    $('challengeSendBtn').disabled = true;
    try {
      const res = await api('POST', '/api/challenge/send', { username, timeControlKey, color, ranked });
      outgoingChallenge = { challengeId: res.challengeId, targetUsername: username, ranked };
      renderOutgoingChallenge();
    } catch (err) {
      $('challengeError').textContent = I18N.describeOfferError(err);
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

  // Kullanıcı isteği: özel meydan okuma davetinde Kabul Et/Reddet'in yanında
  // bir de "Kullanıcıyı Engelle" seçeneği olsun -- komple engelleme
  // (blockUserRequest, yukarısı) + davetin de reddedilmesi (teklif sahibi
  // bilgilensin diye).
  $('challengeBlockBtn').addEventListener('click', async () => {
    if (!incomingChallenge) return;
    const username = incomingChallenge.fromUsername;
    const challengeId = incomingChallenge.challengeId;
    if (!confirm(I18N.t('lobby.blockConfirm', { username }))) return;
    try {
      const res = await blockUserRequest(username);
      try { await api('POST', '/api/challenge/respond', { challengeId, accept: false }); } catch { /* önemli değil */ }
      alert(I18N.t('lobby.blockSuccess', { username: res.username }));
    } catch (err) {
      alert(I18N.tErr(err));
    }
    incomingChallenge = null;
    renderIncomingChallenge();
  });

  // ---------------- Kullanıcı engelleme (kullanıcı isteği) ----------------
  // Engellenen kullanıcı artık bize hiçbir şekilde oyun teklif edemez ve
  // hızlı eşleştirmede bizimle eşleşemez -- ama biz istersek ona yine de
  // meydan okuyabiliriz (bkz. gameManager.js: blockUser/createChallenge).

  // Engelleme isteğini sunucuya gönderir ve başarılıysa hem "Engellediklerin"
  // listesini hem de oyun geçmişini (buradaki "Engelle" düğmelerinin
  // durumu güncellensin diye -- bkz. loadMyGames) yeniliyor. Hem aşağıdaki
  // manuel engelleme formu HEM DE oyun geçmişindeki tek tıkla engelleme
  // düğmesi (loadMyGames) bu ortak fonksiyonu kullanıyor.
  async function blockUserRequest(username) {
    const res = await api('POST', '/api/block/add', { username });
    await Promise.all([loadBlockedList(), loadMyGames()]);
    return res;
  }

  async function loadBlockedList() {
    const { usernames } = await api('GET', '/api/block/list');
    const list = $('blockedList');
    list.innerHTML = '';
    if (!usernames.length) {
      list.innerHTML = `<li class="hint-text">${I18N.t('lobby.blockedListEmpty')}</li>`;
      return;
    }
    usernames.forEach(username => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = username;
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = I18N.t('lobby.unblockButton');
      btn.addEventListener('click', async () => {
        if (!confirm(I18N.t('lobby.unblockConfirm', { username }))) return;
        try {
          await api('POST', '/api/block/remove', { username });
          // Engel kalkınca, oyun geçmişindeki bu kullanıcı için "Engelle"
          // düğmesi de (tekrar engellenebilsin diye) geri gelsin.
          await Promise.all([loadBlockedList(), loadMyGames()]);
        } catch (err) {
          alert(I18N.tErr(err));
        }
      });
      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  // NOT (kullanıcı isteği): kullanıcı adını tek tek yazarak engelleme
  // seçeneği burada AYNEN duruyor -- oyun geçmişindeki tek-tıkla engelleme
  // düğmesi (loadMyGames) buna bir ALTERNATİF, onun yerini almıyor.
  $('blockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('blockUsername').value.trim();
    if (!username) return;
    if (!confirm(I18N.t('lobby.blockConfirm', { username }))) return;
    $('blockError').textContent = '';
    $('blockSendBtn').disabled = true;
    try {
      const res = await blockUserRequest(username);
      $('blockForm').reset();
      alert(I18N.t('lobby.blockSuccess', { username: res.username }));
    } catch (err) {
      $('blockError').textContent = I18N.tErr(err);
    } finally {
      $('blockSendBtn').disabled = false;
    }
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
        ranked: data.ranked,
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
    await Promise.all([loadTimeControls(), loadLeaderboard(), loadMyGames(), loadBlockedList()]);
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
      loadBlockedList();
      renderOutgoingChallenge();
      renderIncomingChallenge();
      // Oyuncu profili penceresi o an açıksa (kullanıcı isteği), onun
      // içindeki dinamik metinler (sayfalama aralığı vb.) de yeni dilde
      // yeniden çizilsin.
      if (!$('playerProfileModal').classList.contains('hidden') && profileUsername) {
        loadProfileLeaderboard();
        loadProfileGames();
      }
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
