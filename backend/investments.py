"""
Router investimenti — da importare in main.py con:

    from investments import router as investments_router
    app.include_router(investments_router)

Endpoint:
    GET  /api/investments/holdings        — lista posizioni + prezzo attuale
    POST /api/investments/holdings        — aggiungi posizione
    PUT  /api/investments/holdings/{id}   — modifica posizione
    DELETE /api/investments/holdings/{id} — elimina posizione
    GET  /api/investments/summary         — KPI: investito, valore, P&L
    GET  /api/investments/history         — storico versamenti (da transactions)
    GET  /api/investments/allocation      — allocazione per tipo/ticker
    GET  /api/investments/price-history?ticker=&period= — storico prezzi per chart
    POST /api/investments/refresh-prices  — aggiorna prezzi da API e salva in DB
"""
import sqlite3
import os
import logging
from datetime import datetime, date
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/investments", tags=["investments"])

DB_PATH = os.environ.get("DB_PATH", "/data/budget.db")

# ── yfinance import con fallback ────────────────────────────────────
try:
    import yfinance as yf
    YFINANCE_AVAILABLE = True
except ImportError:
    YFINANCE_AVAILABLE = False
    logger.warning("yfinance non installato — prezzi di mercato non disponibili")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ── Modelli Pydantic ────────────────────────────────────────────────

class HoldingCreate(BaseModel):
    ticker: str
    name: str
    asset_type: str = "ETF"
    shares: float
    avg_price: float
    currency: str = "EUR"
    opened_at: str  # YYYY-MM-DD
    notes: str = ""

class HoldingUpdate(BaseModel):
    ticker: Optional[str] = None
    name: Optional[str] = None
    asset_type: Optional[str] = None
    shares: Optional[float] = None
    avg_price: Optional[float] = None
    currency: Optional[str] = None
    opened_at: Optional[str] = None
    notes: Optional[str] = None


# ── Utilità prezzi ──────────────────────────────────────────────────

def fetch_current_prices(tickers: list[str]) -> dict[str, float | None]:
    """Recupera ultimo prezzo per ogni ticker via yfinance."""
    prices = {}
    if not YFINANCE_AVAILABLE:
        return {t: None for t in tickers}

    for ticker in tickers:
        try:
            t = yf.Ticker(ticker)
            info = t.fast_info
            prices[ticker] = round(info.last_price, 4)
        except Exception as e:
            logger.warning(f"Errore prezzo {ticker}: {e}")
            prices[ticker] = None
    return prices


def get_last_saved_prices(conn, tickers: list[str]) -> dict[str, dict]:
    """Recupera ultimo prezzo salvato nel DB per ogni ticker."""
    result = {}
    for ticker in tickers:
        row = conn.execute(
            """SELECT market_price, date FROM portfolio_valuations
               WHERE ticker = ? ORDER BY date DESC LIMIT 1""",
            (ticker,)
        ).fetchone()
        if row:
            result[ticker] = {"price": row["market_price"], "date": row["date"]}
        else:
            result[ticker] = {"price": None, "date": None}
    return result


# ── ENDPOINT: Lista holdings ────────────────────────────────────────

@router.get("/holdings")
def list_holdings():
    conn = get_db()
    rows = conn.execute("SELECT * FROM holdings ORDER BY opened_at").fetchall()
    tickers = [r["ticker"] for r in rows]

    # Prova prezzi live, fallback a ultimo salvato
    live_prices = fetch_current_prices(tickers)
    saved_prices = get_last_saved_prices(conn, tickers)

    holdings = []
    for r in rows:
        ticker = r["ticker"]
        current_price = live_prices.get(ticker)
        price_source = "live"

        if current_price is None and saved_prices.get(ticker, {}).get("price"):
            current_price = saved_prices[ticker]["price"]
            price_source = f"saved ({saved_prices[ticker]['date']})"

        invested = r["shares"] * r["avg_price"]
        market_value = r["shares"] * current_price if current_price else None
        pl = market_value - invested if market_value else None
        pl_pct = (pl / invested * 100) if pl is not None and invested > 0 else None

        holdings.append({
            "id": r["id"],
            "ticker": ticker,
            "name": r["name"],
            "asset_type": r["asset_type"],
            "shares": r["shares"],
            "avg_price": r["avg_price"],
            "currency": r["currency"],
            "opened_at": r["opened_at"],
            "notes": r["notes"],
            "current_price": current_price,
            "price_source": price_source,
            "invested": round(invested, 2),
            "market_value": round(market_value, 2) if market_value else None,
            "pl": round(pl, 2) if pl is not None else None,
            "pl_pct": round(pl_pct, 2) if pl_pct is not None else None,
        })

    conn.close()
    return holdings


