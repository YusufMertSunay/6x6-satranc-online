// public/js/settings.js — Kullanıcı isteği: sağ üstte (motor aç/kapa, dil
// geçişi, çıkış gibi düğmelerin olduğu köşede -- flex+gap sayesinde onları
// hiç ENGELLEMEDEN) bir "Ayarlar" (dişli) düğmesi olsun. Ayarlar:
//   1) Bir ön-hamle (premove) bir terfiyle sonuçlandığında hangi taşa
//      OTOMATİK terfi edileceği (varsayılan: vezir), ya da bu otomatikliğin
//      tamamen kapatılıp eskisi gibi her seferinde sorulması ("devre dışı").
//   2) Tahta renkleri (açık/koyu kareler) -- kullanıcı isteğiyle HEM Ayarlar
//      penceresinin içinde HEM DE eskisi gibi tahtanın hemen altında her
//      zaman görünen bir panelde (#boardColorSettings) aynı anda ayarlanabiliyor.
//      İkisi de aynı ortak CSS sınıflarını (.board-light-input/.board-dark-input/
//      .board-reset-btn) paylaşıyor -- bkz. aşağıdaki allLightInputs/
//      allDarkInputs/allResetButtons/syncColorInputsUI: hangisinden değişirse
//      değişsin, diğeri de anında güncellenir. localStorage anahtarları (
//      boardLightColor/boardDarkColor) ESKİSİYLE AYNI bırakıldı ki daha önce
//      renk seçmiş kullanıcıların tercihi kaybolmasın.
//   3) Tahtanın kenarındaki harf (a-f) VE numara (1-6) etiketlerinin AYRI
//      AYRI gösterilip gösterilmeyeceği (kullanıcı isteği: sadece harfleri,
//      sadece numaraları ya da ikisini birden kaldırabilmeli) -- varsayılan:
//      ikisi de gösteriliyor. (İlk sürümde tek bir "koordinatları göster"
//      anahtarı vardı -- kullanıcı isteğiyle ikiye ayrıldı; aşağıdaki
//      migrateOldCombinedCoordsSetting o eski tercihi kaybetmeden yeni iki
//      anahtara taşıyor.)
//
// Bunların HİÇBİRİ bir HESAP tercihi değil (i18n.js'teki dil tercihinin
// aksine sunucuya hiç gönderilmiyor) -- sadece bu TARAYICIDA kalıcı bir
// arayüz tercihi olduğu için localStorage'da saklanıyor. Bu dosya i18n.js'in
// HEMEN ardından, o sayfanın kendi betiğinden (game.js/app.js/analysis.js)
// ÖNCE yükleniyor ki hem window.AppSettings game.js'in ihtiyaç duyduğu anda
// (bkz. tryExecutePremove) zaten hazır olsun, hem de tahta rengi/koordinat
// tercihi tahta hiç çizilmeden ÖNCE uygulanmış olsun (böylece varsayılan
// renklerle/etiketlerle kısa bir an görünüp sonra değişme "titremesi" olmaz).
(function () {
  const $ = (id) => document.getElementById(id);

  // ---- 1) Ön-hamlede otomatik terfi taşı ----
  const PROMO_KEY = 'settings.premovePromotion';
  const PROMO_DEFAULT = 'q';
  const PROMO_VALID = ['q', 'r', 'b', 'n', 'off'];

  function getPremoveAutoPromotion() {
    try {
      const v = localStorage.getItem(PROMO_KEY);
      return PROMO_VALID.includes(v) ? v : PROMO_DEFAULT;
    } catch {
      // localStorage bazı tarayıcı/gizli mod durumlarında erişilemez
      // olabilir -- bu durumda sessizce varsayılana dönüyoruz.
      return PROMO_DEFAULT;
    }
  }

  function setPremoveAutoPromotion(value) {
    if (!PROMO_VALID.includes(value)) return;
    try { localStorage.setItem(PROMO_KEY, value); } catch { /* yok say */ }
  }

  // ---- 2) Tahta renkleri (açık/koyu kareler) ----
  // NOT: anahtar adları kasıtlı olarak eski #boardColorSettings panelindeki
  // İLE AYNI ('boardLightColor'/'boardDarkColor') -- bkz. yukarısı.
  const LIGHT_KEY = 'boardLightColor';
  const DARK_KEY = 'boardDarkColor';
  const DEFAULT_LIGHT = '#ebecd0';
  const DEFAULT_DARK = '#779556';

  function getBoardColors() {
    let light = DEFAULT_LIGHT, dark = DEFAULT_DARK;
    try {
      light = localStorage.getItem(LIGHT_KEY) || DEFAULT_LIGHT;
      dark = localStorage.getItem(DARK_KEY) || DEFAULT_DARK;
    } catch { /* localStorage kapalı/engelliyse varsayılanlarla devam */ }
    return { light, dark };
  }

  function applyBoardColors(light, dark) {
    document.documentElement.style.setProperty('--light-square', light);
    document.documentElement.style.setProperty('--dark-square', dark);
  }

  function setBoardColors(light, dark) {
    applyBoardColors(light, dark);
    try {
      localStorage.setItem(LIGHT_KEY, light);
      localStorage.setItem(DARK_KEY, dark);
    } catch { /* yok say */ }
  }

  function resetBoardColors() {
    applyBoardColors(DEFAULT_LIGHT, DEFAULT_DARK);
    try {
      localStorage.removeItem(LIGHT_KEY);
      localStorage.removeItem(DARK_KEY);
    } catch { /* yok say */ }
    return { light: DEFAULT_LIGHT, dark: DEFAULT_DARK };
  }

  // ---- 3) Tahta kenarındaki harf (a-f) / numara (1-6) etiketleri (AYRI AYRI) ----
  const FILE_LABELS_HIDDEN_KEY = 'settings.hideBoardFileLabels';
  const RANK_LABELS_HIDDEN_KEY = 'settings.hideBoardRankLabels';
  // Bir önceki sürümde İKİSİ TEK bir anahtarla ('settings.hideBoardCoords')
  // birlikte kontrol ediliyordu -- bu anahtarı hâlâ ayarlamış (harf/numarayı
  // birlikte kapatmış) kullanıcıların tercihini kaybetmemek için, bir defalık
  // bu göçü yapıp eski anahtarı siliyoruz.
  const OLD_COMBINED_KEY = 'settings.hideBoardCoords';

  function migrateOldCombinedCoordsSetting() {
    try {
      const old = localStorage.getItem(OLD_COMBINED_KEY);
      if (old === '1') {
        if (localStorage.getItem(FILE_LABELS_HIDDEN_KEY) === null) localStorage.setItem(FILE_LABELS_HIDDEN_KEY, '1');
        if (localStorage.getItem(RANK_LABELS_HIDDEN_KEY) === null) localStorage.setItem(RANK_LABELS_HIDDEN_KEY, '1');
      }
      if (old !== null) localStorage.removeItem(OLD_COMBINED_KEY);
    } catch { /* yok say */ }
  }

  // Varsayılan: GÖSTERİLİYOR (kullanıcı isteği) -- bu yüzden "gizli" durumu
  // pozitif bir bayrakla ('1') saklıyoruz; anahtar hiç yoksa (varsayılan/
  // hiç dokunulmamış kullanıcı) gösterilmiş sayılır.
  function getShowFileLabels() {
    try { return localStorage.getItem(FILE_LABELS_HIDDEN_KEY) !== '1'; } catch { return true; }
  }
  function getShowRankLabels() {
    try { return localStorage.getItem(RANK_LABELS_HIDDEN_KEY) !== '1'; } catch { return true; }
  }

  function applyLabelVisibility(showFiles, showRanks) {
    document.documentElement.classList.toggle('hide-board-file-labels', !showFiles);
    document.documentElement.classList.toggle('hide-board-rank-labels', !showRanks);
  }

  function setShowFileLabels(show) {
    applyLabelVisibility(show, getShowRankLabels());
    try {
      if (show) localStorage.removeItem(FILE_LABELS_HIDDEN_KEY);
      else localStorage.setItem(FILE_LABELS_HIDDEN_KEY, '1');
    } catch { /* yok say */ }
  }

  function setShowRankLabels(show) {
    applyLabelVisibility(getShowFileLabels(), show);
    try {
      if (show) localStorage.removeItem(RANK_LABELS_HIDDEN_KEY);
      else localStorage.setItem(RANK_LABELS_HIDDEN_KEY, '1');
    } catch { /* yok say */ }
  }

  // Tahta rengi/koordinat görünürlüğü, İÇİNDE BULUNDUĞUMUZ sayfada tahta
  // olsun olmasın (index.html'de tahta yok) hemen uygulanıyor -- zararsız
  // (kullanılmayan bir CSS değişkeni/sınıf) ve tahtası olan sayfalarda
  // (game.html/analysis.html) mümkün olduğunca ERKEN uygulanmış olur.
  {
    migrateOldCombinedCoordsSetting();
    const colors = getBoardColors();
    applyBoardColors(colors.light, colors.dark);
    applyLabelVisibility(getShowFileLabels(), getShowRankLabels());
  }

  // ---- Tahta renk girdileri: HEM Ayarlar modalinde HEM DE (kullanıcı
  // isteği) tahtanın altındaki her-zaman-görünen panelde -- ikisi de aynı
  // ortak sınıfları taşıyor (bkz. game.html/analysis.html), burada TEK
  // seferde ikisi birden bulunup senkron tutuluyor. Böylece hangisinden
  // değiştirilirse değiştirilsin, diğeri de anında güncel değeri gösterir.
  function allLightInputs() { return document.querySelectorAll('.board-light-input'); }
  function allDarkInputs() { return document.querySelectorAll('.board-dark-input'); }
  function allResetButtons() { return document.querySelectorAll('.board-reset-btn'); }

  function syncColorInputsUI() {
    const colors = getBoardColors();
    allLightInputs().forEach((el) => { el.value = colors.light; });
    allDarkInputs().forEach((el) => { el.value = colors.dark; });
  }

  function ensureUI() {
    const btn = $('settingsBtn');
    const modal = $('settingsModal');

    // Tahta renk girdileri/sıfırla düğmeleri, gerek modalde gerek tahtanın
    // altındaki panelde olsun, dişli/modal bu sayfada hiç yoksa (ör. daha
    // önce hiç eklenmemiş bir sayfa) bile bağımsız çalışabilsin diye bu
    // kısım aşağıdaki erken çıkıştan (return) ÖNCE, ayrı olarak bağlanıyor.
    allLightInputs().forEach((input) => {
      input.addEventListener('input', () => {
        setBoardColors(input.value, getBoardColors().dark);
        syncColorInputsUI();
      });
    });
    allDarkInputs().forEach((input) => {
      input.addEventListener('input', () => {
        setBoardColors(getBoardColors().light, input.value);
        syncColorInputsUI();
      });
    });
    allResetButtons().forEach((button) => {
      button.addEventListener('click', () => {
        resetBoardColors();
        syncColorInputsUI();
      });
    });
    syncColorInputsUI();

    if (!btn || !modal) return; // bu sayfada Ayarlar düğmesi yoksa sessizce çık

    const closeBtn = $('settingsCloseBtn');
    const promoSelect = $('premovePromotionSelect');
    const fileLabelsCheckbox = $('showFileLabelsCheckbox');
    const rankLabelsCheckbox = $('showRankLabelsCheckbox');

    function syncFieldsToCurrentValues() {
      if (promoSelect) promoSelect.value = getPremoveAutoPromotion();
      syncColorInputsUI();
      if (fileLabelsCheckbox) fileLabelsCheckbox.checked = getShowFileLabels();
      if (rankLabelsCheckbox) rankLabelsCheckbox.checked = getShowRankLabels();
    }

    btn.addEventListener('click', () => {
      syncFieldsToCurrentValues();
      modal.classList.remove('hidden');
    });

    function close() { modal.classList.add('hidden'); }
    if (closeBtn) closeBtn.addEventListener('click', close);
    // Karartılmış arka plana (overlay'in kendisine) tıklanınca da kapansın,
    // ama pencerenin İÇİNE (kart) tıklanınca kapanmasın (diğer modallarla
    // aynı desen -- bkz. app.js: playerProfileModal).
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    if (promoSelect) {
      promoSelect.addEventListener('change', () => {
        setPremoveAutoPromotion(promoSelect.value);
      });
    }

    if (fileLabelsCheckbox) {
      fileLabelsCheckbox.addEventListener('change', () => {
        setShowFileLabels(fileLabelsCheckbox.checked);
      });
    }
    if (rankLabelsCheckbox) {
      rankLabelsCheckbox.addEventListener('change', () => {
        setShowRankLabels(rankLabelsCheckbox.checked);
      });
    }

    syncFieldsToCurrentValues();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    ensureUI();
  }

  window.AppSettings = {
    getPremoveAutoPromotion,
    setPremoveAutoPromotion,
    getBoardColors,
    setBoardColors,
    resetBoardColors,
    getShowFileLabels,
    setShowFileLabels,
    getShowRankLabels,
    setShowRankLabels,
  };
})();
