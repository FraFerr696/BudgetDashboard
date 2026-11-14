/*
 * Avvio della modalità locale (app Android Capacitor).
 *
 * Viene inserito nelle pagine SOLO dalla build dell'app
 * (mobile/scripts/build-www.mjs), subito prima di </head>, dopo
 * local-db.js e local-api.js. La versione web servita dal Pi non lo carica.
 *
 * Cosa fa:
 *   - intercetta fetch('/api/...') e la serve dal DB sul telefono
 *   - apre il DB; se non c'è, mostra la schermata "Importa budget.db"
 *   - aggiunge alla sidebar il pulsante "Dati" (export/import del .db)
 *   - "Esporta" genera l'Excel sul telefono e lo apre nel menu Condividi
 *   - niente service worker: l'app ha già tutti i file in locale
 *
 * Per provarlo nel browser del PC: cd mobile && npm run serve
 */
(function () {
  'use strict';

  const cap = window.Capacitor;
  const NATIVE = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const Plugins = (cap && cap.Plugins) || {};

  // ── 1. API locale, subito (prima degli script delle pagine) ─────────
  LocalApi.install();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Impossibile caricare ' + src));
      document.head.appendChild(s);
    });
  }

  const opened = LocalDB.open({
    SQL: loadScript('/vendor/sql-wasm.js').then(() => window.initSqlJs({ locateFile: f => '/vendor/' + f })),
    storage: NATIVE ? 'capacitor' : 'indexeddb',
  });

  // ── 2. Niente service worker nell'app ──────────────────────────────
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.register = () => Promise.resolve();
      navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // ── Utilità ────────────────────────────────────────────────────────
  function stamp() {
    const d = new Date();
    const p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** Salva un file: sul telefono apre il menu Condividi, nel browser lo scarica. */
  async function saveFile(name, bytes, mime) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (NATIVE && Plugins.Filesystem && Plugins.Share) {
      const { uri } = await Plugins.Filesystem.writeFile({
        path: name, directory: 'CACHE', data: LocalDB._b64.bytesToB64(u8), recursive: true,
      });
      await Plugins.Share.share({ title: name, files: [uri] });
      return;
    }
    const url = URL.createObjectURL(new Blob([u8], { type: mime }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function toast(msg, isError) {
    // usa il toast della pagina se c'è
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = msg;
      t.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => { t.className = 'toast'; }, 3500);
    } else {
      alert(msg);
    }
  }

  async function exportExcel() {
    try {
      if (!window.XLSX) await loadScript('/vendor/xlsx.full.min.js');
      const res = await fetch('/api/export');
      if (!res.ok) throw new Error((await res.json()).detail || 'Errore export');
      await saveFile(`BudgetExport_${stamp()}.xlsx`, await res.arrayBuffer(),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (e) {
      if (!/cancel/i.test(e.message)) toast('❌ ' + e.message, true);
    }
  }

  async function exportDb() {
    try {
      await saveFile(`budget_${stamp()}.db`, LocalDB.exportBytes(), 'application/x-sqlite3');
    } catch (e) {
      if (!/cancel/i.test(e.message)) toast('❌ ' + e.message, true);
    }
  }

  function pickFile() {
    return new Promise(resolve => {
      const input = Object.assign(document.createElement('input'), { type: 'file' });
      input.style.display = 'none';
      input.onchange = () => { resolve(input.files[0] || null); input.remove(); };
      document.body.appendChild(input);
      input.click();
    });
  }

  async function importDb(confirmOverwrite) {
    const file = await pickFile();
    if (!file) return false;
    if (confirmOverwrite && !confirm(
      `Sostituire i dati sul telefono con "${file.name}"?\n\nUna copia dei dati attuali resta salvata sul telefono.`)) return false;
    try {
      await LocalDB.importBytes(new Uint8Array(await file.arrayBuffer()));
      location.reload();
      return true;
    } catch (e) {
      alert('❌ ' + e.message);
      return false;
    }
  }

  // ── Backup verso il Pi ─────────────────────────────────────────────
  // Il Pi (NODE_ROLE=mirror) riceve l'intero DB su POST /api/backup-upload.
  // Automatico: 30 s dopo l'ultima modifica, quando l'app va in background,
  // all'avvio se ci sono modifiche non salvate; se il Pi non risponde,
  // riprova dopo 5 minuti. Impostazioni in settings.json accanto al DB.
  const SETTINGS_FILE = 'settings.json';
  const DEFAULT_PI_URL = 'https://raspberrypi.taile176fd.ts.net:8443';
  const AUTO_DELAY = 30 * 1000;
  const RETRY_DELAY = 5 * 60 * 1000;
  const MAX_AGE = 24 * 60 * 60 * 1000;

  const backup = {
    settings: { piUrl: '', token: '', lastOkAt: null, lastError: null, lastAttemptAt: null, dirty: false },
    running: null,
    timer: null,
    changes: 0,

    configured() { return !!(this.settings.piUrl && this.settings.token); },

    async load() {
      try {
        const b = await LocalDB.readAux(SETTINGS_FILE);
        if (b) Object.assign(this.settings, JSON.parse(new TextDecoder().decode(b)));
      } catch (e) { console.warn('[backup] impostazioni illeggibili', e); }
    },
    async save() {
      await LocalDB.writeAux(SETTINGS_FILE, new TextEncoder().encode(JSON.stringify(this.settings)));
    },

    schedule(ms) {
      clearTimeout(this.timer);
      if (!this.configured()) return;
      this.timer = setTimeout(() => this.run({ auto: true }).catch(() => {}), ms);
    },

    markDirty() {
      this.changes++;
      if (!this.settings.dirty) { this.settings.dirty = true; this.save().catch(() => {}); }
      this.schedule(AUTO_DELAY);
      renderBackupStatus();
    },

    /** Manda il DB al Pi. drive=true: il Pi lo carica anche su Google Drive. */
    run({ drive = false, auto = false } = {}) {
      if (!this.configured()) return Promise.reject(new Error('Backup sul Pi non configurato'));
      if (this.running) return this.running;
      clearTimeout(this.timer);
      const changesAtStart = this.changes;
      const s = this.settings;
      this.running = (async () => {
        s.lastAttemptAt = new Date().toISOString();
        renderBackupStatus('in corso…');
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), drive ? 180000 : 30000);
        try {
          const url = s.piUrl.replace(/\/+$/, '') + '/api/backup-upload' + (drive ? '?drive=1' : '');
          const res = await LocalApi.realFetch(url, {
            method: 'POST',
            headers: { 'X-Backup-Token': s.token, 'Content-Type': 'application/octet-stream' },
            body: LocalDB.exportBytes(),
            signal: ctrl.signal,
          });
          let data = {};
          try { data = await res.json(); } catch (e) { /* risposta non JSON */ }
          if (!res.ok) throw new Error(data.detail || `Errore HTTP ${res.status}`);
          s.lastOkAt = new Date().toISOString();
          s.lastError = null;
          if (this.changes === changesAtStart) s.dirty = false;
          const n = `${data.transactions} transazioni`;
          if (drive && data.drive_error) {
            return { status: 'ok', message: `Backup sul Pi completato (${n}), ma Drive non è riuscito: ${data.drive_error}` };
          }
          const where = drive && data.drive ? 'sul Pi e su Google Drive' : 'sul Pi';
          return { status: 'ok', message: `Backup completato ${where} (${n})` };
        } catch (e) {
          s.lastError = e.name === 'AbortError' ? 'Timeout: il Pi non risponde'
            : /fetch|network/i.test(e.message) ? 'Pi non raggiungibile (Tailscale attivo?)'
            : e.message;
          if (auto && s.dirty) this.schedule(RETRY_DELAY);
          throw new Error(s.lastError);
        } finally {
          clearTimeout(timeout);
          this.running = null;
          await this.save().catch(() => {});
          renderBackupStatus();
        }
      })();
      return this.running;
    },

    start() {
      LocalDB.onChange(ev => { if (ev.type === 'saved' || ev.type === 'imported') this.markDirty(); });
      document.addEventListener('visibilitychange', () => {
        if (!this.configured()) return;
        if (document.visibilityState === 'hidden' && this.settings.dirty) this.run({ auto: true }).catch(() => {});
        if (document.visibilityState === 'visible' && this.settings.dirty) this.schedule(3000);
      });
      const s = this.settings;
      const stale = !s.lastOkAt || Date.now() - new Date(s.lastOkAt).getTime() > MAX_AGE;
      if (this.configured() && (s.dirty || stale)) this.schedule(5000);
    },
  };

  // Registrato subito (prima degli script delle pagine), così node-role
  // aspetta che le impostazioni siano lette.
  const backupLoaded = opened.then(() => backup.load());
  LocalApi.setBackupHandler({ ready: backupLoaded, configured: () => backup.configured(), run: (o) => backup.run(o) });

  function fmtWhen(iso) {
    if (!iso) return 'mai';
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? `oggi ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
      : d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function renderBackupStatus(override) {
    const el = document.getElementById('lb-backup-status');
    if (!el) return;
    const s = backup.settings;
    let html;
    if (!backup.configured()) html = '<span class="lb-muted">Non configurato</span>';
    else if (override) html = `⏳ ${override}`;
    else if (s.lastError) html = `<span class="lb-warn">⚠️ ${escapeHtml(s.lastError)}</span><br><span class="lb-muted">ultimo riuscito: ${fmtWhen(s.lastOkAt)}</span>`;
    else html = `✅ ${fmtWhen(s.lastOkAt)}`;
    if (backup.configured() && !override) {
      html += `<br><span class="lb-muted">${s.dirty ? 'Modifiche non ancora sul Pi' : 'Tutto salvato sul Pi'}</span>`;
    }
    el.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showBackupSettings() {
    const s = backup.settings;
    const o = overlay(`
      <h2>⚙️ Backup sul Pi</h2>
      <p>Il telefono manda il database al Pi (in modalità <code>mirror</code>) via Tailscale. Il Pi lo usa per la dashboard web in sola lettura e lo salva su Drive.</p>
      <label class="lb-label">Indirizzo del Pi
        <input class="lb-input" id="lb-url" type="url" autocomplete="off" placeholder="${DEFAULT_PI_URL}">
      </label>
      <label class="lb-label">Token (BACKUP_TOKEN nel .env del Pi)
        <input class="lb-input" id="lb-token" type="password" autocomplete="off">
      </label>
      <p class="lb-error" id="lb-msg"></p>
      <button class="lb-btn primary" id="lb-save">Salva e prova</button>
      ${backup.configured() ? '<button class="lb-btn" id="lb-off">Disattiva backup</button>' : ''}
      <button class="lb-btn ghost" id="lb-cancel">Annulla</button>
    `);
    o.querySelector('#lb-url').value = s.piUrl || DEFAULT_PI_URL;
    o.querySelector('#lb-token').value = s.token || '';
    const msg = o.querySelector('#lb-msg');
    o.querySelector('#lb-cancel').onclick = () => o.remove();
    const off = o.querySelector('#lb-off');
    if (off) off.onclick = async () => {
      if (!confirm('Disattivare il backup automatico sul Pi?')) return;
      s.token = ''; s.lastError = null;
      await backup.save(); o.remove(); renderBackupStatus();
    };
    o.querySelector('#lb-save').onclick = async (ev) => {
      const url = o.querySelector('#lb-url').value.trim().replace(/\/+$/, '');
      const token = o.querySelector('#lb-token').value.trim();
      if (!/^https:\/\/[^/\s]+$/i.test(url)) { msg.textContent = "L'indirizzo deve essere https://host[:porta]"; return; }
      if (!token) { msg.textContent = 'Inserisci il token'; return; }
      Object.assign(s, { piUrl: url, token, lastError: null });
      await backup.save();
      ev.target.disabled = true; ev.target.textContent = 'Prova in corso…'; msg.textContent = '';
      try {
        const r = await backup.run();
        o.remove();
        toast('✅ ' + r.message);
      } catch (e) {
        msg.textContent = 'Salvato, ma la prova è fallita: ' + e.message;
        ev.target.disabled = false; ev.target.textContent = 'Salva e prova';
      }
    };
  }

  // "Esporta" nelle pagine fa window.open('/api/export')
  const origOpen = window.open;
  window.open = function (url, ...rest) {
    if (String(url).includes('/api/export')) { exportExcel(); return null; }
    return origOpen.call(window, url, ...rest);
  };

  // ── 3. UI: stile comune ────────────────────────────────────────────
  const css = `
    .lb-overlay { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
      padding: 16px; background: rgba(8, 8, 16, 0.92); backdrop-filter: blur(6px); font-family: 'Segoe UI', sans-serif; }
    .lb-card { width: 100%; max-width: 420px; background: #141225; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px; padding: 22px; color: #e2e8f0; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
    .lb-card h2 { margin: 0 0 8px; font-size: 1.15rem; }
    .lb-card p { margin: 0 0 14px; color: #a0aec0; font-size: 0.9rem; line-height: 1.45; }
    .lb-stats { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0 0 16px; font-size: 0.85rem; }
    .lb-stats dt { color: #718096; } .lb-stats dd { margin: 0; color: #e2e8f0; }
    .lb-btn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 14px; margin-top: 8px;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
      color: #e2e8f0; font-size: 0.95rem; cursor: pointer; text-align: left; }
    .lb-btn:active { background: rgba(255,255,255,0.1); }
    .lb-btn.primary { background: #6d28d9; border-color: #7c3aed; color: #fff; justify-content: center; }
    .lb-btn.ghost { background: none; border-color: transparent; color: #a0aec0; justify-content: center; }
    .lb-error { color: #fca5a5; font-size: 0.85rem; white-space: pre-wrap; }
    .lb-error:empty { display: none; }
    .lb-card h3 { margin: 18px 0 8px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: #a78bfa; }
    .lb-card code { font-size: 0.85em; }
    .lb-muted { color: #718096; } .lb-warn { color: #fbbf24; }
    .lb-status { font-size: 0.88rem; line-height: 1.5; margin-bottom: 4px; }
    .lb-label { display: block; font-size: 0.82rem; color: #a0aec0; margin-bottom: 12px; }
    .lb-input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 12px;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
      color: #e2e8f0; font-size: 0.95rem; }
    .lb-input:focus { outline: none; border-color: #7c3aed; }
    .lb-card { max-height: calc(100vh - 32px); overflow-y: auto; }
  `;
  function injectCss() {
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function overlay(html) {
    const o = document.createElement('div');
    o.className = 'lb-overlay';
    o.innerHTML = `<div class="lb-card">${html}</div>`;
    document.body.appendChild(o);
    return o;
  }

  // ── 4. Primo avvio: nessun DB ──────────────────────────────────────
  function showWelcome() {
    const o = overlay(`
      <h2>📱 Budget sul telefono</h2>
      <p>L'app ora tiene i dati direttamente sul telefono e funziona anche senza il Raspberry Pi.</p>
      <p>Per iniziare importa il tuo <b>budget.db</b>: copialo dal Pi (<code>data/budget.db</code>) o da un backup su Drive.</p>
      <button class="lb-btn primary" id="lb-import">📂 Importa budget.db</button>
    `);
    o.querySelector('#lb-import').onclick = () => importDb(false);
  }

  function showFatal(err) {
    overlay(`
      <h2>⚠️ Database non leggibile</h2>
      <p class="lb-error"></p>
      <p>Puoi importare un backup del database.</p>
      <button class="lb-btn primary" id="lb-import">📂 Importa budget.db</button>
    `).querySelector('.lb-error').textContent = err.message;
    document.getElementById('lb-import').onclick = () => importDb(false);
  }

  // ── 5. Pannello "Dati" ─────────────────────────────────────────────
  let lastSaved = null;
  LocalDB.onChange(ev => { if (ev.type === 'saved') lastSaved = ev; });

  function showDataPanel() {
    const n = LocalDB.scalar('SELECT COUNT(*) FROM transactions');
    const last = LocalDB.scalar('SELECT MAX(date) FROM transactions');
    const size = LocalDB.exportBytes().length;
    const o = overlay(`
      <h2>💾 Dati</h2>
      <p>I dati sono salvati sul telefono${NATIVE ? '' : ' (modalità test nel browser)'}.</p>
      <dl class="lb-stats">
        <dt>Transazioni</dt><dd>${n}</dd>
        <dt>Ultima data</dt><dd>${last || '—'}</dd>
        <dt>Dimensione</dt><dd>${(size / 1024).toFixed(0)} KB</dd>
        <dt>Ultimo salvataggio</dt><dd>${lastSaved ? lastSaved.at.toLocaleTimeString('it-IT') : 'nessuna modifica in questa sessione'}</dd>
      </dl>
      <h3>Backup sul Pi</h3>
      <div class="lb-status" id="lb-backup-status"></div>
      ${backup.configured() ? '<button class="lb-btn" id="lb-bk-now">☁️ Backup ora (Pi + Drive)</button>' : ''}
      <button class="lb-btn" id="lb-bk-set">⚙️ Impostazioni backup</button>
      <h3>File</h3>
      <button class="lb-btn" id="lb-exp-db">📤 Esporta database (.db)</button>
      <button class="lb-btn" id="lb-exp-xlsx">📊 Esporta Excel</button>
      <button class="lb-btn" id="lb-imp">📂 Importa database…</button>
      <button class="lb-btn ghost" id="lb-close">Chiudi</button>
    `);
    const close = () => o.remove();
    o.addEventListener('click', e => { if (e.target === o) close(); });
    o.querySelector('#lb-close').onclick = close;
    renderBackupStatus();
    o.querySelector('#lb-bk-set').onclick = () => { close(); showBackupSettings(); };
    const now = o.querySelector('#lb-bk-now');
    if (now) now.onclick = async () => {
      now.disabled = true;
      try { toast('✅ ' + (await backup.run({ drive: true })).message); }
      catch (e) { toast('❌ ' + e.message, true); }
      finally { now.disabled = false; }
    };
    o.querySelector('#lb-exp-db').onclick = exportDb;
    o.querySelector('#lb-exp-xlsx').onclick = exportExcel;
    o.querySelector('#lb-imp').onclick = () => importDb(true);
  }

  function addDataButton() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const btn = document.createElement('button');
    btn.className = 'sidebar-btn';
    btn.dataset.tip = 'Dati';
    btn.innerHTML = '<span class="btn-icon">💾</span><span class="btn-label"> Dati</span>';
    btn.onclick = () => {
      if (typeof window.closeMobileNav === 'function') window.closeMobileNav();
      showDataPanel();
    };
    // dopo l'ultimo pulsante della sezione Azioni, altrimenti dopo i link di navigazione
    const anchor = [...sidebar.querySelectorAll('.sidebar-btn')].pop()
      || [...sidebar.querySelectorAll('.sidebar-nav-link')].pop();
    if (anchor) anchor.after(btn); else sidebar.prepend(btn);
  }

  // ── 6. Avvio ───────────────────────────────────────────────────────
  function onDom(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  onDom(() => {
    injectCss();
    backupLoaded.then(() => {
      backup.start();
      if (!LocalDB.hasData) showWelcome();
      else addDataButton();
    }).catch(showFatal);
  });

  window.LocalBoot = { native: NATIVE, exportDb, exportExcel, importDb, showDataPanel, showBackupSettings, backup };
})();
