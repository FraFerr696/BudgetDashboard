// Test di frontend/js/local-api.js in Node (stessi controlli di test.html).
//
//   python tools/local-api-test/make_reference.py   # genera out/reference.js
//   cd mobile && npm run test:api                     # usa sql.js di mobile/node_modules
//
// Esce con codice 1 se qualcosa non torna.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const require = createRequire(path.join(ROOT, 'mobile', 'package.json'));
const initSqlJs = require('sql.js/dist/sql-wasm.js');

for (const f of ['frontend/js/local-db.js', 'frontend/js/local-api.js']) {
  vm.runInThisContext(readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const { LocalDB, LocalApi } = globalThis;

const refText = readFileSync(path.join(HERE, 'out', 'reference.js'), 'utf8');
const REF = JSON.parse(refText.slice(refText.indexOf('{'), refText.lastIndexOf('}') + 1));

function diff(a, b, p = '$') {
  if (a === b) return null;
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a + 0, b + 0) ? null : `${p}: atteso ${a}, ottenuto ${b}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${p}: atteso ${JSON.stringify(a)}, ottenuto ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: tipo diverso`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${p}: lunghezza attesa ${a.length}, ottenuta ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], `${p}[${i}]`); if (d) return d; }
    return null;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.join('|') !== kb.join('|')) return `${p}: chiavi attese [${ka}] ottenute [${kb}]`;
  for (const k of ka) { const d = diff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  return null;
}

const fails = [];
let total = 0;
const check = (ok, title, detail) => { total++; if (!ok) fails.push(`${title}\n    ${detail}`); };

// 1) arrotondamento
let roundKo = 0;
for (const [x, n, exp] of REF.round_samples || []) {
  const got = LocalApi._pyRound(x, n);
  if (!Object.is(got + 0, exp + 0)) { roundKo++; if (roundKo <= 10) fails.push(`pyRound(${x}, ${n}) atteso ${exp} ottenuto ${got}`); }
}
check(roundKo === 0, `pyRound (${(REF.round_samples || []).length} campioni)`, `${roundKo} diversi`);

// 2) API
const SQL = await initSqlJs();
await LocalDB.open({ SQL, storage: 'memory' });
await LocalDB.importBytes(Buffer.from(REF.db_b64, 'base64'));
for (const c of REF.cases) {
  const res = await LocalApi.request(c.method, c.path, c.body ?? undefined);
  let problem = null;
  if (res.status !== c.status) problem = `status atteso ${c.status}, ottenuto ${res.status} — ${JSON.stringify(res.data)}`;
  else if (c.compare === 'full') problem = diff(c.response, res.data);
  else if (c.compare === 'nodate') {
    const strip = (o) => { const { date, ...rest } = o || {}; return rest; };
    problem = diff(strip(c.response), strip(res.data));
  }
  check(!problem, `${c.method} ${c.path}`, problem);
}

// 3) export -> riapertura
const re = new SQL.Database(LocalDB.exportBytes());
const a = re.exec('SELECT COUNT(*), ROUND(SUM(amount),2) FROM transactions')[0].values[0].join('/');
const b = Object.values(LocalDB.get('SELECT COUNT(*) AS c, ROUND(SUM(amount),2) AS s FROM transactions')).join('/');
check(a === b, 'export → riapertura del DB', `${a} vs ${b}`);

// 4) recupero dopo salvataggio interrotto: FILE troncato, TMP integro
{
  const files = new Map();
  const storage = {
    name: 'fake',
    async read(n) { return files.get(n) || null; },
    async write(n, bytes) { files.set(n, bytes.slice()); },
    async remove(n) { files.delete(n); },
  };
  const good = LocalDB.exportBytes();
  files.set('budget.db', good.slice(0, 1000));
  files.set('budget.db.tmp', good);
  // istanza nuova di LocalDB per non toccare quella sopra
  const ctx = { console, atob, btoa, Promise, Map, Set, Uint8Array };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'frontend/js/local-db.js'), 'utf8'), ctx);
  await ctx.LocalDB.open({ SQL, storage });
  const n = ctx.LocalDB.hasData ? ctx.LocalDB.scalar('SELECT COUNT(*) FROM transactions') : -1;
  check(n === re.exec('SELECT COUNT(*) FROM transactions')[0].values[0][0], 'recupero da budget.db.tmp dopo crash', `righe: ${n}`);
}

// 5) import di un file non valido viene rifiutato e non tocca i dati
{
  let rejected = false;
  try { await LocalDB.importBytes(new TextEncoder().encode('non sono un database')); } catch { rejected = true; }
  check(rejected && LocalDB.scalar('SELECT COUNT(*) FROM transactions') > 0, 'import file non valido rifiutato', `rejected=${rejected}`);
}

if (fails.length) {
  console.log(`✗ ${fails.length} falliti su ${total}\n`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`✓ Tutti i ${total} controlli passati`);
