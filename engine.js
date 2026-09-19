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
