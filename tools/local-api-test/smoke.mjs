// Smoke test delle pagine in modalità locale, in Edge/Chrome headless.
//
//   cd mobile && npm run build:www && node ../tools/local-api-test/smoke.mjs
//
// Serve mobile/www, apre le pagine a larghezza telefono, importa il DB di
// out/reference.js, controlla errori JS / API e salva screenshot in out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const PORT = 5199, CDP_PORT = 9333;
const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const browserPath = BROWSERS.find(p => existsSync(p));
if (!browserPath) throw new Error('Nessun browser Chromium trovato (imposta BROWSER=...)');

const refText = readFileSync(path.join(OUT, 'reference.js'), 'utf8');
const DB_B64 = JSON.parse(refText.slice(refText.indexOf('{'), refText.lastIndexOf('}') + 1)).db_b64;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(ROOT, 'mobile/scripts/serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profile = mkdtempSync(path.join(tmpdir(), 'budget-smoke-'));
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

let ws, nextId = 1;
const pending = new Map();
const events = [];

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
          else if (msg.method) events.push(msg);
        };
        return;
      }
    } catch { /* non ancora pronto */ }
    await sleep(200);
  }
  throw new Error('CDP non raggiungibile');
}
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function go(url, wait = 2500) {
  events.length = 0;
  await send('Page.navigate', { url });
  await sleep(wait);
}
function pageErrors() {
  const errs = [];
  for (const e of events) {
    if (e.method === 'Runtime.exceptionThrown') errs.push('EXC ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text));
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errs.push('console.error ' + e.params.args.map(a => a.value ?? a.description).join(' '));
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') errs.push('log ' + e.params.entry.text + ' ' + (e.params.entry.url || ''));
  }
  return errs;
}

const results = [];
const check = (ok, title, detail = '') => results.push({ ok, title, detail });

try {
  await connect();
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });

  const base = `http://localhost:${PORT}`;

  // 1) primo avvio: niente DB -> schermata di import
  await go(base + '/');
  check(await evaluate(`!!document.querySelector('.lb-overlay #lb-import')`), 'primo avvio mostra "Importa budget.db"');
  writeFileSync(path.join(OUT, 'smoke_0_welcome.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));

  // 2) import del DB (stessa funzione del pulsante, senza file picker)
  await evaluate(`LocalDB.importBytes(LocalDB._b64.b64ToBytes(${JSON.stringify(DB_B64)})).then(() => true)`);

  // 3) ogni pagina: niente overlay, niente errori, contenuto presente, screenshot
  const pages = {
    'index': { url: '/', expect: `document.querySelectorAll('canvas').length` },
    'transactions': { url: '/transactions.html', expect: `document.querySelectorAll('tbody tr').length` },
    'categories': { url: '/categories.html', expect: `document.querySelectorAll('canvas').length` },
    'investments': { url: '/investments.html', expect: `document.querySelectorAll('canvas').length` },
  };
  for (const [name, p] of Object.entries(pages)) {
    await go(base + p.url, 3000);
    const overlay = await evaluate(`!!document.querySelector('.lb-overlay')`);
    const dataBtn = await evaluate(`[...document.querySelectorAll('.sidebar-btn')].some(b => b.dataset.tip === 'Dati')`);
    const count = await evaluate(p.expect);
    const errs = pageErrors();
    check(!overlay && dataBtn && count > 0 && !errs.length, `${name}: carica dal DB locale`,
      `overlay=${overlay} dati=${dataBtn} elementi=${count}${errs.length ? '\n    ' + errs.join('\n    ') : ''}`);
    writeFileSync(path.join(OUT, `smoke_${name}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  }

  // 4) scrittura + persistenza (IndexedDB) dopo ricarica
  await go(base + '/transactions.html', 2500);
  const before = await evaluate(`fetch('/api/transactions').then(r => r.json()).then(d => d.length)`);
  const sub = await evaluate(`fetch('/api/subcategories').then(r => r.json()).then(d => d.find(s => s.category_type === 'Expense').subcategory)`);
  const add = await evaluate(`fetch('/api/transactions', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ date: '2026-11-14', account: 'Unicredit', amount: -1.23, subcategory: ${JSON.stringify(sub)}, notes: 'smoke' }) }).then(r => r.status)`);
  await go(base + '/transactions.html', 2500);
  const after = await evaluate(`fetch('/api/transactions').then(r => r.json()).then(d => d.length)`);
  check(add === 200 && after === before + 1, 'nuova transazione persiste dopo ricarica', `status=${add} ${before} -> ${after}`);

  // 5) export Excel
  const xlsx = await evaluate(`(async () => {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/xlsx.full.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const r = await fetch('/api/export'); const b = await r.arrayBuffer();
    const wb = XLSX.read(b, { type: 'array' });
    return { status: r.status, size: b.byteLength, sheets: wb.SheetNames, rows: XLSX.utils.sheet_to_json(wb.Sheets.Transactions).length };
  })()`);
  check(xlsx.status === 200 && xlsx.rows === after && xlsx.sheets.join() === 'Transactions,Categories', 'export Excel', JSON.stringify(xlsx));

  // 6) pannello Dati
  await evaluate(`LocalBoot.showDataPanel(), true`);
  await sleep(300);
  check(await evaluate(`document.querySelector('.lb-stats') && document.querySelector('.lb-stats').innerText.includes(String(${after}))`), 'pannello Dati mostra il numero di transazioni');
  writeFileSync(path.join(OUT, 'smoke_data_panel.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));

  // 7) backup verso il Pi: backend FastAPI vero in modalità mirror (se PYTHON è impostato)
  if (process.env.PYTHON) {
    const piDir = mkdtempSync(path.join(tmpdir(), 'budget-pi-'));
    const piDb = path.join(piDir, 'budget.db');
    writeFileSync(piDb, Buffer.from(DB_B64, 'base64'));
    const PI_PORT = 8765, TOKEN = 'smoke-token';
    const pi = spawn(process.env.PYTHON, ['-m', 'uvicorn', 'main:app', '--port', String(PI_PORT), '--log-level', 'warning'], {
      cwd: path.join(ROOT, 'backend/app'),
      env: { ...process.env, DB_PATH: piDb, NODE_ROLE: 'mirror', BACKUP_TOKEN: TOKEN, PYTHONPATH: path.join(ROOT, 'backend') },
      stdio: 'ignore',
    });
    try {
      const piUrl = `http://127.0.0.1:${PI_PORT}`;
      for (let i = 0; i < 50; i++) { try { await fetch(piUrl + '/health'); break; } catch { await sleep(200); } }
      const piCount = async () => (await (await fetch(piUrl + '/api/transactions')).json()).length;

      // token sbagliato -> errore leggibile, niente scritto
      const bad = await evaluate(`(async () => {
        Object.assign(LocalBoot.backup.settings, { piUrl: ${JSON.stringify(piUrl)}, token: 'sbagliato' });
        try { await LocalBoot.backup.run(); return 'ok?'; } catch (e) { return e.message; }
      })()`);
      check(/token/i.test(bad) && (await piCount()) === before, 'backup con token sbagliato rifiutato', bad);

      // node-role: con backup configurato le pagine mostrano "Backup"
      await evaluate(`(async () => { Object.assign(LocalBoot.backup.settings, { token: ${JSON.stringify(TOKEN)} }); await LocalBoot.backup.save(); })()`);
      await go(base + '/', 3000);
      const backupBtn = await evaluate(`getComputedStyle(document.getElementById('btn-backup')).display !== 'none'`);
      check(backupBtn, 'con backup configurato compare il pulsante "Backup"');

      // modifica -> backup automatico (accorciato) -> il Pi ha i dati del telefono
      await evaluate(`fetch('/api/transactions', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ date: '2026-11-14', account: 'Unicredit', amount: -2.5, subcategory: ${JSON.stringify(sub)}, notes: 'smoke backup' }) }).then(r => r.status)`);
      const dirty = await evaluate(`LocalBoot.backup.settings.dirty`);
      const res = await evaluate(`LocalBoot.backup.run().then(r => r.message, e => 'ERR ' + e.message)`);
      const n = await piCount();
      check(dirty && !res.startsWith('ERR') && n === after + 1, 'backup: il Pi riceve il DB del telefono', `${res} | Pi: ${n} transazioni, attese ${after + 1}`);
      check(await evaluate(`LocalBoot.backup.settings.dirty === false && !!LocalBoot.backup.settings.lastOkAt`), 'dopo il backup nessuna modifica in sospeso');

      // il Pi in mirror rifiuta le scritture dalla sua dashboard web
      const w = await fetch(piUrl + '/api/transactions/1', { method: 'DELETE' });
      check(w.status === 403, 'Pi mirror: scrittura dalla web rifiutata', String(w.status));

      // Pi spento -> errore "non raggiungibile", resta in sospeso
      pi.kill(); await sleep(800);
      await evaluate(`fetch('/api/transactions', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ date: '2026-11-14', account: 'Unicredit', amount: -1, subcategory: ${JSON.stringify(sub)} }) }).then(r => r.status)`);
      const off = await evaluate(`LocalBoot.backup.run().then(() => 'ok?', e => e.message)`);
      check(/raggiungibile|timeout/i.test(off) && await evaluate(`LocalBoot.backup.settings.dirty`), 'Pi spento: errore chiaro, modifiche restano da inviare', off);
      await evaluate(`LocalBoot.showDataPanel(), true`); await sleep(300);
      writeFileSync(path.join(OUT, 'smoke_backup_panel.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
    } finally {
      pi.kill();
      await sleep(300);
      try { rmSync(piDir, { recursive: true, force: true }); } catch {}
    }
  } else {
    console.log('(backup verso il Pi non testato: imposta PYTHON=<python con fastapi+uvicorn>)');
  }
} catch (e) {
  check(false, 'ERRORE', e.stack || String(e));
} finally {
  try { ws && ws.close(); } catch {}
  browser.kill(); server.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const ko = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.title}${!r.ok || process.env.VERBOSE ? '\n    ' + r.detail : ''}`);
console.log(ko.length ? `\n✗ ${ko.length} falliti su ${results.length}` : `\n✓ Tutti i ${results.length} controlli passati (screenshot in ${path.relative(ROOT, OUT)})`);
process.exit(ko.length ? 1 : 0);
