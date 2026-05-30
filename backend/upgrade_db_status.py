"""
Upgrade DB: aggiunge colonna 'status' alla tabella transactions.
Valori possibili: 'confirmed' (default), 'planned'.

Eseguire una sola volta:
    docker compose run --rm backend python upgrade_db_status.py /data/budget.db

Le transazioni esistenti vengono tutte marcate come 'confirmed'.
"""
import sqlite3
import sys


def upgrade(db_path: str):
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Controlla se la colonna esiste già
    columns = [row[1] for row in c.execute("PRAGMA table_info(transactions)").fetchall()]
    if "status" in columns:
        print("Colonna 'status' già presente, nessuna modifica.")
        conn.close()
        return

    # Aggiungi colonna con default 'confirmed'
    c.execute("ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'")

    # Crea indice per query filtrate
    c.execute("CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)")

    conn.commit()
    conn.close()
    print("Upgrade completato: colonna 'status' aggiunta (default='confirmed').")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python upgrade_db_status.py <path_db>")
        sys.exit(1)
    upgrade(sys.argv[1])
