// public/js/settings.js — Kullanıcı isteği: sağ üstte (motor aç/kapa, dil
// geçişi, çıkış gibi düğmelerin olduğu köşede -- flex+gap sayesinde onları
// hiç ENGELLEMEDEN) bir "Ayarlar" (dişli) düğmesi olsun. Ayarlar:
//   1) Bir ön-hamle (premove) bir terfiyle sonuçlandığında hangi taşa
//      OTOMATİK terfi edileceği (varsayılan: vezir), ya da bu otomatikliğin
//      tamamen kapatılıp eskisi gibi her seferinde sorulması ("devre dışı").
//   2) Tahta renkleri (açık/koyu kareler) -- ESKİDEN game.html/analysis.html'de
//      tahtanın hemen altında ayrı, HER ZAMAN görünen bir panel olarak
//      duruyordu (#boardColorSettings); kullanıcı isteğiyle artık buraya,
//      Ayarlar penceresinin içine taşındı. localStorage anahtarları (
//      boardLightColor/boardDarkColor) ESKİSİYLE AYNI bırakıldı ki daha önce
//      renk seçmiş kullanıcıların tercihi kaybolmasın.
//   3) Tahtanın kenarındaki harf (a-f) / numara (1-6) etiketlerinin
//      gösterilip gösterilmeyeceği (varsayılan: gösteriliyor).
//
// Bunların HİÇBİRİ bir HESAP tercihi değil (i18n.js'teki dil tercihinin
// aksine sunucuya hiç gönderilmiyor) -- sadece bu TARAYICIDA kalıcı bir
// arayüz tercihi olduğu için localStorage'da saklanıyor. Bu dosya i18n.js'in
// HEMEN ardından, o sayfanın kendi betiğinden (game.js/app.js/analysis.js)
// ÖNCE yükleniyor ki hem window.AppSettings game.js'in ihtiyaç duyduğu anda
// (bkz. tryExecutePremove) zaten hazır olsun, hem de tahta rengi/koordinat
// tercihi tahta hiç çizilmeden ÖNCE uygulanmış olsun (böylece varsayılan
// renklerle kısa bir an görünüp sonra değişme "titremesi" olmaz).
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

  // ---- 3) Tahta kenarındaki harf/numara etiketleri ----
  const COORDS_HIDDEN_KEY = 'settings.hideBoardCoords';

  // Varsayılan: GÖSTERİLİYOR (kullanıcı isteği) -- bu yüzden "gizli" durumu
  // pozitif bir bayrakla ('1') saklıyoruz; anahtar hiç yoksa (varsayılan/
  // hiç dokunulmamış kullanıcı) gösterilmiş sayılır.
  function getShowCoordinates() {
    try {
      return localStorage.getItem(COORDS_HIDDEN_KEY) !== '1';
    } catch {
      return true;
    }
  }

  function applyCoordinatesVisibility(show) {
    document.documentElement.classList.toggle('hide-board-coords', !show);
  }

  function setShowCoordinates(show) {
    applyCoordinatesVisibility(show);
    try {
      if (show) localStorage.removeItem(COORDS_HIDDEN_KEY);
      else localStorage.setItem(COORDS_HIDDEN_KEY, '1');
    } catch { /* yok say */ }
  }

  // Tahta rengi/koordinat görünürlüğü, İÇİNDE BULUNDUĞUMUZ sayfada tahta
  // olsun olmasın (index.html'de tahta yok) hemen uygulanıyor -- zararsız
  // (kullanılmayan bir CSS değişkeni/sınıf) ve tahtası olan sayfalarda
  // (game.html/analysis.html) mümkün olduğunca ERKEN uygulanmış olur.
  {
    const colors = getBoardColors();
    applyBoardColors(colors.light, colors.dark);
    applyCoordinatesVisibility(getShowCoordinates());
  }

  function ensureUI() {
    const btn = $('settingsBtn');
    const modal = $('settingsModal');
    if (!btn || !modal) return; // bu sayfada Ayarlar düğmesi yoksa sessizce çık

    const closeBtn = $('settingsCloseBtn');
    const promoSelect = $('premovePromotionSelect');
    const lightInput = $('lightColorInput');
    const darkInput = $('darkColorInput');
    const resetColorsBtn = $('resetBoardColorsBtn');
    const coordsCheckbox = $('showCoordinatesCheckbox');

    function syncFieldsToCurrentValues() {
      if (promoSelect) promoSelect.value = getPremoveAutoPromotion();
      if (lightInput && darkInput) {
        const colors = getBoardColors();
        lightInput.value = colors.light;
        darkInput.value = colors.dark;
      }
      if (coordsCheckbox) coordsCheckbox.checked = getShowCoordinates();
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

    if (lightInput && darkInput) {
      lightInput.addEventListener('input', () => setBoardColors(lightInput.value, darkInput.value));
      darkInput.addEventListener('input', () => setBoardColors(lightInput.value, darkInput.value));
    }

    if (resetColorsBtn) {
      resetColorsBtn.addEventListener('click', () => {
        const d = resetBoardColors();
        if (lightInput) lightInput.value = d.light;
        if (darkInput) darkInput.value = d.dark;
      });
    }

    if (coordsCheckbox) {
      coordsCheckbox.addEventListener('change', () => {
        setShowCoordinates(coordsCheckbox.checked);
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
    getShowCoordinates,
    setShowCoordinates,
  };
})();
