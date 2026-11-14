/*
 * LocalApi — gli endpoint di backend/app/main.py e backend/investments.py
 * reimplementati in JS sopra LocalDB (SQLite sul dispositivo).
 *
 * Le query SQL sono le stesse del backend Python, così come le forme delle
 * risposte e i messaggi d'errore. Le pagine non cambiano: LocalApi.install()
 * intercetta fetch('/api/...') e risponde dal DB locale; tutto il resto
 * (CDN, Yahoo, Pi) passa alla fetch originale.
 *
 * Se cambi un endpoint in Python, cambia anche qui (e rigenera il
 * riferimento in tools/local-api-test/).
 *
 * Non ancora locali (arrivano nei prossimi step):
 *   - prezzi live / storico prezzi  -> LocalApi.setPriceProvider(...)
 *   - /api/backup-to-drive, /api/sync-from-drive -> backup verso il Pi
 *   - /api/export -> richiede SheetJS (window.XLSX)
 */
(function (global) {
  'use strict';

  const DB = () => global.LocalDB;
  const CONFIRMED = "COALESCE(status, 'confirmed') = 'confirmed'";

  class HttpError extends Error {
    constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
  }

  // ── round() di Python ──────────────────────────────────────────────
  // Python arrotonda sul valore decimale esatto del float e, sui pareggi
  // esatti, al pari (banker's). toFixed usa il valore esatto ma sui pareggi
  // va per eccesso: i pareggi esatti sono x * 2^(n+1) intero dispari.
  function pyRound(x, n = 2) {
    if (x === null || x === undefined || !Number.isFinite(x)) return x;
    const t = x * Math.pow(2, n + 1);
    if (Number.isInteger(t) && Math.abs(t) % 2 === 1) {
      const m = Math.pow(10, n);
      const k = Math.floor(x * m);
      return (k % 2 === 0 ? k : k + 1) / m;
    }
    return Number(x.toFixed(n));
  }

  /** Truthiness di Python per numeri/None (0 e None sono falsi). */
  const truthy = (v) => v !== null && v !== undefined && v !== 0 && v !== '' && !Number.isNaN(v);

  function localToday() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ── Validazione corpo (equivalente minimo di Pydantic) ─────────────
  function v422(msg) { return new HttpError(422, msg); }

  function reqStr(body, k) {
    if (body[k] === undefined || body[k] === null) throw v422(`Campo '${k}' obbligatorio`);
    if (typeof body[k] !== 'string') throw v422(`Campo '${k}' deve essere testo`);
    return body[k];
  }
  function optStr(body, k, dflt) {
    if (body[k] === undefined) return dflt;
    if (body[k] === null) { if (dflt === null) return null; throw v422(`Campo '${k}' deve essere testo`); }
    if (typeof body[k] !== 'string') throw v422(`Campo '${k}' deve essere testo`);
    return body[k];
  }
  function reqNum(body, k) {
    const v = body[k];
    if (v === undefined || v === null) throw v422(`Campo '${k}' obbligatorio`);
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    if (!Number.isFinite(n)) throw v422(`Campo '${k}' deve essere un numero`);
    return n;
  }
  function optNum(body, k) {
    if (body[k] === undefined || body[k] === null) return null;
    return reqNum(body, k);
  }
  function reqDate(body, k) {
    const s = reqStr(body, k);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
      throw v422(`Campo '${k}' deve essere una data AAAA-MM-GG`);
    }
    return s;
  }
  function needBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw v422('Corpo JSON mancante');
    return body;
  }

  // ── Prezzi di mercato (sostituto di yfinance) ──────────────────────
  // provider.current(tickers) -> Promise<{ticker: prezzo|null}>
  // provider.history(ticker, period) -> Promise<[{date, price}]>
  let priceProvider = null;

  async function fetchCurrentPrices(tickers) {
    const out = {};
    tickers.forEach(t => { out[t] = null; });
    if (!priceProvider || !priceProvider.current || !tickers.length) return out;
    try {
      const got = await priceProvider.current(tickers);
      for (const t of tickers) {
        const p = got && got[t];
        out[t] = Number.isFinite(p) ? pyRound(p, 4) : null;
      }
    } catch (e) {
      console.warn('[LocalApi] prezzi non disponibili:', e);
    }
    return out;
  }

  function getLastSavedPrices(tickers) {
    const out = {};
    for (const t of tickers) {
      const row = DB().get(
        `SELECT market_price, date FROM portfolio_valuations
         WHERE ticker = ? ORDER BY date DESC LIMIT 1`, [t]);
      out[t] = row ? { price: row.market_price, date: row.date } : { price: null, date: null };
    }
    return out;
  }

  // ── Router ─────────────────────────────────────────────────────────
  const routes = [];
  function route(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, handler });
  }
  function intParam(v) {
    if (!/^-?\d+$/.test(v)) throw v422('ID non valido');
    return parseInt(v, 10);
  }

  // ════════════════════════════════════════════════════════════════════
  //  main.py
  // ════════════════════════════════════════════════════════════════════

  route('GET', '/health', () => ({ status: 'ok' }));

  route('GET', '/api/transactions', (_, q) => {
    let sql = "SELECT id, date, account, notes, amount, subcategory, category, category_type, COALESCE(status, 'confirmed') as status FROM transactions WHERE 1=1";
    const params = [];
    if (q.month) { sql += ' AND substr(date, 1, 7) = ?'; params.push(q.month); }
    if (q.category) { sql += ' AND category = ?'; params.push(q.category); }
    if (q.account) { sql += ' AND account = ?'; params.push(q.account); }
    if (q.category_type) { sql += ' AND category_type = ?'; params.push(q.category_type); }
    sql += ' ORDER BY date DESC, id DESC';
    return DB().all(sql, params).map(r => ({
      id: r.id,
      Date: r.date,
      Account: r.account,
      Notes: r.notes || '',
      'Income/(Expense)': r.amount,
      Subcategory: r.subcategory,
      Category: r.category,
      'Category Type': r.category_type,
      status: r.status,
    }));
  });

  route('GET', '/api/summary', (_, q) => {
    const where = q.month
      ? `WHERE ${CONFIRMED} AND substr(date, 1, 7) = ?`
      : `WHERE ${CONFIRMED}`;
    const params = q.month ? [q.month] : [];
    const income = DB().scalar(`SELECT COALESCE(SUM(amount), 0) FROM transactions ${where} AND category_type = 'Income'`, params);
    const expensesRaw = DB().scalar(`SELECT COALESCE(SUM(amount), 0) FROM transactions ${where} AND category_type = 'Expense'`, params);
    const count = DB().scalar(`SELECT COUNT(*) FROM transactions ${where} AND category_type != 'Transfer'`, params);
    return {
      total_income: pyRound(income, 2),
      total_expenses: pyRound(Math.abs(expensesRaw), 2),
      balance: pyRound(income + expensesRaw, 2),
      transaction_count: count,
    };
  });

  route('GET', '/api/by-month', () => DB().all(`
      SELECT
          substr(date, 1, 7) AS month,
          SUM(CASE WHEN category_type = 'Income' THEN amount ELSE 0 END) AS income,
          SUM(CASE WHEN category_type = 'Expense' THEN ABS(amount) ELSE 0 END) AS expenses
      FROM transactions
      WHERE category_type != 'Transfer' AND ${CONFIRMED}
      GROUP BY month
      ORDER BY month
    `).map(r => ({
      month: r.month,
      income: pyRound(r.income, 2),
      expenses: pyRound(r.expenses, 2),
      balance: pyRound(r.income - r.expenses, 2),
    })));

  route('GET', '/api/by-category', (_, q) => {
    let sql = `
      SELECT category, SUM(ABS(amount)) AS total
      FROM transactions
      WHERE category_type = 'Expense' AND ${CONFIRMED}
    `;
    const params = [];
    if (q.month) { sql += ' AND substr(date, 1, 7) = ?'; params.push(q.month); }
    sql += ' GROUP BY category ORDER BY total DESC';
    return DB().all(sql, params).map(r => ({ category: r.category, amount: pyRound(r.total, 2) }));
  });

  route('GET', '/api/by-subcategory', (_, q) => {
    let sql = `
      SELECT category, subcategory, SUM(ABS(amount)) AS total
      FROM transactions
      WHERE category_type = 'Expense' AND ${CONFIRMED}
    `;
    const params = [];
    if (q.month) { sql += ' AND substr(date, 1, 7) = ?'; params.push(q.month); }
    if (q.category) { sql += ' AND category = ?'; params.push(q.category); }
    sql += ' GROUP BY category, subcategory ORDER BY total DESC';
    return DB().all(sql, params).map(r => ({ category: r.category, subcategory: r.subcategory, amount: pyRound(r.total, 2) }));
  });

  route('GET', '/api/categories', () => DB().all(
    "SELECT DISTINCT category FROM transactions WHERE category_type = 'Expense' ORDER BY category"
  ).map(r => r.category));

  route('GET', '/api/by-account', (_, q) => {
    let sql = `
      SELECT account, SUM(ABS(amount)) AS total
      FROM transactions
      WHERE category_type = 'Expense' AND ${CONFIRMED}
    `;
    const params = [];
    if (q.month) { sql += ' AND substr(date, 1, 7) = ?'; params.push(q.month); }
    sql += ' GROUP BY account';
    return DB().all(sql, params).map(r => ({ account: r.account, amount: pyRound(r.total, 2) }));
  });

  route('GET', '/api/months', () => DB().all(
    'SELECT DISTINCT substr(date, 1, 7) AS month FROM transactions ORDER BY month'
  ).map(r => r.month));

  route('GET', '/api/subcategories', () => DB().all(
    'SELECT subcategory, category, category_type FROM categories ORDER BY category, subcategory'
  ).map(r => ({ subcategory: r.subcategory, category: r.category, category_type: r.category_type })));

  function parseNewTransaction(body) {
    needBody(body);
    return {
      date: reqDate(body, 'date'),
      account: reqStr(body, 'account'),
      amount: reqNum(body, 'amount'),
      subcategory: reqStr(body, 'subcategory'),
      notes: optStr(body, 'notes', ''),
      status: optStr(body, 'status', 'confirmed'),
    };
  }

  function resolveCategory(subcategory) {
    const row = DB().get('SELECT category, category_type FROM categories WHERE subcategory = ?', [subcategory]);
    if (!row) throw new HttpError(400, `Subcategory '${subcategory}' non trovata`);
    return row;
  }

  route('POST', '/api/transactions', async (_, __, body) => {
    const tx = parseNewTransaction(body);
    const { category, category_type } = resolveCategory(tx.subcategory);
    const debit = tx.amount < 0 ? Math.abs(tx.amount) : null;
    const credit = tx.amount > 0 ? tx.amount : null;
    const { lastId } = await DB().write(() => DB().run(
      `INSERT INTO transactions (date, account, notes, debit, credit, amount, subcategory, category, category_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tx.date, tx.account, tx.notes || '', debit, credit, tx.amount, tx.subcategory, category, category_type, tx.status]
    ));
    return { status: 'ok', id: lastId, category, category_type };
  });

  route('POST', '/api/transfer', async (_, __, body) => {
    needBody(body);
    const tr = {
      date: reqDate(body, 'date'),
      from_account: reqStr(body, 'from_account'),
      to_account: reqStr(body, 'to_account'),
      amount: reqNum(body, 'amount'),
      notes: optStr(body, 'notes', ''),
    };
    if (tr.amount <= 0) throw new HttpError(400, "L'importo deve essere positivo");
    if (tr.from_account === tr.to_account) throw new HttpError(400, 'I due conti devono essere diversi');

    const subOut = `Transfer to ${tr.to_account}`;
    const subIn = `Transfer from ${tr.from_account}`;
    for (const sub of [subOut, subIn]) {
      if (!DB().get('SELECT subcategory FROM categories WHERE subcategory = ?', [sub])) {
        throw new HttpError(400, `Subcategory '${sub}' non trovata nel DB`);
      }
    }
    const note = tr.notes || `${tr.from_account} → ${tr.to_account}`;
    await DB().write(() => {
      DB().run(
        `INSERT INTO transactions (date, account, notes, debit, credit, amount, subcategory, category, category_type)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 'Transfer', 'Transfer')`,
        [tr.date, tr.from_account, note, tr.amount, -tr.amount, subOut]);
      DB().run(
        `INSERT INTO transactions (date, account, notes, debit, credit, amount, subcategory, category, category_type)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'Transfer', 'Transfer')`,
        [tr.date, tr.to_account, note, tr.amount, tr.amount, subIn]);
    });
    return { status: 'ok', note };
  });

  route('DELETE', '/api/transactions/{id}', async (p) => {
    const id = intParam(p.id);
    if (!DB().get('SELECT id FROM transactions WHERE id = ?', [id])) throw new HttpError(404, 'Transazione non trovata');
    await DB().write(() => DB().run('DELETE FROM transactions WHERE id = ?', [id]));
    return { status: 'ok', deleted_id: id };
  });

  route('PATCH', '/api/transactions/{id}/toggle-status', async (p) => {
    const id = intParam(p.id);
    const row = DB().get("SELECT id, COALESCE(status, 'confirmed') as status FROM transactions WHERE id = ?", [id]);
    if (!row) throw new HttpError(404, 'Transazione non trovata');
    const newStatus = row.status === 'planned' ? 'confirmed' : 'planned';
    await DB().write(() => DB().run('UPDATE transactions SET status = ? WHERE id = ?', [newStatus, id]));
    return { status: 'ok', id, new_status: newStatus };
  });

  route('PUT', '/api/transactions/{id}', async (p, _, body) => {
    const id = intParam(p.id);
    const tx = parseNewTransaction(body);
    if (!DB().get('SELECT id FROM transactions WHERE id = ?', [id])) throw new HttpError(404, 'Transazione non trovata');
    const { category, category_type } = resolveCategory(tx.subcategory);
    const debit = tx.amount < 0 ? Math.abs(tx.amount) : null;
    const credit = tx.amount > 0 ? tx.amount : null;
    await DB().write(() => DB().run(
      `UPDATE transactions
       SET date=?, account=?, notes=?, debit=?, credit=?, amount=?, subcategory=?, category=?, category_type=?, status=?
       WHERE id=?`,
      [tx.date, tx.account, tx.notes || '', debit, credit, tx.amount, tx.subcategory, category, category_type, tx.status, id]));
    return { status: 'ok', id, category, category_type };
  });

  route('GET', '/api/account-balances', () => {
    const result = DB().all('SELECT account, balance, as_of_date FROM account_balances').map(snap => {
      const delta = DB().scalar(
        `SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account = ? AND date > ? AND ${CONFIRMED}`,
        [snap.account, snap.as_of_date]);
      return { account: snap.account, balance: pyRound(snap.balance + delta, 2), snapshot_date: snap.as_of_date };
    });
    const total = result.reduce((s, r) => s + r.balance, 0);
    result.push({ account: 'Totale', balance: pyRound(total, 2), snapshot_date: null });
    return result;
  });

  route('GET', '/api/cumulative-balance', () => DB().all(`
      SELECT date, SUM(amount) OVER (ORDER BY date, id) AS cumulative
      FROM transactions
      WHERE ${CONFIRMED}
      ORDER BY date, id
    `).map(r => ({ Date: r.date, cumulative: pyRound(r.cumulative, 2) })));

  // Dati per l'export Excel (stesse colonne di /api/export in Python).
  function exportSheets() {
    const tx = DB().all('SELECT date, account, notes, debit, credit, amount, subcategory, category, category_type FROM transactions ORDER BY date')
      .map(r => ({
        'Date': r.date, 'Account': r.account, 'Notes': r.notes, 'Debit (Spend)': r.debit,
        'Credit (Income)': r.credit, 'Income/(Expense)': r.amount, 'Subcategory': r.subcategory,
        'Category': r.category, 'Category Type': r.category_type,
      }));
    const cat = DB().all('SELECT category, subcategory, category_type FROM categories ORDER BY category, subcategory');
    return { Transactions: tx, Categories: cat };
  }

  route('GET', '/api/export', () => {
    const XLSX = global.XLSX;
    if (!XLSX) throw new HttpError(501, 'Export Excel non disponibile (SheetJS non caricato)');
    const sheets = exportSheets();
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
    }
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename=BudgetExport.xlsx',
      },
    });
  });

  // Backup verso il Pi (in mirror). Il gestore lo registra local-boot.js:
  //   { ready: Promise, configured(): bool, run({ drive }): Promise<{ message }> }
  // Con il backup configurato node-role vale 'primary', quindi le pagine
  // mostrano il loro pulsante "Backup", che finisce qui sotto.
  let backupHandler = null;
  async function backupReady() {
    if (!backupHandler) return false;
    if (backupHandler.ready) await backupHandler.ready.catch(() => {});
    return !!backupHandler.configured();
  }

  route('GET', '/api/node-role', async () => ({ role: (await backupReady()) ? 'primary' : 'local' }));
  route('POST', '/api/sync-from-drive', () => { throw new HttpError(501, 'Non disponibile in modalità locale'); });
  route('POST', '/api/backup-to-drive', async () => {
    if (!(await backupReady())) throw new HttpError(400, 'Backup non configurato: apri 💾 Dati → Impostazioni backup');
    try {
      return await backupHandler.run({ drive: true });
    } catch (e) {
      throw new HttpError(502, e.message || String(e));
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  investments.py
  // ════════════════════════════════════════════════════════════════════

  const INV = '/api/investments';

  route('GET', `${INV}/holdings`, async () => {
    const rows = DB().all('SELECT * FROM holdings ORDER BY opened_at');
    const tickers = rows.map(r => r.ticker);
    const live = await fetchCurrentPrices(tickers);
    const saved = getLastSavedPrices(tickers);

    return rows.map(r => {
      const ticker = r.ticker;
      let currentPrice = live[ticker] ?? null;
      let priceSource = 'live';
      if (currentPrice === null && saved[ticker] && truthy(saved[ticker].price)) {
        currentPrice = saved[ticker].price;
        priceSource = `saved (${saved[ticker].date})`;
      }
      const invested = r.shares * r.avg_price;
      const marketValue = truthy(currentPrice) ? r.shares * currentPrice : null;
      const pl = truthy(marketValue) ? marketValue - invested : null;
      const plPct = pl !== null && invested > 0 ? pl / invested * 100 : null;
      return {
        id: r.id,
        ticker,
        name: r.name,
        asset_type: r.asset_type,
        shares: r.shares,
        avg_price: r.avg_price,
        currency: r.currency,
        opened_at: r.opened_at,
        notes: r.notes,
        isin: 'isin' in r ? r.isin : '',
        current_price: currentPrice,
        price_source: priceSource,
        invested: pyRound(invested, 2),
        market_value: truthy(marketValue) ? pyRound(marketValue, 2) : null,
        pl: pl !== null ? pyRound(pl, 2) : null,
        pl_pct: plPct !== null ? pyRound(plPct, 2) : null,
      };
    });
  });

  route('POST', `${INV}/holdings`, async (_, __, body) => {
    needBody(body);
    const h = {
      ticker: reqStr(body, 'ticker'),
      name: reqStr(body, 'name'),
      asset_type: optStr(body, 'asset_type', 'ETF'),
      shares: reqNum(body, 'shares'),
      avg_price: reqNum(body, 'avg_price'),
      currency: optStr(body, 'currency', 'EUR'),
      opened_at: reqStr(body, 'opened_at'),
      notes: optStr(body, 'notes', ''),
      isin: optStr(body, 'isin', ''),
    };
    const { lastId } = await DB().write(() => DB().run(
      `INSERT INTO holdings (ticker, name, asset_type, shares, avg_price, currency, opened_at, notes, isin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [h.ticker, h.name, h.asset_type, h.shares, h.avg_price, h.currency, h.opened_at, h.notes, h.isin]));
    return { id: lastId, message: 'Posizione aggiunta' };
  });

  const HOLDING_FIELDS = ['ticker', 'name', 'asset_type', 'shares', 'avg_price', 'currency', 'opened_at', 'notes', 'isin'];
  const NUMERIC = new Set(['shares', 'avg_price']);

  route('PUT', `${INV}/holdings/{id}`, async (p, _, body) => {
    const id = intParam(p.id);
    needBody(body);
    const updates = {};
    for (const f of HOLDING_FIELDS) {
      const val = NUMERIC.has(f) ? optNum(body, f) : optStr(body, f, null);
      if (val !== null) updates[f] = val;
    }
    if (!DB().get('SELECT * FROM holdings WHERE id = ?', [id])) throw new HttpError(404, 'Holding non trovata');
    const keys = Object.keys(updates);
    if (keys.length) {
      await DB().write(() => DB().run(
        `UPDATE holdings SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(k => updates[k]), id]));
    }
    return { message: 'Posizione aggiornata' };
  });

  route('DELETE', `${INV}/holdings/{id}`, async (p) => {
    const id = intParam(p.id);
    if (!DB().get('SELECT * FROM holdings WHERE id = ?', [id])) throw new HttpError(404, 'Holding non trovata');
    await DB().write(() => DB().run('DELETE FROM holdings WHERE id = ?', [id]));
    return { message: 'Posizione eliminata' };
  });

  route('GET', `${INV}/summary`, async () => {
    const rows = DB().all('SELECT ticker, shares, avg_price FROM holdings');
    const tickers = rows.map(r => r.ticker);
    const live = await fetchCurrentPrices(tickers);
    const saved = getLastSavedPrices(tickers);

    let totalInvested = 0;
    let totalMarket = 0;
    let hasPrices = true;
    for (const r of rows) {
      totalInvested += r.shares * r.avg_price;
      let price = live[r.ticker] ?? null;
      if (price === null) price = saved[r.ticker] ? saved[r.ticker].price : null;
      if (price !== null && price !== undefined) totalMarket += r.shares * price;
      else hasPrices = false;
    }
    const pl = hasPrices ? totalMarket - totalInvested : null;
    const plPct = pl !== null && totalInvested > 0 ? pl / totalInvested * 100 : null;
    return {
      total_invested: pyRound(totalInvested, 2),
      total_market_value: hasPrices ? pyRound(totalMarket, 2) : null,
      pl: pl !== null ? pyRound(pl, 2) : null,
      pl_pct: plPct !== null ? pyRound(plPct, 2) : null,
      positions_count: rows.length,
      prices_available: hasPrices,
    };
  });

  route('GET', `${INV}/history`, () => {
    const rows = DB().all(`
      SELECT substr(date, 1, 7) as month,
             SUM(ABS(amount)) as total,
             COUNT(*) as count
      FROM transactions
      WHERE subcategory = 'ETF investment'
        AND amount < 0
        AND ${CONFIRMED}
      GROUP BY month
      ORDER BY month
    `);
    let cumulative = 0;
    return rows.map(r => {
      cumulative += r.total;
      return { month: r.month, amount: pyRound(r.total, 2), cumulative: pyRound(cumulative, 2), count: r.count };
    });
  });

  route('GET', `${INV}/allocation`, async () => {
    const rows = DB().all('SELECT ticker, name, asset_type, shares, avg_price FROM holdings');
    const tickers = rows.map(r => r.ticker);
    const live = await fetchCurrentPrices(tickers);
    const saved = getLastSavedPrices(tickers);

    const byType = new Map();
    const byTicker = new Map();
    for (const r of rows) {
      let price = live[r.ticker] ?? null;
      if (price === null) price = saved[r.ticker] ? saved[r.ticker].price : null;
      if (price === null || price === undefined) price = r.avg_price;
      const value = r.shares * price;
      byType.set(r.asset_type, (byType.get(r.asset_type) || 0) + value);
      byTicker.set(r.ticker, { name: r.name, value: pyRound(value, 2), asset_type: r.asset_type });
    }
    let total = 0;
    byType.forEach(v => { total += v; });
    return {
      by_type: [...byType].map(([k, v]) => ({ type: k, value: pyRound(v, 2), pct: total > 0 ? pyRound(v / total * 100, 1) : 0 })),
      by_ticker: [...byTicker].map(([k, v]) => ({
        ticker: k, name: v.name, value: v.value,
        pct: total > 0 ? pyRound(v.value / total * 100, 1) : 0,
        asset_type: v.asset_type,
      })),
      total: pyRound(total, 2),
    };
  });

  route('GET', `${INV}/price-history`, async (_, q) => {
    if (q.ticker === null) throw v422("Parametro 'ticker' obbligatorio");
    const ticker = q.ticker;
    const period = q.period || '6mo';
    if (!priceProvider || !priceProvider.history) {
      return { ticker, data: [], error: 'yfinance non disponibile' };
    }
    try {
      const data = (await priceProvider.history(ticker, period))
        .map(d => ({ date: d.date, price: pyRound(d.price, 4) }));
      return { ticker, period, data };
    } catch (e) {
      return { ticker, data: [], error: String(e && e.message || e) };
    }
  });

  route('POST', `${INV}/refresh-prices`, async () => {
    const tickers = DB().all('SELECT DISTINCT ticker FROM holdings').map(r => r.ticker);
    const prices = await fetchCurrentPrices(tickers);
    const today = localToday();
    const toSave = Object.entries(prices).filter(([, p]) => p !== null);
    if (toSave.length) {
      await DB().write(() => {
        for (const [ticker, price] of toSave) {
          DB().run(
            `INSERT INTO portfolio_valuations (ticker, date, market_price)
             VALUES (?, ?, ?)
             ON CONFLICT(ticker, date) DO UPDATE SET market_price = excluded.market_price`,
            [ticker, today, price]);
        }
      });
    }
    return { refreshed: toSave.length, total: tickers.length, date: today };
  });

  // ════════════════════════════════════════════════════════════════════
  //  Dispatch + intercettazione fetch
  // ════════════════════════════════════════════════════════════════════

  /**
   * Esegue una richiesta sul backend locale.
   * Ritorna { status, data } (data = JSON della risposta) oppure,
   * per risposte binarie (export), { status, response }.
   */
  async function request(method, url, body) {
    method = (method || 'GET').toUpperCase();
    const u = new URL(url, 'http://local');
    const query = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? u.searchParams.get(k) : undefined) });
    let pathMatched = false;
    try {
      for (const r of routes) {
        const m = r.rx.exec(u.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        await DB().ready();
        const out = await r.handler(params, query, body);
        if (out instanceof Response) return { status: out.status, response: out };
        return { status: 200, data: out };
      }
      if (pathMatched) return { status: 405, data: { detail: 'Method Not Allowed' } };
      return { status: 404, data: { detail: 'Not Found' } };
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('[LocalApi]', method, url, e);
      return { status, data: { detail: e.detail || e.message || String(e) } };
    }
  }

  function isLocalApiUrl(url) {
    if (typeof url !== 'string') return false;
    if (url.startsWith('/api/') || url === '/health') return true;
    try {
      const u = new URL(url, global.location.href);
      return u.origin === global.location.origin && (u.pathname.startsWith('/api/') || u.pathname === '/health');
    } catch (e) { return false; }
  }

  let realFetch = null;

  function install() {
    if (realFetch) return;
    realFetch = global.fetch.bind(global);
    global.fetch = async function (input, init) {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      const url = isReq ? input.url : String(input);
      if (!isLocalApiUrl(url)) return realFetch(input, init);

      const method = (init && init.method) || (isReq ? input.method : 'GET');
      let raw = init && init.body !== undefined ? init.body : (isReq ? await input.text() : undefined);
      let body;
      if (typeof raw === 'string' && raw.length) {
        try { body = JSON.parse(raw); } catch (e) {
          return new Response(JSON.stringify({ detail: 'JSON non valido' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
        }
      }
      const res = await request(method, url, body);
      if (res.response) return res.response;
      return new Response(JSON.stringify(res.data), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    };
  }

  global.LocalApi = {
    install,
    request,
    exportSheets,
    setPriceProvider(p) { priceProvider = p; },
    setBackupHandler(h) { backupHandler = h; },
    get installed() { return !!realFetch; },
    /** fetch originale (per parlare davvero col Pi quando serve). */
    get realFetch() { return realFetch || global.fetch.bind(global); },
    _pyRound: pyRound,
  };
})(typeof window !== 'undefined' ? window : globalThis);
