"""
Upgrade idempotente: aggiunge colonna 'isin' a holdings e sostituisce
gli ETF demo con le posizioni reali.

Uso:
    python upgrade_db_investments.py /path/to/budget.db
"""
import sqlite3
import sys

REAL_ETFS = [
    # ticker, name, asset_type, shares, avg_price, currency, opened_at, notes, isin
    ("UST.MI", "Amundi Core Nasdaq-100 Swap UCITS ETF Acc", "ETF", 0, 102.59, "EUR", "2026-11-13", "", "LU1829221024"),
    ("CEU2.MI", "Amundi Core MSCI Europe UCITS ETF Acc", "ETF", 0, 103.90, "EUR", "2026-11-13", "", "LU1437015735"),
]

DEMO_TICKERS = ["VWCE.DE", "SWDA.MI", "AGGH.MI"]


def upgrade(db_path: str):
    conn = sqlite3.connect(db_path)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(holdings)").fetchall()]

    if "isin" not in cols:
        conn.execute("ALTER TABLE holdings ADD COLUMN isin TEXT DEFAULT ''")
        print("Colonna 'isin' aggiunta a holdings.")
    else:
        print("Colonna 'isin' già presente.")

    for ticker in DEMO_TICKERS:
        cur = conn.execute("DELETE FROM holdings WHERE ticker = ?", (ticker,))
        if cur.rowcount:
            print(f"Rimossa posizione demo: {ticker}")

    for ticker, name, asset_type, shares, avg_price, currency, opened_at, notes, isin in REAL_ETFS:
        existing = conn.execute("SELECT id FROM holdings WHERE ticker = ?", (ticker,)).fetchone()
        if existing:
            print(f"{ticker} già presente, skip inserimento.")
            continue
        conn.execute(
            """INSERT INTO holdings (ticker, name, asset_type, shares, avg_price, currency, opened_at, notes, isin)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (ticker, name, asset_type, shares, avg_price, currency, opened_at, notes, isin)
        )
        print(f"Aggiunto {ticker} ({name})")

    conn.commit()
    conn.close()
    print("Upgrade completato.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Uso: python upgrade_db_investments.py /path/to/budget.db")
        sys.exit(1)
    upgrade(sys.argv[1])