# ── ENDPOINT: Aggiungi holding ──────────────────────────────────────

@router.post("/holdings")
def create_holding(h: HoldingCreate):
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO holdings (ticker, name, asset_type, shares, avg_price, currency, opened_at, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (h.ticker, h.name, h.asset_type, h.shares, h.avg_price, h.currency, h.opened_at, h.notes)
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id, "message": "Posizione aggiunta"}


# ── ENDPOINT: Modifica holding ──────────────────────────────────────

@router.put("/holdings/{holding_id}")
def update_holding(holding_id: int, h: HoldingUpdate):
    conn = get_db()
    existing = conn.execute("SELECT * FROM holdings WHERE id = ?", (holding_id,)).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(404, "Holding non trovata")

    updates = {}
    for field in ["ticker", "name", "asset_type", "shares", "avg_price", "currency", "opened_at", "notes"]:
        val = getattr(h, field)
        if val is not None:
            updates[field] = val

    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [holding_id]
        conn.execute(f"UPDATE holdings SET {set_clause} WHERE id = ?", values)
        conn.commit()

    conn.close()
    return {"message": "Posizione aggiornata"}


# ── ENDPOINT: Elimina holding ───────────────────────────────────────

@router.delete("/holdings/{holding_id}")
def delete_holding(holding_id: int):
    conn = get_db()
    existing = conn.execute("SELECT * FROM holdings WHERE id = ?", (holding_id,)).fetchone()
    if not existing:
        conn.close()
        raise HTTPException(404, "Holding non trovata")

    conn.execute("DELETE FROM holdings WHERE id = ?", (holding_id,))
    conn.commit()
    conn.close()
    return {"message": "Posizione eliminata"}


# ── ENDPOINT: Summary (KPI) ────────────────────────────────────────

@router.get("/summary")
def investment_summary():
    conn = get_db()
    rows = conn.execute("SELECT ticker, shares, avg_price FROM holdings").fetchall()
    tickers = [r["ticker"] for r in rows]

    live_prices = fetch_current_prices(tickers)
    saved_prices = get_last_saved_prices(conn, tickers)

    total_invested = 0.0
    total_market = 0.0
    has_prices = True

    for r in rows:
        invested = r["shares"] * r["avg_price"]
        total_invested += invested

        price = live_prices.get(r["ticker"])
        if price is None:
            price = saved_prices.get(r["ticker"], {}).get("price")
        if price is not None:
            total_market += r["shares"] * price
        else:
            has_prices = False

    pl = total_market - total_invested if has_prices else None
    pl_pct = (pl / total_invested * 100) if pl is not None and total_invested > 0 else None

    conn.close()
    return {
        "total_invested": round(total_invested, 2),
        "total_market_value": round(total_market, 2) if has_prices else None,
        "pl": round(pl, 2) if pl is not None else None,
        "pl_pct": round(pl_pct, 2) if pl_pct is not None else None,
        "positions_count": len(rows),
        "prices_available": has_prices,
    }


# ── ENDPOINT: Storico versamenti ────────────────────────────────────

