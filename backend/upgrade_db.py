"""
Aggiornamento schema DB — aggiunge Transfer e saldi conto
senza toccare transazioni e categorie esistenti.

Uso:
  python upgrade_db.py /path/to/budget.db
"""

import sys
import sqlite3
from pathlib import Path


def upgrade(db_path: str):
    db = Path(db_path)
    if not db.exists():
        print(f"DB non trovato: {db}")
        sys.exit(1)

    conn = sqlite3.connect(str(db))
    cursor = conn.cursor()

    # --- 1. Fix CHECK constraint su categories per accettare 'Transfer' ---
    schema = cursor.execute("SELECT sql FROM sqlite_master WHERE name='categories'").fetchone()[0]
    if "'Transfer'" not in schema:
        print("🔧 Aggiornamento constraint categories...")
        cursor.executescript("""
            ALTER TABLE categories RENAME TO categories_old;

            CREATE TABLE categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                subcategory TEXT NOT NULL UNIQUE,
                category_type TEXT NOT NULL CHECK(category_type IN ('Income', 'Expense', 'Transfer'))
            );

            INSERT INTO categories (id, category, subcategory, category_type)
            SELECT id, category, subcategory, category_type FROM categories_old;

            DROP TABLE categories_old;
        """)
        print("✅ Constraint aggiornato")
    else:
        print("✅ Constraint già OK")

    # --- 2. Crea tabella account_balances se non esiste ---
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS account_balances (
            account TEXT PRIMARY KEY,
            balance REAL NOT NULL,
            as_of_date TEXT NOT NULL
        )
    """)
    print("✅ Tabella account_balances pronta")

    # --- 2. Inserisci snapshot saldi (28/04/2026) ---
    snapshot_date = '2026-04-28'
    balances = [
        ('Unicredit', 1298.98, snapshot_date),
        ('Revolut', 10.35, snapshot_date),
        ('Contanti', 0.0, snapshot_date),
    ]
    cursor.executemany(
        "INSERT OR REPLACE INTO account_balances (account, balance, as_of_date) VALUES (?, ?, ?)",
        balances
    )
    print(f"✅ Snapshot saldi inseriti (al {snapshot_date})")

    # --- 3. Aggiungi categorie Transfer se non esistono ---
    transfer_cats = [
        ('Transfer', 'Transfer to Revolut', 'Transfer'),
        ('Transfer', 'Transfer to Unicredit', 'Transfer'),
        ('Transfer', 'Transfer to Contanti', 'Transfer'),
        ('Transfer', 'Transfer from Revolut', 'Transfer'),
        ('Transfer', 'Transfer from Unicredit', 'Transfer'),
        ('Transfer', 'Transfer from Contanti', 'Transfer'),
    ]
    for cat, sub, ctype in transfer_cats:
        cursor.execute(
            "INSERT OR IGNORE INTO categories (category, subcategory, category_type) VALUES (?, ?, ?)",
            (cat, sub, ctype)
        )
    print("✅ Categorie Transfer aggiunte")

    conn.commit()

    # --- Verifica ---
    cat_count = cursor.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    tx_count = cursor.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    bal_count = cursor.execute("SELECT COUNT(*) FROM account_balances").fetchone()[0]
    print(f"\n📊 Stato DB:")
    print(f"   Categorie: {cat_count}")
    print(f"   Transazioni: {tx_count}")
    print(f"   Conti tracciati: {bal_count}")

    conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python upgrade_db.py <budget.db>")
        sys.exit(1)
    upgrade(sys.argv[1])