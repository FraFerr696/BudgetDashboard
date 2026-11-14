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
      <button class="lb-btn" id="lb-exp-db">📤 Esporta database (.db)</button>
      <button class="lb-btn" id="lb-exp-xlsx">📊 Esporta Excel</button>
      <button class="lb-btn" id="lb-imp">📂 Importa database…</button>
      <button class="lb-btn ghost" id="lb-close">Chiudi</button>
    `);
    const close = () => o.remove();
    o.addEventListener('click', e => { if (e.target === o) close(); });
    o.querySelector('#lb-close').onclick = close;
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
    opened.then(() => {
      if (!LocalDB.hasData) showWelcome();
      else addDataButton();
    }).catch(showFatal);
  });

  window.LocalBoot = { native: NATIVE, exportDb, exportExcel, importDb, showDataPanel };
})();
