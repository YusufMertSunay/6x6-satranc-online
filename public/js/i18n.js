// public/js/i18n.js — TR/EN dil desteği (paylaşılan sözlük + yardımcı
// fonksiyonlar). Bu dosya, kendi sayfa betiğinden (app.js/game.js/analysis.js)
// ÖNCE, <script> etiketiyle her HTML sayfasına ekleniyor -- böylece o
// betikler çalışmaya başladığında window.I18N zaten hazır oluyor.
//
// Mimari (neden BÖYLE): Sunucu (server.js) tüm hata mesajlarını hâlâ Türkçe
// metin olarak üretiyor (gameManager.js/store.js/engine.js'de fırlatılan
// Error nesneleri) -- bunların HER BİRİNİ sunucu tarafında isteğin diline
// göre çevirmek, onlarca yeri değiştirmek anlamına gelirdi (ve isteğin
// dilini bilmek için de ayrıca bir mekanizma gerekirdi). Bunun yerine
// sunucu, her bilinen hata mesajına sabit bir "errorCode" (ör.
// "NOT_YOUR_TURN") ekliyor (bkz. server.js: ERROR_CODES/errJson) ve dil
// çevirisinin TAMAMI burada, istemci tarafında yapılıyor (bkz. tErr).
//
// Dil tercihi NEREDE saklanıyor: hem bir ÇEREZDE (giriş yapmadan önceki
// sayfalarda -- kayıt/giriş ekranı -- da çalışsın diye) HEM DE, kullanıcı
// giriş yapmışsa, HESABINDA (store.js: user.language) -- böylece başka bir
// cihaz/tarayıcıdan giriş yapınca da aynı dil otomatik uygulanır. Giriş
// yapıldıktan sonra HESAP tercihi çerezden ÖNCELİKLİDİR (bkz. syncFromAccount).

