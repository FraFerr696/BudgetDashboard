"""
Upgrade DB: aggiunge nuove sottocategorie alla tabella categories (idempotente).

Uso:
    docker compose exec backend python upgrade_db_categories.py /data/budget.db
"""
import sqlite3
import sys

NEW_CATEGORIES = [
    # (category, subcategory, category_type)
    ("Shopping", "Sports Equipment", "Expense"),
]


def upgrade(db_path: str):
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    for cat, sub, ctype in NEW_CATEGORIES:
        c.execute(
            "INSERT OR IGNORE INTO categories (category, subcategory, category_type) VALUES (?, ?, ?)",
            (cat, sub, ctype),
        )
        print(("✅ Aggiunta" if c.rowcount else "ℹ️  Già presente") + f": {cat} → {sub} ({ctype})")
    conn.commit()
    conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python upgrade_db_categories.py <path_db>")
        sys.exit(1)
    upgrade(sys.argv[1])
