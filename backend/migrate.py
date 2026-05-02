"""
Migrazione Excel → SQLite

Legge BudgetTracker.xlsx e crea budget.db con le tabelle:
- categories (category, subcategory, category_type)
- transactions (id, date, account, notes, debit, credit, amount, subcategory, category, category_type)

Uso:
  python migrate.py /path/to/BudgetTracker.xlsx /path/to/budget.db
"""

import sys
import sqlite3
import pandas as pd
from pathlib import Path


def migrate(excel_path: str, db_path: str):
    excel = Path(excel_path)
    if not excel.exists():
        print(f"File non trovato: {excel}")
        sys.exit(1)

    print(f"Lettura {excel}...")

    # --- Categories ---
    df_cat = pd.read_excel(excel, sheet_name="Categories", header=None)
    header_row = None
    for i, row in df_cat.iterrows():
        if any(str(v).strip() == 'Category' for v in row if pd.notna(v)):
            header_row = i
            break
    df_cat.columns = df_cat.iloc[header_row]
    df_cat = df_cat.iloc[header_row + 1:].reset_index(drop=True)
    df_cat = df_cat[['Category', 'Subcategory', 'Category Type']].dropna(subset=['Subcategory'])
    df_cat = df_cat[df_cat['Subcategory'].astype(str).str.strip() != '']
    df_cat.columns = ['category', 'subcategory', 'category_type']
    df_cat['category'] = df_cat['category'].astype(str).str.strip()
    df_cat['subcategory'] = df_cat['subcategory'].astype(str).str.strip()
    df_cat['category_type'] = df_cat['category_type'].astype(str).str.strip()
    df_cat = df_cat.drop_duplicates(subset=['subcategory'], keep='first')
    print(f"  Categorie trovate: {len(df_cat)}")

    # --- Transactions ---
    df = pd.read_excel(excel, sheet_name="Bank Transactions", header=2)
    df = df[['Account', 'Date', 'Notes', 'Debit (Spend)', 'Credit (Income)',
             'Income/(Expense)', 'Subcategory', 'Category', 'Category Type']]
    df = df.dropna(subset=['Date', 'Category Type'])
    df = df[df['Category Type'].isin(['Income', 'Expense'])]
    df['Category'] = df['Category'].replace('Vairable', 'Variable')
    df['Subcategory'] = df['Subcategory'].replace('Vairable', 'Variable')
    df['Date'] = pd.to_datetime(df['Date']).dt.strftime('%Y-%m-%d')
    df['Income/(Expense)'] = pd.to_numeric(df['Income/(Expense)'], errors='coerce').fillna(0)
    df['Notes'] = df['Notes'].fillna('')
    df['Subcategory'] = df['Subcategory'].fillna('Other')

    df.columns = ['account', 'date', 'notes', 'debit', 'credit', 'amount',
                  'subcategory', 'category', 'category_type']
    print(f"  Transazioni trovate: {len(df)}")

    # --- Scrivi in SQLite ---
    db = Path(db_path)
    conn = sqlite3.connect(str(db))
    cursor = conn.cursor()

    cursor.executescript("""
        DROP TABLE IF EXISTS transactions;
        DROP TABLE IF EXISTS categories;

        CREATE TABLE categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            subcategory TEXT NOT NULL UNIQUE,
            category_type TEXT NOT NULL CHECK(category_type IN ('Income', 'Expense'))
        );

        CREATE TABLE transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            account TEXT NOT NULL,
            notes TEXT DEFAULT '',
            debit REAL,
            credit REAL,
            amount REAL NOT NULL,
            subcategory TEXT NOT NULL,
            category TEXT NOT NULL,
            category_type TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_tx_date ON transactions(date);
        CREATE INDEX idx_tx_category ON transactions(category);
        CREATE INDEX idx_tx_month ON transactions(substr(date, 1, 7));
    """)

    df_cat.to_sql('categories', conn, if_exists='append', index=False)
    df.to_sql('transactions', conn, if_exists='append', index=False)

    conn.commit()

    # Verifica
    count_cat = cursor.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    count_tx = cursor.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    total = cursor.execute("SELECT SUM(amount) FROM transactions").fetchone()[0]

    print(f"\n✅ Migrazione completata → {db}")
    print(f"   Categorie: {count_cat}")
    print(f"   Transazioni: {count_tx}")
    print(f"   Saldo totale: €{total:.2f}")

    conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python migrate.py <BudgetTracker.xlsx> <budget.db>")
        sys.exit(1)
    migrate(sys.argv[1], sys.argv[2])