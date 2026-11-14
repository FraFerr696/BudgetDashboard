/*
 * LocalDB — SQLite sul dispositivo (sql.js / WebAssembly).
 *
 * L'intero DB vive in memoria (budget.db è ~200 KB) e dopo ogni scrittura
 * viene salvato su disco in modo atomico. Il file salvato è un normale
 * file SQLite: è lo stesso che oggi sta in data/budget.db sul Pi, quindi
 * import, export e backup sono semplici copie di byte.
 *
 * Storage:
 *   - app Android (Capacitor): plugin Filesystem, Directory.Data (privata dell'app)
 *   - browser (test/sviluppo): IndexedDB
 *   - memoria: per i test automatici
 *
 * Uso:
 *   await LocalDB.open({ storage: 'auto', locateFile: f => '/vendor/' + f });
 *   LocalDB.all(sql, params)  -> [{col: val, ...}]
 *   LocalDB.get(sql, params)  -> {..} | undefined
 *   await LocalDB.write(() => { LocalDB.run(...); ... })   // transazione + salvataggio
 *   LocalDB.exportBytes()     -> Uint8Array
 *   await LocalDB.importBytes(uint8array)
 */
(function (global) {
  'use strict';

  const FILE = 'budget.db';
  const TMP = 'budget.db.tmp';
  const PREV = 'budget.before-import.db';
  const REQUIRED_TABLES = ['transactions', 'categories', 'account_balances'];

  // ── Base64 <-> bytes ───────────────────────────────────────────────
  function bytesToB64(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // ── Storage backends ───────────────────────────────────────────────
  // Interfaccia: read(name) -> Uint8Array|null, write(name, bytes), remove(name)

  function capacitorStorage() {
    const FS = global.Capacitor.Plugins.Filesystem;
    const DIR = 'DATA';
    return {
      name: 'capacitor',
      async read(name) {
        try {
          const r = await FS.readFile({ path: name, directory: DIR });
          return typeof r.data === 'string' ? b64ToBytes(r.data) : new Uint8Array(await r.data.arrayBuffer());
        } catch (e) { return null; }
      },
      async write(name, bytes) {
        await FS.writeFile({ path: name, directory: DIR, data: bytesToB64(bytes), recursive: true });
      },
      async remove(name) {
        try { await FS.deleteFile({ path: name, directory: DIR }); } catch (e) { /* non esiste */ }
      },
    };
  }

  function idbStorage() {
    const DBNAME = 'budget-local';
    const STORE = 'files';
    function idb() {
      return new Promise((res, rej) => {
        const req = indexedDB.open(DBNAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    }
    async function op(mode, fn) {
      const db = await idb();
      return new Promise((res, rej) => {
        const tx = db.transaction(STORE, mode);
        const r = fn(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); res(r && r.result); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      });
    }
    return {
      name: 'indexeddb',
      async read(name) { const v = await op('readonly', s => s.get(name)); return v ? new Uint8Array(v) : null; },
      async write(name, bytes) { await op('readwrite', s => s.put(bytes.slice().buffer, name)); },
      async remove(name) { await op('readwrite', s => s.delete(name)); },
    };
  }

  function memoryStorage() {
    const files = new Map();
    return {
      name: 'memory',
      async read(name) { return files.has(name) ? files.get(name).slice() : null; },
      async write(name, bytes) { files.set(name, bytes.slice()); },
      async remove(name) { files.delete(name); },
    };
  }

  function pickStorage(kind) {
    if (kind && typeof kind === 'object') return kind;
    if (kind === 'memory') return memoryStorage();
    if (kind === 'indexeddb') return idbStorage();
    if (kind === 'capacitor') return capacitorStorage();
    const cap = global.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Filesystem) {
      return capacitorStorage();
    }
    return global.indexedDB ? idbStorage() : memoryStorage();
  }

  // ── Schema: equivalente degli script upgrade_db*.py ────────────────
  // Idempotente. Aggiunge solo ciò che manca, non tocca i dati.
  function ensureSchema(db) {
    const cols = (table) => {
      const r = db.exec(`PRAGMA table_info(${table})`);
      return r.length ? r[0].values.map(v => v[1]) : [];
    };
    const has = (table) => db.exec(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${table}'`
    ).length > 0;

    if (has('transactions') && !cols('transactions').includes('status')) {
      db.run(`ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)`);
    }
    db.run(`CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT 'ETF',
      shares REAL NOT NULL,
      avg_price REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      opened_at TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      isin TEXT DEFAULT ''
    )`);
    if (!cols('holdings').includes('isin')) {
      db.run(`ALTER TABLE holdings ADD COLUMN isin TEXT DEFAULT ''`);
    }
    db.run(`CREATE TABLE IF NOT EXISTS portfolio_valuations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      market_price REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(ticker, date)
    )`);
  }

  function validate(SQL, bytes) {
    let db;
    try {
      db = new SQL.Database(bytes);
      const ok = db.exec('PRAGMA integrity_check')[0].values[0][0];
      if (String(ok).toLowerCase() !== 'ok') throw new Error('integrity_check: ' + ok);
      for (const t of REQUIRED_TABLES) {
        const r = db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'`);
        if (!r.length) throw new Error(`tabella '${t}' mancante`);
      }
      ensureSchema(db);
      return db;
    } catch (e) {
      if (db) db.close();
      throw new Error('File non valido come database del budget: ' + e.message);
    }
  }

  // ── Stato ──────────────────────────────────────────────────────────
  let SQL = null;
  let db = null;
  let storage = null;
  let saveChain = Promise.resolve();
  let openPromise = null;
  const listeners = new Set();

  function notify(event) { listeners.forEach(fn => { try { fn(event); } catch (e) { /* ignore */ } }); }

  function requireDb() {
    if (!db) {
      const e = new Error('Nessun database sul dispositivo: importa budget.db');
      e.status = 503;
      throw e;
    }
    return db;
  }

  function bindable(params) {
    return (params || []).map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }

  async function persistNow() {
    const bytes = db.export();
    // Scrittura atomica: tmp -> (cancella vecchio) -> file definitivo.
    // Se l'app muore a metà, al prossimo avvio si recupera dal tmp.
    await storage.write(TMP, bytes);
    await storage.write(FILE, bytes);
    await storage.remove(TMP);
    notify({ type: 'saved', size: bytes.length, at: new Date() });
  }

  function persist() {
    saveChain = saveChain.catch(() => {}).then(persistNow);
    return saveChain;
  }

  const LocalDB = {
    /**
     * opts.SQL          — modulo sql.js già inizializzato, o Promise (opzionale)
     * opts.locateFile   — per initSqlJs, dove trovare sql-wasm.wasm
     * opts.storage      — 'auto' | 'capacitor' | 'indexeddb' | 'memory' | oggetto custom
     */
    open(opts = {}) {
      if (openPromise) return openPromise;
      openPromise = (async () => {
        // opts.SQL può essere il modulo o una Promise del modulo
        SQL = opts.SQL ? await opts.SQL : await global.initSqlJs({ locateFile: opts.locateFile || (f => f) });
        storage = pickStorage(opts.storage || 'auto');
        // FILE è quello buono; se manca o è troncato (crash durante il
        // salvataggio) si usa TMP, che in quel momento era già completo.
        let lastErr = null;
        for (const name of [FILE, TMP]) {
          const bytes = await storage.read(name);
          if (!bytes) continue;
          try { db = validate(SQL, bytes); break; } catch (e) { lastErr = e; }
        }
        if (!db && lastErr) throw lastErr;
        notify({ type: 'opened', hasData: !!db, storage: storage.name });
        return LocalDB;
      })();
      openPromise.catch(() => { openPromise = null; });
      return openPromise;
    },

    ready() {
      return openPromise || Promise.reject(Object.assign(new Error('LocalDB non aperto'), { status: 503 }));
    },

    get hasData() { return !!db; },
    get storageName() { return storage ? storage.name : null; },

    all(sql, params) {
      const stmt = requireDb().prepare(sql);
      try {
        stmt.bind(bindable(params));
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally { stmt.free(); }
    },

    get(sql, params) { return LocalDB.all(sql, params)[0]; },

    /** Primo valore della prima riga (come fetchone()[0]). */
    scalar(sql, params) {
      const stmt = requireDb().prepare(sql);
      try {
        stmt.bind(bindable(params));
        return stmt.step() ? stmt.get()[0] : undefined;
      } finally { stmt.free(); }
    },

    run(sql, params) {
      const d = requireDb();
      d.run(sql, bindable(params));
      return {
        changes: d.getRowsModified(),
        lastId: d.exec('SELECT last_insert_rowid()')[0].values[0][0],
      };
    },

    /** Esegue fn in una transazione; se va a buon fine salva su disco. */
    async write(fn) {
      const d = requireDb();
      d.run('BEGIN');
      let result;
      try {
        result = fn();
        d.run('COMMIT');
      } catch (e) {
        try { d.run('ROLLBACK'); } catch (_) { /* già chiusa */ }
        throw e;
      }
      await persist();
      return result;
    },

    exportBytes() { return requireDb().export(); },

    /** Sostituisce il DB con un file .db (es. copiato dal Pi). Tiene una copia del precedente. */
    async importBytes(bytes) {
      if (!SQL) throw new Error('LocalDB non aperto');
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const next = validate(SQL, u8);
      await saveChain.catch(() => {});
      if (db) {
        await storage.write(PREV, db.export());
        db.close();
      }
      db = next;
      await persist();
      notify({ type: 'imported' });
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** File accessori accanto al DB (es. settings.json). */
    async readAux(name) {
      if (!storage) throw new Error('LocalDB non aperto');
      return storage.read(name);
    },
    async writeAux(name, bytes) {
      if (!storage) throw new Error('LocalDB non aperto');
      await storage.write(name, bytes);
    },

    // esposti per i test
    _ensureSchema: ensureSchema,
    _b64: { bytesToB64, b64ToBytes },
  };

  global.LocalDB = LocalDB;
})(typeof window !== 'undefined' ? window : globalThis);
