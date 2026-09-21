// lib/engine.js
//
// Fairy-Stockfish için basit bir UCI sarmalayıcı — masaüstü uygulamasındaki
// UciEngine.cs'in Node.js karşılığı. AYNI TASARIM İLKESİ geçerli: hamle
// yasallığını (roklanma, terfi, mat/pat dahil) İKİNCİ BİR KURAL MOTORU
// YAZARAK kontrol ETMİYORUZ — motorun kendisine soruyoruz ("go perft 1" ile
// yasal hamleler, "d" ile FEN). Bu, iki ayrı kural uygulamasının (bizim kod +
// motor) birbirinden sapma riskini ortadan kaldırıyor.
//
// ÖNEMLİ: Bu motor SADECE hamle doğrulaması ve pozisyon (FEN) hesaplaması
// için kullanılıyor — canlı oyun sırasında OYUNCULARA asla bir değerlendirme
// (eval) ya da en iyi hamle göstermiyoruz (masaüstü uygulamasındaki "oyun
// sırasında motora erişim yasak" ilkesiyle birebir aynı). Analiz (eval/PV),
// sadece oyun bittikten sonra, ayrı bir uç noktada devreye girecek.
//
// Motor tek bir süreç olarak başlatılıp İSTEKLER SIRAYLA (kuyruğa alınarak)
// işleniyor — aynı anda birden fazla "position"/"go" komutu göndermek
// sonuçların birbirine karışmasına yol açar, bu yüzden basit bir kuyruk
// (queue) ile her seferinde tek bir isteğin işlenmesini garanti ediyoruz.

const { spawn } = require('child_process');

class Engine {
  constructor(enginePath, variantsPath, variantName) {
    this.enginePath = enginePath;
    this.variantsPath = variantsPath;
    this.variantName = variantName;
    this.proc = null;
    this.buffer = '';
    this.queue = [];
    this.busy = false;
    this.ready = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.enginePath, [], { cwd: require('path').dirname(this.enginePath) });