@router.get("/history")
def investment_history():
    """Estrae i versamenti verso investimenti dalla tabella transactions.
    Cerca transazioni con category = 'Investments' o subcategory contenente 'invest'.
    """
    conn = get_db()
    rows = conn.execute("""
        SELECT substr(date, 1, 7) as month,
               SUM(ABS(amount)) as total,
               COUNT(*) as count
        FROM transactions
        WHERE (LOWER(category) LIKE '%invest%'
               OR LOWER(subcategory) LIKE '%invest%')
          AND amount < 0
        GROUP BY month
        ORDER BY month
    """).fetchall()

    # Calcola cumulativo
    history = []
    cumulative = 0.0
    for r in rows:
        cumulative += r["total"]
        history.append({
            "month": r["month"],
            "amount": round(r["total"], 2),
            "cumulative": round(cumulative, 2),
            "count": r["count"],
        })

    conn.close()
    return history


# ── ENDPOINT: Allocazione ───────────────────────────────────────────

@router.get("/allocation")
def investment_allocation():
    conn = get_db()
    rows = conn.execute(
        "SELECT ticker, name, asset_type, shares, avg_price FROM holdings"
    ).fetchall()
    tickers = [r["ticker"] for r in rows]

    live_prices = fetch_current_prices(tickers)
    saved_prices = get_last_saved_prices(conn, tickers)

    # Per tipo
    by_type = {}
    # Per ticker
    by_ticker = {}

    for r in rows:
        price = live_prices.get(r["ticker"])
        if price is None:
            price = saved_prices.get(r["ticker"], {}).get("price")
        if price is None:
            price = r["avg_price"]  # fallback a prezzo di carico

        value = r["shares"] * price

        atype = r["asset_type"]
        by_type[atype] = by_type.get(atype, 0) + value
        by_ticker[r["ticker"]] = {
            "name": r["name"],
            "value": round(value, 2),
            "asset_type": atype,
        }

    total = sum(by_type.values())
    conn.close()

    return {
        "by_type": [
            {"type": k, "value": round(v, 2), "pct": round(v / total * 100, 1) if total > 0 else 0}
            for k, v in by_type.items()
        ],
        "by_ticker": [
            {"ticker": k, "name": v["name"], "value": v["value"],
             "pct": round(v["value"] / total * 100, 1) if total > 0 else 0,
             "asset_type": v["asset_type"]}
            for k, v in by_ticker.items()
        ],
        "total": round(total, 2),
    }


# ── ENDPOINT: Storico prezzi per grafici ────────────────────────────

@router.get("/price-history")
def price_history(ticker: str, period: str = "6mo"):
    """Storico prezzi da yfinance per il line chart.
    Periodi validi: 1mo, 3mo, 6mo, 1y, 2y, 5y, max
    """
    if not YFINANCE_AVAILABLE:
        return {"ticker": ticker, "data": [], "error": "yfinance non disponibile"}

    try:
        t = yf.Ticker(ticker)
        hist = t.history(period=period)
        data = [
            {"date": idx.strftime("%Y-%m-%d"), "price": round(row["Close"], 4)}
            for idx, row in hist.iterrows()
        ]
        return {"ticker": ticker, "period": period, "data": data}
    except Exception as e:
        logger.warning(f"Errore storico {ticker}: {e}")
        return {"ticker": ticker, "data": [], "error": str(e)}


# ── ENDPOINT: Aggiorna prezzi e salva ───────────────────────────────

@router.post("/refresh-prices")
def refresh_prices():
    """Scarica prezzi attuali da API e li salva in portfolio_valuations."""
    conn = get_db()
    tickers = [r["ticker"] for r in conn.execute("SELECT DISTINCT ticker FROM holdings").fetchall()]
    prices = fetch_current_prices(tickers)

    today = date.today().isoformat()
    saved = 0
    for ticker, price in prices.items():
        if price is not None:
            conn.execute(
                """INSERT INTO portfolio_valuations (ticker, date, market_price)
                   VALUES (?, ?, ?)
                   ON CONFLICT(ticker, date) DO UPDATE SET market_price = excluded.market_price""",
                (ticker, today, price)
            )
            saved += 1

    conn.commit()
    conn.close()
    return {"refreshed": saved, "total": len(tickers), "date": today}