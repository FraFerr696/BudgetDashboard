"""
Upgrade DB: aggiunge il conto Trade Republic (idempotente).

- sottocategorie Transfer to/from Trade Republic (per "Trasferisci")
- saldo iniziale in account_balances: 76.44 al 2026-11-22 (il saldo conta le
  transazioni con data > as_of_date, quindi anche quelle di oggi)

Stesse righe di LocalDB.ensureSchema in frontend/js/local-db.js (l'app le
aggiunge da sola). Righe già presenti non vengono toccate.

Uso:
    docker compose exec -T backend python upgrade_db_trade_republic.py /data/budget.db
"""
import sqlite3
import sys

ACCOUNT = "Trade Republic"
BALANCE = 76.44
AS_OF = "2026-11-22"


def upgrade(db_path: str, verbose: bool = True):
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    for sub in (f"Transfer to {ACCOUNT}", f"Transfer from {ACCOUNT}"):
        c.execute(
            "INSERT OR IGNORE INTO categories (category, subcategory, category_type) VALUES ('Transfer', ?, 'Transfer')",
            (sub,),
        )
        if verbose:
            print(("✅ Aggiunta" if c.rowcount else "ℹ️  Già presente") + f": Transfer → {sub}")
    c.execute(
        "INSERT OR IGNORE INTO account_balances (account, balance, as_of_date) VALUES (?, ?, ?)",
        (ACCOUNT, BALANCE, AS_OF),
    )
    if verbose:
        print(("✅ Aggiunto" if c.rowcount else "ℹ️  Già presente") + f": saldo {ACCOUNT} {BALANCE} al {AS_OF}")
    conn.commit()
    conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python upgrade_db_trade_republic.py <path_db>")
        sys.exit(1)
    upgrade(sys.argv[1])
