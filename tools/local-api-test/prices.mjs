// Test di frontend/js/local-prices.js con risposte Yahoo finte (niente rete)
// e dell'integrazione con LocalApi (holdings / price-history / refresh-prices).
//   node tools/local-api-test/prices.mjs
// Con LIVE=1 prova anche le richieste vere a Yahoo (via curl).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LocalPrices = require(path.join(ROOT, 'frontend/js/local-prices.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

// 2026-11-12 e 13 alle 09:00 Europe/Rome (UTC+1) = 08:00 UTC; il terzo è NaN
const day = (d) => Date.UTC(2026, 10, d, 8, 0, 0) / 1000;
// regularMarketPrice volutamente diverso dall'ultima chiusura (come CEU2.MI)
function chartBody({ price = 77.7, adj = true, empty = false } = {}) {
  return {
    chart: {
      error: null,
      result: [{
        meta: { regularMarketPrice: price, currency: 'EUR', gmtoffset: 3600 },
        timestamp: empty ? [] : [day(12), day(13), day(14)],
        indicators: {
          quote: [{ close: empty ? [] : [100, 101, null] }],
          ...(adj ? { adjclose: [{ adjclose: [99.5, 100.5, null] }] } : {}),
        },
      }],
    },
  };
}

const calls = [];
let mode = 'ok';
let clock = 0;
const p = LocalPrices.create({
  now: () => clock,
  httpGet: async (url, headers) => {
    calls.push(url);
    if (mode === 'down') throw new Error('offline');
    if (mode === '404') return { status: 404, data: { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } } };
    if (mode === 'string') return { status: 200, data: JSON.stringify(chartBody({ adj: false })) };
    if (mode === 'empty') return { status: 200, data: chartBody({ empty: true }) };
    return { status: 200, data: chartBody() };
  },
});

console.log('LocalPrices');
let cur = await p.current(['UST.MI', 'CEU2.MI']);
check('current: ultima chiusura non rettificata (non regularMarketPrice)', cur['UST.MI'] === 101 && cur['CEU2.MI'] === 101, cur);
check('current: una richiesta per ticker', calls.length === 2, calls);
check('current: URL con range e ticker codificato', calls[0].includes('/chart/UST.MI?range=5d&interval=1d'), calls[0]);
await p.current(['UST.MI']);
check('current: cache entro 2 minuti', calls.length === 2, calls.length);
clock += 3 * 60 * 1000;
await p.current(['UST.MI']);
check('current: cache scaduta -> nuova richiesta', calls.length === 3, calls.length);
calls.length = 0;
await Promise.all([p.current(['X']), p.current(['X'])]);
check('current: richieste contemporanee unite', calls.length === 1, calls.length);

mode = 'down'; p.clearCache();
cur = await p.current(['UST.MI']);
check('current: offline -> null (nessuna eccezione)', cur['UST.MI'] === null, cur);
mode = '404'; p.clearCache();
cur = await p.current(['NOPE']);
check('current: ticker inesistente -> null', cur['NOPE'] === null, cur);

mode = 'empty'; p.clearCache();
cur = await p.current(['UST.MI']);
check('current: serie vuota -> regularMarketPrice', cur['UST.MI'] === 77.7, cur);

mode = 'ok';
let h = await p.history('UST.MI', '6mo');
check('history: adjclose, righe NaN scartate', JSON.stringify(h) === JSON.stringify([{ date: '2026-11-12', price: 99.5 }, { date: '2026-11-13', price: 100.5 }]), h);
mode = 'string';
h = await p.history('UST.MI', '1mo');
check('history: risposta come stringa JSON, senza adjclose usa close', h.length === 2 && h[1].price === 101, h);
mode = '404';
let err = null; try { await p.history('NOPE'); } catch (e) { err = e.message; }
check('history: errore Yahoo propagato', err === 'No data found, symbol may be delisted', err);
err = null; try { await p.history('UST.MI', '7w'); } catch (e) { err = e.message; }
check('history: periodo non valido', err === 'Periodo non valido: 7w', err);