(function () {
  const COOKIE_NAME = 'lang';

  const TRANSLATIONS = {
    tr: {
      // ---- Marka / başlıklar ----
      'brand.titleHome': '6x6 <span class="accent">Satranç</span> Online',
      'brand.titleLinked': '<span class="accent">6x6</span> Satranç Online',
      'title.lobby': '6x6 Satranç Online',
      'title.game': 'Oyun · 6x6 Satranç Online',
      'title.analysis': 'Analiz Tahtası · 6x6 Satranç Online',

      // ---- Genel / gezinme ----
      'nav.logout': 'Çıkış',
      'nav.backToLobby': '← Lobiye dön',
      'nav.backToGame': '← Oyuna dön',
      'common.accept': 'Kabul Et',
      'common.decline': 'Reddet',
      'common.youSuffix': ' (Sen)',
      'common.opponent': 'Rakip',
      'common.white': 'Beyaz',
      'common.black': 'Siyah',
      'common.random': 'Rastgele',
      'common.dash': '-',

      // ---- Giriş / Kayıt ----
      'auth.login': 'Giriş Yap',
      'auth.register': 'Kayıt Ol',
      'auth.usernamePlaceholder': 'Kullanıcı adı',
      'auth.passwordPlaceholder': 'Parola',
      'auth.hint': 'Kullanıcı adı 3-24 karakter, parola en az 6 karakter olmalı.',

      // ---- Lobi ----
      'lobby.quickMatchTitle': 'Hızlı Eşleşme',
      'lobby.findMatch': 'Oyun Bul',
      'lobby.searchingOpponent': 'Rakip aranıyor',
      'lobby.cancelQueue': 'İptal Et',
      'lobby.activeGameNotice': 'Devam eden bir oyunun var.',
      'lobby.resumeGame': 'Oyuna Dön',
      'lobby.freeAnalysisLink': 'Serbest Analiz Tahtası (oyun oynamadan)',
      'lobby.challengeTitle': 'Bir Oyuncuya Meydan Oku',
      'lobby.challengeUsernamePlaceholder': 'Kullanıcı adı',
      'lobby.challengeColorLabel': 'Renginiz:',
      'lobby.challengeColorWhite': 'Beyaz',
      'lobby.challengeColorBlack': 'Siyah',
      'lobby.challengeColorRandom': 'Rastgele',
      'lobby.challengeSend': 'Meydan Oku',
      'lobby.challengePendingOutgoing': '{username} adlı oyuncuya gönderildi, yanıt bekleniyor...',
      'lobby.challengeCancelBtn': 'İptal Et',
      'lobby.challengeIncomingText': '{username} sana meydan okudu — {timeControl}, sen {color} oynayacaksın.',
      'lobby.challengeDeclinedByTarget': '{username} meydan okumanı reddetti.',
      'lobby.challengeExpiredOutgoing': '{username} adlı oyuncuya gönderdiğin meydan okumanın süresi doldu.',
      'lobby.leaderboardTitle': 'Liderlik Tablosu',
      'lobby.recentGamesTitle': 'Son Oyunların',
      'lobby.noGamesYet': 'Henüz oyun yok.',
      'lobby.thRank': '#',
      'lobby.thUser': 'Kullanıcı',
      'lobby.thRating': 'Puan',
      'lobby.thRecord': 'G/M/B',

      // ---- Süre kontrolü kategorileri ----
      'cat.bullet': 'Bullet',
      'cat.blitz': 'Blitz',
      'cat.rapid': 'Rapid',
      'cat.classical': 'Klasik',
      // Süre kontrolü etiketleri sunucudan (gameManager.js: TIME_CONTROLS)
      // ARTIK doğrudan Türkçe metin olarak gelmiyor -- istemci, sunucudan
      // gelen "key" (ör. "3+2" = 3 dakika + 2 saniye artış) ve "category"
      // bilgisinden bu iki parçayı birleştirerek etiketi KENDİSİ üretiyor
      // (bkz. app.js: formatTimeControlLabel) -- böylece dil değişince
      // yeniden çeviri gerekmiyor.
      'tc.minutesShort': '{m} dk',
      'tc.incrementShort': ' | +{s} sn',

      // ---- Oyun sonuçları ----
      'result.won': 'Kazandın',
      'result.wonBanner': 'Kazandın!',
      'result.lost': 'Kaybettin',
      'result.draw': 'Berabere',
      'result.checkmate': 'Şah mat',
      'result.stalemate': 'Pat (berabere)',
      'result.insufficientMaterial': 'Yetersiz taş (berabere)',
      'result.resigned': 'Teslim oldu',
      'result.timeout': 'Süre doldu',
      'result.timeoutInsufficientMaterial': 'Süre doldu, ancak yetersiz taş (berabere)',
      'result.drawAgreed': 'Anlaşmalı beraberlik',
      'result.threefold': 'Üç kez tekrar (berabere)',
      'result.fiftyMove': '50 hamle kuralı (berabere)',

      // ---- Tahta renk ayarları ----
      'board.lightSquares': 'Açık kareler',
      'board.darkSquares': 'Koyu kareler',
      'board.resetColors': 'Varsayılana Dön',

      // ---- Oyun ekranı ----
      'status.loading': 'Yükleniyor...',
      'game.drawOfferedByOpponent': 'Rakibin beraberlik teklif etti.',
      'game.rematchOfferedByOpponent': 'Rakibin yeni oyun teklif etti.',
      'game.offerRematch': 'Yeni Oyun Teklif Et',
      'game.rematchPending': 'Teklif gönderildi, rakip bekleniyor...',
      'game.openAnalysis': 'Analiz Tahtasını Aç',
      'game.offerDraw': 'Beraberlik Teklif Et',
      'game.resign': 'Teslim Ol',
      'game.choosePromotion': 'Terfi edecek taşı seç',
      'game.confirmResign': 'Teslim olmak istediğine emin misin?',
      'game.yourTurn': 'Sıra sende',
      'game.opponentThinking': 'Rakip düşünüyor...',
      'game.newRatingLine': 'Yeni {category} puanın: {rating}',

      // ---- Analiz ekranı ----
      'analysis.movesHint': 'Oyunun hamleleri (tıklayınca o ana gider):',
      'analysis.pvHint': 'Motorun önerdiği varyant (PV):',
      'analysis.navStart': '|< Başa',
      'analysis.navBack': '< Geri',
      'analysis.navForward': 'İleri >',
      'analysis.navEnd': 'Sona >|',
      'analysis.navStartTitle': 'Başa dön',
      'analysis.navBackTitle': 'Bir hamle geri',
      'analysis.navForwardTitle': 'Bir hamle ileri',
      'analysis.navEndTitle': 'Oyunun sonuna git',
      'analysis.flipBoard': 'Tahtayı Çevir',
      'analysis.evalInitial': 'Değerlendirme: -',
      'analysis.evalPrefix': 'Değerlendirme: ',
      'analysis.evalCalculating': 'Değerlendirme: hesaplanıyor...',
      'analysis.turnWhite': 'Sırada: Beyaz',
      'analysis.turnBlack': 'Sırada: Siyah',
      'analysis.deviatedNote': ' — kitaptan sapıldı (bu hamleler gerçek oyunda oynanmadı)',
      'analysis.evalGameOverNoMoves': 'oyun bu pozisyonda bitiyor (hamle yok)',
      'analysis.evalDrawInsufficientMaterial': 'berabere (yetersiz taş)',
      'analysis.whiteMatesIn': 'Beyaz mat ediyor (#{n})',
      'analysis.blackMatesIn': 'Siyah mat ediyor (#{n})',
      'analysis.whiteAdvantage': 'Beyaz avantajlı',
      'analysis.blackAdvantage': 'Siyah avantajlı',

      // ---- Hata önekleri (client tarafında oluşan, sunucudan gelmeyen) ----
      'err.unknown': 'Bilinmeyen hata',
      'err.gameLoadFailedPrefix': 'Oyun yüklenemedi: ',
      'err.positionCalcFailedPrefix': 'Pozisyon hesaplanamadı: ',
      'err.evalFailedPrefix': 'Değerlendirme alınamadı: ',
      'err.analysisOpenFailedPrefix': 'Analiz açılamadı: ',

      // ---- Sunucudan errorCode ile gelen hata mesajları (bkz. server.js: ERROR_CODES) ----
      'err.GAME_NOT_FOUND': 'Oyun bulunamadı.',
      'err.NOT_A_PLAYER': 'Bu oyunun oyuncusu değilsin.',
      'err.GAME_ALREADY_FINISHED': 'Oyun zaten bitmiş.',
      'err.NOT_YOUR_TURN': 'Sıra sende değil.',
      'err.ILLEGAL_MOVE': 'Bu hamle yasal değil.',
      'err.INVALID_PROMOTION': 'Geçersiz terfi seçimi.',
      'err.GAME_NOT_FOUND_OR_FINISHED': 'Oyun bulunamadı ya da zaten bitmiş.',
      'err.NO_DRAW_OFFER': 'Yanıtlanacak bir beraberlik teklifi yok.',
      'err.REMATCH_NOT_AVAILABLE': 'Bu oyun için yeni oyun teklif edilemez.',
      'err.ALREADY_IN_GAME': 'Zaten devam eden bir oyunun var.',
      'err.OPPONENT_IN_GAME': 'Rakip şu anda başka bir oyunda.',
      'err.NO_REMATCH_OFFER': 'Yanıtlanacak bir yeni oyun teklifi yok.',
      'err.PLAYER_IN_ANOTHER_GAME': 'Taraflardan biri zaten başka bir oyunda.',
      'err.INVALID_TIME_CONTROL': 'Geçersiz süre kontrolü.',
      'err.USERNAME_TAKEN': 'Bu kullanıcı adı zaten alınmış.',
      'err.USERNAME_LENGTH': 'Kullanıcı adı 3-24 karakter olmalı.',
      'err.USERNAME_INVALID_CHARS': 'Kullanıcı adı geçersiz karakterler içeriyor.',
      'err.PASSWORD_TOO_SHORT': 'Parola en az 6 karakter olmalı.',
      'err.LOGIN_FAILED': 'Kullanıcı adı ya da parola hatalı.',
      'err.LOGIN_REQUIRED': 'Giriş yapmalısın.',
      'err.ANALYSIS_NOT_AVAILABLE_DETAILED': 'Bu oyun için analiz yapılamaz (oyun bitmemiş olabilir ya da bu oyunun oyuncusu değilsin).',
      'err.ANALYSIS_NOT_AVAILABLE': 'Bu oyun için analiz yapılamaz.',
      'err.ENGINE_POSITION_FAILED': 'Motor pozisyonu hesaplayamadı.',
      'err.ENGINE_NOT_RUNNING': 'Motor çalışmıyor.',
      'err.NOT_FOUND': 'Bulunamadı.',
      'err.INVALID_LANGUAGE': 'Geçersiz dil.',
      'err.BOOK_MOVE_UNDELETABLE': 'Kitap hamlesi silinemez.',
      'err.NODE_NOT_FOUND': 'Düğüm bulunamadı.',
      'err.PLAYER_NOT_FOUND': 'Bu kullanıcı adında bir oyuncu bulunamadı.',
      'err.CANNOT_CHALLENGE_SELF': 'Kendine meydan okuyamazsın.',
      'err.PLAYER_NOT_ONLINE': 'Bu oyuncu şu anda çevrimiçi değil.',
      'err.INVALID_COLOR_CHOICE': 'Geçersiz renk seçimi.',
      'err.CHALLENGE_NOT_FOUND': 'Bu meydan okuma artık geçerli değil.',
      'err.CHALLENGE_NOT_YOURS': 'Bu meydan okumayı yanıtlayamazsın.',
      'err.CHALLENGE_CANCEL_NOT_YOURS': 'Bu meydan okumayı iptal edemezsin.',

      // ---- Varyant ağacı (lichess tarzı alt varyantlar) ----
      'analysis.confirmDeleteVariation': 'Bu varyantı (ve varsa devamındaki hamleleri) silmek istediğine emin misin?',
      'analysis.deleteVariationTitle': 'Bu varyantı sil',
      'analysis.pvBoxTitle': 'Bu varyantı tahtaya uygula ve kaydet',
    },
    en: {
      'brand.titleHome': '6x6 <span class="accent">Chess</span> Online',
      'brand.titleLinked': '<span class="accent">6x6</span> Chess Online',
      'title.lobby': '6x6 Chess Online',
      'title.game': 'Game · 6x6 Chess Online',
      'title.analysis': 'Analysis Board · 6x6 Chess Online',

      'nav.logout': 'Log out',
      'nav.backToLobby': '← Back to lobby',
      'nav.backToGame': '← Back to game',
      'common.accept': 'Accept',
      'common.decline': 'Decline',
      'common.youSuffix': ' (You)',
      'common.opponent': 'Opponent',
      'common.white': 'White',
      'common.black': 'Black',
      'common.random': 'Random',
      'common.dash': '-',

      'auth.login': 'Log In',
      'auth.register': 'Sign Up',
      'auth.usernamePlaceholder': 'Username',
      'auth.passwordPlaceholder': 'Password',
      'auth.hint': 'Username must be 3-24 characters, password at least 6 characters.',

      'lobby.quickMatchTitle': 'Quick Match',
      'lobby.findMatch': 'Find a Game',
      'lobby.searchingOpponent': 'Searching for an opponent',
      'lobby.cancelQueue': 'Cancel',
      'lobby.activeGameNotice': 'You have an ongoing game.',
      'lobby.resumeGame': 'Resume Game',
      'lobby.freeAnalysisLink': 'Free Analysis Board (without playing)',
      'lobby.challengeTitle': 'Challenge a Player',
      'lobby.challengeUsernamePlaceholder': 'Username',
      'lobby.challengeColorLabel': 'Your color:',
      'lobby.challengeColorWhite': 'White',
      'lobby.challengeColorBlack': 'Black',
      'lobby.challengeColorRandom': 'Random',
      'lobby.challengeSend': 'Challenge',
      'lobby.challengePendingOutgoing': 'Sent to {username}, waiting for a response...',
      'lobby.challengeCancelBtn': 'Cancel',
      'lobby.challengeIncomingText': '{username} has challenged you — {timeControl}, you will play as {color}.',
      'lobby.challengeDeclinedByTarget': '{username} declined your challenge.',
      'lobby.challengeExpiredOutgoing': 'Your challenge to {username} has expired.',
      'lobby.leaderboardTitle': 'Leaderboard',
      'lobby.recentGamesTitle': 'Your Recent Games',
      'lobby.noGamesYet': 'No games yet.',
      'lobby.thRank': '#',
      'lobby.thUser': 'User',
      'lobby.thRating': 'Rating',
      'lobby.thRecord': 'W/L/D',

      'cat.bullet': 'Bullet',
      'cat.blitz': 'Blitz',
      'cat.rapid': 'Rapid',
      'cat.classical': 'Classical',
      'tc.minutesShort': '{m} min',
      'tc.incrementShort': ' | +{s} sec',

      'result.won': 'You won',
      'result.wonBanner': 'You won!',
      'result.lost': 'You lost',
      'result.draw': 'Draw',
      'result.checkmate': 'Checkmate',
      'result.stalemate': 'Stalemate (draw)',
      'result.insufficientMaterial': 'Insufficient material (draw)',
      'result.resigned': 'Resigned',
      'result.timeout': 'Time out',
      'result.timeoutInsufficientMaterial': 'Time out, but insufficient material (draw)',
      'result.drawAgreed': 'Draw by agreement',
      'result.threefold': 'Threefold repetition (draw)',
      'result.fiftyMove': 'Fifty-move rule (draw)',

      'board.lightSquares': 'Light squares',
      'board.darkSquares': 'Dark squares',
      'board.resetColors': 'Reset to Default',

      'status.loading': 'Loading...',
      'game.drawOfferedByOpponent': 'Your opponent has offered a draw.',
      'game.rematchOfferedByOpponent': 'Your opponent has offered a rematch.',
      'game.offerRematch': 'Offer Rematch',
      'game.rematchPending': 'Offer sent, waiting for opponent...',
      'game.openAnalysis': 'Open Analysis Board',
      'game.offerDraw': 'Offer Draw',
      'game.resign': 'Resign',
      'game.choosePromotion': 'Choose promotion piece',
      'game.confirmResign': 'Are you sure you want to resign?',
      'game.yourTurn': 'Your turn',
      'game.opponentThinking': 'Opponent is thinking...',
      'game.newRatingLine': 'Your new {category} rating: {rating}',

      'analysis.movesHint': 'Game moves (click to jump to that point):',
      'analysis.pvHint': "Engine's suggested line (PV):",
      'analysis.navStart': '|< Start',
      'analysis.navBack': '< Back',
      'analysis.navForward': 'Forward >',
      'analysis.navEnd': 'End >|',
      'analysis.navStartTitle': 'Go to start',
      'analysis.navBackTitle': 'One move back',
      'analysis.navForwardTitle': 'One move forward',
      'analysis.navEndTitle': 'Go to end of game',
      'analysis.flipBoard': 'Flip Board',
      'analysis.evalInitial': 'Evaluation: -',
      'analysis.evalPrefix': 'Evaluation: ',
      'analysis.evalCalculating': 'Evaluation: calculating...',
      'analysis.turnWhite': 'To move: White',
      'analysis.turnBlack': 'To move: Black',
      'analysis.deviatedNote': " — deviated from the book (these moves weren't played in the real game)",
      'analysis.evalGameOverNoMoves': 'the game ends in this position (no moves)',
      'analysis.evalDrawInsufficientMaterial': 'draw (insufficient material)',
      'analysis.whiteMatesIn': 'White mates in #{n}',
      'analysis.blackMatesIn': 'Black mates in #{n}',
      'analysis.whiteAdvantage': 'White is better',
      'analysis.blackAdvantage': 'Black is better',

      'err.unknown': 'Unknown error',
      'err.gameLoadFailedPrefix': "Couldn't load the game: ",
      'err.positionCalcFailedPrefix': "Couldn't compute the position: ",
      'err.evalFailedPrefix': "Couldn't get an evaluation: ",
      'err.analysisOpenFailedPrefix': "Couldn't open analysis: ",

      'err.GAME_NOT_FOUND': 'Game not found.',
      'err.NOT_A_PLAYER': 'You are not a player in this game.',
      'err.GAME_ALREADY_FINISHED': 'The game has already finished.',
      'err.NOT_YOUR_TURN': "It's not your turn.",
      'err.ILLEGAL_MOVE': 'That move is not legal.',
      'err.INVALID_PROMOTION': 'Invalid promotion choice.',
      'err.GAME_NOT_FOUND_OR_FINISHED': 'Game not found, or it has already finished.',
      'err.NO_DRAW_OFFER': 'There is no draw offer to respond to.',
      'err.REMATCH_NOT_AVAILABLE': "A rematch can't be offered for this game.",
      'err.ALREADY_IN_GAME': 'You already have an ongoing game.',
      'err.OPPONENT_IN_GAME': 'Your opponent is currently in another game.',
      'err.NO_REMATCH_OFFER': 'There is no rematch offer to respond to.',
      'err.PLAYER_IN_ANOTHER_GAME': 'One of the players is already in another game.',
      'err.INVALID_TIME_CONTROL': 'Invalid time control.',
      'err.USERNAME_TAKEN': 'That username is already taken.',
      'err.USERNAME_LENGTH': 'Username must be 3-24 characters.',
      'err.USERNAME_INVALID_CHARS': 'Username contains invalid characters.',
      'err.PASSWORD_TOO_SHORT': 'Password must be at least 6 characters.',
      'err.LOGIN_FAILED': 'Incorrect username or password.',
      'err.LOGIN_REQUIRED': 'You need to log in.',
      'err.ANALYSIS_NOT_AVAILABLE_DETAILED': "Analysis isn't available for this game (it may not be finished, or you're not one of its players).",
      'err.ANALYSIS_NOT_AVAILABLE': "Analysis isn't available for this game.",
      'err.ENGINE_POSITION_FAILED': "The engine couldn't compute the position.",
      'err.ENGINE_NOT_RUNNING': "The engine isn't running.",
      'err.NOT_FOUND': 'Not found.',
      'err.INVALID_LANGUAGE': 'Invalid language.',
      'err.BOOK_MOVE_UNDELETABLE': "The game's real move can't be deleted.",
      'err.NODE_NOT_FOUND': 'Move not found.',
      'err.PLAYER_NOT_FOUND': 'No player was found with that username.',
      'err.CANNOT_CHALLENGE_SELF': "You can't challenge yourself.",
      'err.PLAYER_NOT_ONLINE': 'That player is not currently online.',
      'err.INVALID_COLOR_CHOICE': 'Invalid color choice.',
      'err.CHALLENGE_NOT_FOUND': "That challenge isn't valid anymore.",
      'err.CHALLENGE_NOT_YOURS': "You can't respond to that challenge.",
      'err.CHALLENGE_CANCEL_NOT_YOURS': "You can't cancel that challenge.",

      // ---- Variation tree (lichess-style sub-variations) ----
      'analysis.confirmDeleteVariation': 'Delete this variation (and any moves after it)?',
      'analysis.deleteVariationTitle': 'Delete this variation',
      'analysis.pvBoxTitle': 'Apply this line to the board and save it',
    },
  };

  let currentLang = 'tr';

  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value, days) {
    const maxAge = days * 24 * 60 * 60;
    try {
      document.cookie = name + '=' + encodeURIComponent(value) + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax';
    } catch { /* çerezler engelliyse sessizce yoksay */ }
  }

  function t(key, vars) {
    const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.tr;
    let str = dict[key];
    if (str === undefined) str = (TRANSLATIONS.tr[key] !== undefined ? TRANSLATIONS.tr[key] : key);
    if (vars) {
      str = str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
    }
    return str;
  }

  // Sunucudan gelen (errorCode'lu) ya da istemcide oluşan bir hatayı, o anki
  // arayüz diline çevirir. errorCode tanınmıyorsa (kataloglanmamış nadir bir
  // durum) sunucunun ham (Türkçe) mesajını göstermeye devam eder -- bu,
  // önceki davranışla (err.message'ı doğrudan göstermek) TUTARLI bir
  // yedek: Türkçe modda zaten HER ZAMAN doğru, İngilizce modda sadece çok
  // nadir/beklenmeyen bir hata için Türkçe metin görünebilir.
  function tErr(err) {
    const code = err && err.payload && err.payload.errorCode;
    const key = code ? ('err.' + code) : null;
    if (key && TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key] !== undefined) {
      return t(key);
    }
    return (err && err.message) || t('err.unknown');
  }

  function updateLangSwitchUI() {
    document.querySelectorAll('.lang-switch button[data-lang]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-lang') === currentLang);
    });
  }

  function applyStaticTranslations(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
    updateLangSwitchUI();
  }

  function getLang() {
    return currentLang;
  }

  // opts.persist === false -> hesaba KAYDETME (ör. hesaptan gelen tercihi
  // arayüze uygularken tekrar hesaba yazmaya gerek yok -- syncFromAccount).
  // Varsayılan (persist true): kullanıcı düğmeye TIKLADIĞINDA -- hem çereze
  // hem (giriş yapmışsa) hesabına kaydedilir. Giriş yapılmamışsa
  // /api/set-language 401 döner, bunu sessizce yoksayıyoruz (çerez zaten
  // yeterli, giriş yapınca syncFromAccount devreye girer).
  function setLang(lang, opts) {
    opts = opts || {};
    if (lang !== 'tr' && lang !== 'en') return;
    currentLang = lang;
    setCookie(COOKIE_NAME, lang, 365);
    document.documentElement.lang = lang;
    applyStaticTranslations();
    if (opts.persist !== false) {
      fetch('/api/set-language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang }),
      }).catch(() => { /* giriş yapılmamışsa ya da ağ hatasında sessizce yoksay */ });
    }
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }

  // Giriş/kayıt/me cevabından gelen HESAP tercihini uygular -- hesap,
  // giriş yapıldıktan sonra çerezden ÖNCELİKLİDİR (bkz. dosya başındaki not).
  function syncFromAccount(lang) {
    if (lang !== 'tr' && lang !== 'en') return;
    if (lang !== currentLang) setLang(lang, { persist: false });
  }

  function initLang() {
    const cookieLang = getCookie(COOKIE_NAME);
    currentLang = (cookieLang === 'en') ? 'en' : 'tr';
    document.documentElement.lang = currentLang;
    applyStaticTranslations();
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.lang-switch button[data-lang]');
      if (btn) setLang(btn.getAttribute('data-lang'));
    });
  }

  initLang();

  window.I18N = { t, tErr, setLang, getLang, applyStaticTranslations, syncFromAccount };
})();
