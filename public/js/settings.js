// public/js/settings.js — Kullanıcı isteği: sağ üstte (motor aç/kapa, dil
// geçişi, çıkış gibi düğmelerin olduğu köşede -- flex+gap sayesinde onları
// hiç ENGELLEMEDEN) bir "Ayarlar" (dişli) düğmesi olsun. Şimdilik tek ayar
// var: bir ön-hamle (premove) bir terfiyle sonuçlandığında hangi taşa
// OTOMATİK terfi edileceği (varsayılan: vezir), ya da bu otomatikliğin
// tamamen kapatılıp eskisi gibi her seferinde sorulması ("devre dışı").
//
// Bu bir HESAP tercihi değil (i18n.js'teki dil tercihinin aksine sunucuya
// hiç gönderilmiyor) -- sadece bu TARAYICIDA kalıcı bir arayüz tercihi
// olduğu için localStorage'da saklanıyor. Bu dosya i18n.js'in HEMEN
// ardından, o sayfanın kendi betiğinden (game.js/app.js/analysis.js) ÖNCE
// yükleniyor ki window.AppSettings, game.js'in ihtiyaç duyduğu anda (bkz.
// tryExecutePremove) zaten hazır olsun -- chat.js/social-widget.js'teki
// window.X = {...} paylaşım deseniyle aynı yaklaşım.
(function () {
  const STORAGE_KEY = 'settings.premovePromotion';
  const DEFAULT_VALUE = 'q';
  const VALID_VALUES = ['q', 'r', 'b', 'n', 'off'];

  function getPremoveAutoPromotion() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return VALID_VALUES.includes(v) ? v : DEFAULT_VALUE;
    } catch {
      // localStorage bazı tarayıcı/gizli mod durumlarında erişilemez
      // olabilir -- bu durumda sessizce varsayılana dönüyoruz.
      return DEFAULT_VALUE;
    }
  }

  function setPremoveAutoPromotion(value) {
    if (!VALID_VALUES.includes(value)) return;
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* yok say */ }
  }

  function $(id) { return document.getElementById(id); }

  function ensureUI() {
    const btn = $('settingsBtn');
    const modal = $('settingsModal');
    const select = $('premovePromotionSelect');
    if (!btn || !modal || !select) return; // bu sayfada Ayarlar penceresi yoksa sessizce çık

    const closeBtn = $('settingsCloseBtn');

    select.value = getPremoveAutoPromotion();

    btn.addEventListener('click', () => {
      select.value = getPremoveAutoPromotion();
      modal.classList.remove('hidden');
    });

    function close() { modal.classList.add('hidden'); }
    if (closeBtn) closeBtn.addEventListener('click', close);
    // Karartılmış arka plana (overlay'in kendisine) tıklanınca da kapansın,
    // ama pencerenin İÇİNE (kart) tıklanınca kapanmasın (diğer modallarla
    // aynı desen -- bkz. app.js: playerProfileModal).
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    select.addEventListener('change', () => {
      setPremoveAutoPromotion(select.value);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    ensureUI();
  }

  window.AppSettings = { getPremoveAutoPromotion, setPremoveAutoPromotion };
})();