      this.proc.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString();
        this._maybeResolveCurrent();
      });
      this.proc.stderr.on('data', () => { /* motorun stderr çıktısı önemli değil */ });
      this.proc.on('error', (err) => {
        if (!this.ready) reject(err);
      });
      this.proc.on('exit', () => {
        this.proc = null;
      });

      this._send('uci');
      this._waitFor('uciok', 5000)
        .then(() => {
          if (this.variantsPath) this._send(`setoption name VariantPath value ${this.variantsPath}`);
          if (this.variantName) this._send(`setoption name UCI_Variant value ${this.variantName}`);
          this._send('isready');
          return this._waitFor('readyok', 5000);
        })
        .then(() => {
          this.ready = true;
          resolve();
        })
        .catch(reject);
    });
  }

  _send(cmd) {
    if (!this.proc) throw new Error('Motor çalışmıyor.');
    this.proc.stdin.write(cmd + '\n');
  }

  // Belirtilen token (ör. "uciok") buffer'da görünene kadar bekler (yalnızca
  // ilk el sıkışma sırasında kullanılır, kuyruk henüz devrede değilken).
  _waitFor(token, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (this.buffer.includes(token)) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`Zaman aşımı: "${token}" beklenirken`));
        setTimeout(check, 15);
      };
      check();
    });
  }

  // Kuyruğa bir görev ekler: { send: () => void, matcher: (buffer) => result|null, timeoutMs }
  // matcher, buffer'ı her data geldiğinde kontrol eder; null dönerse beklemeye
  // devam eder, bir değer dönerse görev o değerle tamamlanır.
  _enqueue(send, matcher, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      this.queue.push({ send, matcher, resolve, reject, timeoutMs });
      this._pump();
    });
  }

  _pump() {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    this.buffer = '';
    const task = this.queue.shift();
    this._currentTask = task;
    task._start = Date.now();
    task._timer = setTimeout(() => {
      if (this._currentTask === task) {
        this._currentTask = null;
        this.busy = false;
        task.reject(new Error('Motor zaman aşımına uğradı.'));
        this._pump();
      }
    }, task.timeoutMs);
    try {
      task.send();
    } catch (err) {
      clearTimeout(task._timer);
      this._currentTask = null;
      this.busy = false;
      task.reject(err);
      this._pump();
    }
  }

  _maybeResolveCurrent() {
    const task = this._currentTask;
    if (!task) return;
    let result;
    try {
      result = task.matcher(this.buffer);
    } catch (err) {
      clearTimeout(task._timer);
      this._currentTask = null;
      this.busy = false;
      task.reject(err);
      this._pump();
      return;
    }
    if (result !== null && result !== undefined) {
      clearTimeout(task._timer);
      this._currentTask = null;
      this.busy = false;
      task.resolve(result);
      this._pump();
    }
  }

  // Verilen başlangıç FEN'i + üzerine oynanan UCI hamle listesinden sonucu
  // ortaya çıkan pozisyonun FEN'ini döndürür (motorun kendisine hesaplattırarak).
  getFenAfterMoves(baseFen, moves) {
    const movesPart = moves && moves.length ? ' moves ' + moves.join(' ') : '';
    return this._enqueue(
      () => {
        this._send(`position fen ${baseFen}${movesPart}`);
        this._send('d');
      },
      (buf) => {
        const m = buf.match(/Fen:\s*(.+)\r?\n/);
        return m ? m[1].trim() : null;
      }
    );
  }

  // Verilen pozisyondaki TÜM yasal hamleleri UCI gösterimiyle döndürür.
  getLegalMoves(fen) {
    return this._enqueue(
      () => {
        this._send(`position fen ${fen}`);
        this._send('go perft 1');
      },
      (buf) => {
        if (!buf.includes('Nodes searched')) return null;
        const moves = [];
        const lines = buf.split(/\r?\n/);
        for (const line of lines) {
          const m = line.match(/^([a-h]\d[a-h]\d[qrbn]?):\s*\d+$/);
          if (m) moves.push(m[1]);
        }
        return moves;
      }
    );
  }

  // Verilen pozisyonda sırası gelen taraf şah çekiliyor mu? (Mat/pat ayrımı
  // için: yasal hamle yoksa VE şah çekiliyorsa mat, çekilmiyorsa pat.)
  isInCheck(fen) {
    return this._enqueue(
      () => {
        this._send(`position fen ${fen}`);
        this._send('d');
      },
      (buf) => {
        // Satırın TAMAMEN geldiğinden emin olmak için sonunda bir satır sonu
        // arıyoruz — yoksa "Checkers:" yazısı gelip henüz arkasındaki kare
        // (varsa) gelmeden yanlışlıkla "şah çekilmiyor" sonucuna varabiliriz.
        const m = buf.match(/Checkers:\s*(.*)\r?\n/);
        if (m === null) return null; // henüz "d" çıktısı tamamlanmadı
        return m[1].trim().length > 0;
      }
    );
  }

  // FAZ 2: Verilen pozisyonu belirtilen süre (ms) kadar analiz eder; en iyi
  // hamleyi, skoru (santipiyon ya da mat) ve önerilen varyantı (PV) döndürür.
  // Masaüstü uygulamasındaki UciEngine.Analyze() ile AYNI ayrıştırma mantığı —
  // sadece burada senkron bekleme (Thread.Sleep) yerine bu sınıfın zaten
  // sahip olduğu kuyruk/matcher mekanizması kullanılıyor.
  //
  // ÖNEMLİ: Bu metot SADECE analiz uç noktalarından çağrılıyor — canlı oyun
  // hamlelerinin yasallığı asla buna bağlı değil. Ayrıca server.js'de bu iş
  // için CANLI OYUN motorundan tamamen AYRI, ikinci bir motor süreci
  // kullanılıyor; böylece uzun bir analiz isteği, o sırada oynanan başka
  // canlı oyunların hamle kuyruğunu bekletmiyor.
  analyze(fen, movetimeMs) {
    return this._enqueue(
      () => {
        this._send(`position fen ${fen}`);
        this._send(`go movetime ${movetimeMs}`);
      },
      (buf) => {
        if (!buf.includes('bestmove')) return null;
        const lines = buf.split(/\r?\n/);
        let bestMove = null;
        let scoreCp = null;
        let scoreMate = null;
        let pv = [];
        for (const line of lines) {
          if (line.startsWith('info') && line.includes(' score ')) {
            const parts = line.split(' ');
            for (let i = 0; i < parts.length; i++) {
              if (parts[i] === 'cp' && i + 1 < parts.length && /^-?\d+$/.test(parts[i + 1])) {
                scoreCp = parseInt(parts[i + 1], 10);
                scoreMate = null;
              } else if (parts[i] === 'mate' && i + 1 < parts.length && /^-?\d+$/.test(parts[i + 1])) {
                scoreMate = parseInt(parts[i + 1], 10);
                scoreCp = null;
              } else if (parts[i] === 'pv') {
                pv = parts.slice(i + 1);
              }
            }
          } else if (line.startsWith('bestmove')) {
            const parts = line.split(' ');
            if (parts.length > 1) bestMove = parts[1];
          }
        }
        if (!bestMove) return null;
        return { bestMove, scoreCp, scoreMate, pv };
      },
      movetimeMs + 5000
    );
  }

  // Bir "info" satırındaki skor (cp/mate) ve PV'yi ayrıştırır — sadece TEK
  // bir satır için (analyzeProgressive'in ARA kontrol noktalarında, arama
  // henüz bitmemişken buffer'daki EN SON "info ... pv ..." satırını okumak
  // için kullanılıyor; "bestmove" satırının gelmesini BEKLEMİYOR).
  _parseLatestInfo(buf) {
    const lines = buf.split(/\r?\n/);
    let scoreCp = null, scoreMate = null, pv = [];
    let found = false;
    for (const line of lines) {
      if (line.startsWith('info') && line.includes(' score ') && line.includes(' pv ')) {
        const parts = line.split(' ');
        let lineCp = null, lineMate = null, linePv = [];
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === 'cp' && i + 1 < parts.length && /^-?\d+$/.test(parts[i + 1])) {
            lineCp = parseInt(parts[i + 1], 10);
            lineMate = null;
          } else if (parts[i] === 'mate' && i + 1 < parts.length && /^-?\d+$/.test(parts[i + 1])) {
            lineMate = parseInt(parts[i + 1], 10);
            lineCp = null;
          } else if (parts[i] === 'pv') {
            linePv = parts.slice(i + 1);
          }
        }
        // Buffer'da BİRDEN FAZLA "info" satırı olabilir (arama derinleştikçe
        // motor her yeni derinlikte YENİ bir satır yazıyor) -- döngü sona
        // kadar devam ettiği için burada en SON (en derin) satır kazanıyor.
        if (linePv.length) { scoreCp = lineCp; scoreMate = lineMate; pv = linePv; found = true; }
      }
    }
    if (!found || pv.length === 0) return null;
    // "bestMove" burada henüz GERÇEK değil (motor durmadı) -- şu ana kadarki
    // en iyi varyantın İLK hamlesini geçici "en iyi hamle" olarak kullanıyoruz.
    return { bestMove: pv[0], scoreCp, scoreMate, pv };
  }

  // FAZ 3: Motoru KESİNTİYE UĞRATMADAN (yeniden başlatmadan) giderek daha
  // uzun süre düşündürüp, verilen ARA kontrol noktalarında (checkpointsMs,
  // toplam süreye göre MUTLAK milisaniye değerleri, ör. [1000,3000,5000,7000])
  // o ana kadar bulduğu en iyi hamle/skor/varyantı onCheckpoint callback'i
  // ile bildirir. totalMs sonunda motor KENDİLİĞİNDEN durur ("go movetime")
  // ve NİHAİ sonuç promise ile (analyze()'daki ile AYNI şekilde) döner.
  //
  // WinForms masaüstü uygulamasındaki davranışla aynı fikir: motor TEK bir
  // kesintisiz arama yapar (iteratif derinleşme sırasında zaten giderek daha
  // iyi hamleler buluyor); biz sadece belirli anlarda "şu ana kadar ne
  // buldun" diye çıktısını okuyoruz -- yeniden ("sıfırdan") aramaya asla
  // başlamıyoruz.
  //
  // Döndürülen { token, promise }: token, bu görev tamamlanmadan önce ERKEN
  // KESMEK (cancelTask) için kullanılıyor -- örn. istemci başka bir
  // pozisyona geçtiğinde, sunucunun 9 saniye boyunca artık kimsenin
  // beklemediği bir hesaplamayla motoru MEŞGUL ETMEMESİ için.
  analyzeProgressive(fen, checkpointsMs, totalMs, onCheckpoint) {
    const token = Symbol('analyzeProgressive');
    const promise = new Promise((resolve, reject) => {
      const task = {
        token,
        timeoutMs: totalMs + 5000,
        send: () => {
          this._send(`position fen ${fen}`);
          this._send(`go movetime ${totalMs}`);
          const capturedTask = this._currentTask;
          let idx = 0;
          const fireNext = () => {
            if (idx >= checkpointsMs.length) return;
            // Görev, biz beklerken zaten bitmiş/iptal edilmiş olabilir
            // (örn. cancelTask ile erken durduruldu) -- bu durumda daha
            // fazla checkpoint ateşlemeyi durduruyoruz.
            if (this._currentTask !== capturedTask) return;
            const targetMs = checkpointsMs[idx];
            const elapsedSoFar = Date.now() - capturedTask._start;
            const delay = Math.max(0, targetMs - elapsedSoFar);
            setTimeout(() => {
              if (this._currentTask !== capturedTask) return;
              const partial = this._parseLatestInfo(this.buffer);
              if (partial) {
                try { onCheckpoint(partial, targetMs); } catch { /* çağıranın hatası bizi etkilemesin */ }
              }
              idx++;
              fireNext();
            }, delay);
          };
          fireNext();
        },
        matcher: (buf) => {
          if (!buf.includes('bestmove')) return null;
          const latest = this._parseLatestInfo(buf);
          const lines = buf.split(/\r?\n/);
          let bestMove = null;
          for (const line of lines) {
            if (line.startsWith('bestmove')) {
              const parts = line.split(' ');
              if (parts.length > 1) bestMove = parts[1];
            }
          }
          if (!bestMove) return null;
          return {
            bestMove,
            scoreCp: latest ? latest.scoreCp : null,
            scoreMate: latest ? latest.scoreMate : null,
            pv: latest ? latest.pv : [],
          };
        },
        resolve,
        reject,
      };
      this.queue.push(task);
      this._pump();
    });
    return { token, promise };
  }

  // analyzeProgressive ile başlatılmış bir görevi ERKEN sonlandırır:
  // - Kuyrukta hâlâ SIRASINI BEKLİYORSA doğrudan kuyruktan çıkarıp reddeder
  //   (motor bu görevle hiç MEŞGUL OLMADI, kuyruk hemen bir sonrakine geçer).
  // - Şu an ÇALIŞIYORSA motora 'stop' gönderir -- motor kısa sürede (şu ana
  //   kadar bulduğu en iyi hamleyle) normal 'bestmove' akışını tamamlar ve
  //   kuyruk BİR SONRAKİ isteğe geçebilir. (Bu, görevin promise'ini
  //   REDDETMEZ -- sadece daha ERKEN, daha sığ bir sonuçla tamamlanmasını
  //   sağlar; çağıran taraf zaten sonucu beklemekten vazgeçmiş olabilir, bu
  //   durumda o sonuç sadece göz ardı edilir.)
  // Döner: true (bir şey iptal/kesildi) ya da false (token bulunamadı --
  // görev zaten bitmiş olabilir).
  cancelTask(token) {
    const idx = this.queue.findIndex(t => t.token === token);
    if (idx !== -1) {
      const [removed] = this.queue.splice(idx, 1);
      removed.reject(new Error('İstek iptal edildi (kuyruktan çıkarıldı).'));
      return true;
    }
    if (this._currentTask && this._currentTask.token === token) {
      this._send('stop');
      return true;
    }
    return false;
  }

  quit() {
    try {
      if (this.proc) {
        this._send('quit');
        setTimeout(() => { if (this.proc) this.proc.kill(); }, 1000);
      }
    } catch { /* kapanırken oluşan hatalar önemli değil */ }
  }
}

module.exports = { Engine };
