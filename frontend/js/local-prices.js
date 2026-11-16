/*
 * Prezzi di mercato per l'app (sostituto di yfinance sul Pi).
 *
 * Usa la stessa fonte di yfinance: l'API "chart" di Yahoo Finance
 * (query1.finance.yahoo.com/v8/finance/chart/<ticker>), chiamata dal lato
 * nativo con CapacitorHttp perché dal WebView il CORS la bloccherebbe.
 *
 *   current(tickers)        -> {ticker: {price, date} | null}: ultima chiusura
 *                              giornaliera non rettificata e la sua data
 *                              (= fetch_current_quotes in investments.py)
 *   history(ticker, period) -> [{date: 'YYYY-MM-DD', price}] (= history(period).Close)
 *
 * yfinance history() usa auto_adjust=True, quindi Close è il prezzo
 * rettificato: qui si usa adjclose quando c'è. Le date sono nel fuso della
 * borsa (gmtoffset), come l'indice di yfinance.
 *
 * Cache di 2 minuti per i prezzi correnti: holdings, summary e allocation
 * chiedono gli stessi ticker a ogni apertura della pagina.
 */
(function (root) {
  'use strict';

  const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
  const PERIODS = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
  const CURRENT_TTL = 2 * 60 * 1000;
  const UA = 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

  // httpGet(url, headers) -> Promise<{status, data}> (data: oggetto o stringa JSON)
  function create({ httpGet, now = () => Date.now() }) {
    const cache = new Map(); // ticker -> {at, quote}
    const inflight = new Map(); // ticker -> Promise<{price, date}|null>

    async function chart(ticker, params) {
      const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const res = await httpGet(`${BASE}${encodeURIComponent(ticker)}?${qs}`, { 'User-Agent': UA, Accept: 'application/json' });
      let body = res.data;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      const err = body && body.chart && body.chart.error;
      if (err) throw new Error(err.description || err.code || 'Errore Yahoo Finance');
      if (res.status !== 200) throw new Error(`Yahoo Finance HTTP ${res.status}`);
      const result = body && body.chart && body.chart.result && body.chart.result[0];
      if (!result) throw new Error(`Nessun dato per ${ticker}`);
      return result;
    }

    // Data (YYYY-MM-DD) nel fuso della borsa, come l'indice di yfinance
    const dayOf = (t, offset) => new Date((t + (offset || 0)) * 1000).toISOString().slice(0, 10);

    async function fetchCurrent(ticker) {
      // Ultima chiusura (non rettificata) della serie e la sua data;
      // regularMarketPrice solo se la serie è vuota. Per alcuni ETF
      // (es. CEU2.MI) regularMarketPrice è fermo da mesi.
      const r = await chart(ticker, { range: '5d', interval: '1d' });
      const meta = r.meta || {};
      const ts = r.timestamp || [];
      const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
      for (let i = Math.min(ts.length, closes.length) - 1; i >= 0; i--) {
        if (Number.isFinite(closes[i])) return { price: closes[i], date: dayOf(ts[i], meta.gmtoffset) };
      }
      if (Number.isFinite(meta.regularMarketPrice)) {
        return { price: meta.regularMarketPrice, date: meta.regularMarketTime ? dayOf(meta.regularMarketTime, meta.gmtoffset) : null };
      }
      return null;
    }

    function currentOne(ticker) {
      const c = cache.get(ticker);
      if (c && now() - c.at < CURRENT_TTL) return Promise.resolve(c.quote);
      if (inflight.has(ticker)) return inflight.get(ticker);
      const p = fetchCurrent(ticker)
        .then(quote => { cache.set(ticker, { at: now(), quote }); return quote; })
        .catch(e => { console.warn('[LocalPrices]', ticker, e && e.message || e); return null; })
        .finally(() => inflight.delete(ticker));
      inflight.set(ticker, p);
      return p;
    }

    async function current(tickers) {
      const quotes = await Promise.all(tickers.map(currentOne));
      const out = {};
      tickers.forEach((t, i) => { out[t] = quotes[i]; });
      return out;
    }

    async function history(ticker, period = '6mo') {
      if (!PERIODS.has(period)) throw new Error(`Periodo non valido: ${period}`);
      const r = await chart(ticker, { range: period, interval: '1d' });
      const ts = r.timestamp || [];
      const adj = r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
      const close = r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
      const series = adj || close || [];
      const offset = r.meta && r.meta.gmtoffset;
      const out = [];
      ts.forEach((t, i) => {
        const price = series[i];
        if (!Number.isFinite(price)) return; // yfinance scarta le righe NaN
        const date = dayOf(t, offset);
        if (out.length && out[out.length - 1].date === date) out[out.length - 1].price = price;
        else out.push({ date, price });
      });
      return out;
    }

    function clearCache() { cache.clear(); }

    return { current, history, clearCache };
  }

  // Provider per l'app: richieste native via CapacitorHttp (niente CORS)
  function capacitor(CapacitorHttp) {
    return create({
      httpGet: (url, headers) => CapacitorHttp.get({ url, headers, connectTimeout: 8000, readTimeout: 15000 }),
    });
  }

  const LocalPrices = { create, capacitor };
  if (typeof module !== 'undefined' && module.exports) module.exports = LocalPrices;
  root.LocalPrices = LocalPrices;
})(typeof window !== 'undefined' ? window : globalThis);