// ── integrazione con LocalApi ─────────────────────────────────────────
console.log('LocalApi + provider');
globalThis.window = globalThis;
const initSqlJs = require(path.join(ROOT, 'mobile/node_modules/sql.js/dist/sql-wasm.js'));
require(path.join(ROOT, 'frontend/js/local-db.js'));
require(path.join(ROOT, 'frontend/js/local-api.js'));
const { LocalDB, LocalApi } = globalThis;
const SQL = await initSqlJs();
await LocalDB.open({ SQL, storage: 'memory' });
{ // DB minimo: le tabelle obbligatorie, il resto lo aggiunge ensureSchema
  const d = new SQL.Database();
  d.run(`CREATE TABLE transactions (id INTEGER PRIMARY KEY, date TEXT, account TEXT, notes TEXT, debit REAL, credit REAL, amount REAL, subcategory TEXT, category TEXT, category_type TEXT);
         CREATE TABLE categories (category TEXT, subcategory TEXT UNIQUE, category_type TEXT);
         CREATE TABLE account_balances (account TEXT, balance REAL, as_of_date TEXT);`);
  await LocalDB.importBytes(d.export());
}
await LocalDB.write(() => {
  LocalDB.run(`INSERT INTO holdings (ticker, name, asset_type, shares, avg_price, currency, opened_at) VALUES ('UST.MI', 'Nasdaq', 'ETF', 10, 90, 'EUR', '2025-01-01')`);
});
mode = 'ok'; p.clearCache();
LocalApi.setPriceProvider(p);
let r = await LocalApi.request('GET', '/api/investments/holdings');
const hold = r.data[0];
check('holdings: prezzo live dal provider', hold.current_price === 101 && hold.price_source === 'live', hold);
r = await LocalApi.request('POST', '/api/investments/refresh-prices');
check('refresh-prices: salva il prezzo', r.data.refreshed === 1 && r.data.total === 1, r.data);
const saved = LocalDB.get(`SELECT market_price FROM portfolio_valuations WHERE ticker='UST.MI'`);
check('refresh-prices: riga in portfolio_valuations', saved && saved.market_price === 101, saved);
r = await LocalApi.request('GET', '/api/investments/price-history?ticker=UST.MI&period=1mo');
check('price-history: serie dal provider', r.data.period === '1mo' && r.data.data.length === 2 && !r.data.error, r.data);
mode = 'down'; p.clearCache();
r = await LocalApi.request('GET', '/api/investments/holdings');
check('offline: usa il prezzo salvato', r.data[0].current_price === 101 && r.data[0].price_source.startsWith('saved ('), r.data[0]);
r = await LocalApi.request('GET', '/api/investments/price-history?ticker=UST.MI');
check('offline: price-history con error', r.data.data.length === 0 && r.data.error === 'offline', r.data);

if (process.env.LIVE) {
  console.log('Yahoo live');
  // curl e non fetch: Yahoo risponde 429 al client HTTP di Node (al telefono e a curl no)
  const { execFileSync } = await import('node:child_process');
  const live = LocalPrices.create({
    httpGet: async (url, headers) => {
      const out = execFileSync('curl', ['-s', '-A', headers['User-Agent'], '-w', '\n%{http_code}', url], { encoding: 'utf8' });
      const i = out.lastIndexOf('\n');
      return { status: Number(out.slice(i + 1)), data: out.slice(0, i) };
    },
  });
  const c = await live.current(['UST.MI', 'CEU2.MI']);
  check('live current', Object.values(c).every(Number.isFinite), c);
  const hh = await live.history('UST.MI', '1mo');
  check('live history', hh.length > 10 && /^\d{4}-\d\d-\d\d$/.test(hh[0].date), hh.slice(-3));
  console.log('  ', JSON.stringify(c), JSON.stringify(hh.slice(-3)));
}

console.log(`\n${pass} ok, ${fail} falliti`);
process.exit(fail ? 1 : 0);
