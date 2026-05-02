from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from datetime import date
import sqlite3
import os
import io

app = FastAPI(title="Budget Dashboard API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = os.getenv("DB_PATH", "/data/budget.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


class NewTransaction(BaseModel):
    date: date
    account: str
    amount: float
    subcategory: str
    notes: str = ""


# ── Health ──────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── Transactions list ───────────────────────────────

@app.get("/api/transactions")
def get_transactions(month: str = None, category: str = None, account: str = None, category_type: str = None):
    conn = get_db()
    query = "SELECT id, date, account, notes, amount, subcategory, category, category_type FROM transactions WHERE 1=1"
    params = []

    if month:
        query += " AND substr(date, 1, 7) = ?"
        params.append(month)
    if category:
        query += " AND category = ?"
        params.append(category)
    if account:
        query += " AND account = ?"
        params.append(account)
    if category_type:
        query += " AND category_type = ?"
        params.append(category_type)

    query += " ORDER BY date DESC, id DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()

    return [
        {
            "id": r["id"],
            "Date": r["date"],
            "Account": r["account"],
            "Notes": r["notes"] or "",
            "Income/(Expense)": r["amount"],
            "Subcategory": r["subcategory"],
            "Category": r["category"],
            "Category Type": r["category_type"],
        }
        for r in rows
    ]


# ── Summary KPI ─────────────────────────────────────

@app.get("/api/summary")
def get_summary(month: str = None):
    conn = get_db()
    where = "WHERE substr(date, 1, 7) = ?" if month else "WHERE 1=1"
    params = [month] if month else []

    income = conn.execute(
        f"SELECT COALESCE(SUM(amount), 0) FROM transactions {where} AND category_type = 'Income'",
        params
    ).fetchone()[0]

    expenses_raw = conn.execute(
        f"SELECT COALESCE(SUM(amount), 0) FROM transactions {where} AND category_type = 'Expense'",
        params
    ).fetchone()[0]

    count = conn.execute(
        f"SELECT COUNT(*) FROM transactions {where} AND category_type != 'Transfer'",
        params
    ).fetchone()[0]

    conn.close()

    return {
        "total_income": round(income, 2),
        "total_expenses": round(abs(expenses_raw), 2),
        "balance": round(income + expenses_raw, 2),
        "transaction_count": count,
    }


# ── By month ────────────────────────────────────────

@app.get("/api/by-month")
def get_by_month():
    conn = get_db()
    rows = conn.execute("""
        SELECT
            substr(date, 1, 7) AS month,
            SUM(CASE WHEN category_type = 'Income' THEN amount ELSE 0 END) AS income,
            SUM(CASE WHEN category_type = 'Expense' THEN ABS(amount) ELSE 0 END) AS expenses
        FROM transactions
        WHERE category_type != 'Transfer'
        GROUP BY month
        ORDER BY month
    """).fetchall()
    conn.close()

    return [
        {
            "month": r["month"],
            "income": round(r["income"], 2),
            "expenses": round(r["expenses"], 2),
            "balance": round(r["income"] - r["expenses"], 2),
        }
        for r in rows
    ]


# ── By category ─────────────────────────────────────

@app.get("/api/by-category")
def get_by_category(month: str = None):
    conn = get_db()
    query = """
        SELECT category, SUM(ABS(amount)) AS total
        FROM transactions
        WHERE category_type = 'Expense'
    """
    params = []
    if month:
        query += " AND substr(date, 1, 7) = ?"
        params.append(month)
    query += " GROUP BY category ORDER BY total DESC"

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [{"category": r["category"], "amount": round(r["total"], 2)} for r in rows]


# ── By subcategory ──────────────────────────────────

@app.get("/api/by-subcategory")
def get_by_subcategory(month: str = None, category: str = None):
    conn = get_db()
    query = """
        SELECT category, subcategory, SUM(ABS(amount)) AS total
        FROM transactions
        WHERE category_type = 'Expense'
    """
    params = []
    if month:
        query += " AND substr(date, 1, 7) = ?"
        params.append(month)
    if category:
        query += " AND category = ?"
        params.append(category)
    query += " GROUP BY category, subcategory ORDER BY total DESC"

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [{"category": r["category"], "subcategory": r["subcategory"], "amount": round(r["total"], 2)} for r in rows]


# ── Categories ──────────────────────────────────────

@app.get("/api/categories")
def get_categories():
    conn = get_db()
    rows = conn.execute(
        "SELECT DISTINCT category FROM transactions WHERE category_type = 'Expense' ORDER BY category"
    ).fetchall()
    conn.close()
    return [r["category"] for r in rows]


# ── By account ──────────────────────────────────────

@app.get("/api/by-account")
def get_by_account(month: str = None):
    conn = get_db()
    query = """
        SELECT account, SUM(ABS(amount)) AS total
        FROM transactions
        WHERE category_type = 'Expense'
    """
    params = []
    if month:
        query += " AND substr(date, 1, 7) = ?"
        params.append(month)
    query += " GROUP BY account"

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [{"account": r["account"], "amount": round(r["total"], 2)} for r in rows]


# ── Months ──────────────────────────────────────────

@app.get("/api/months")
def get_months():
    conn = get_db()
    rows = conn.execute(
        "SELECT DISTINCT substr(date, 1, 7) AS month FROM transactions ORDER BY month"
    ).fetchall()
    conn.close()
    return [r["month"] for r in rows]


# ── Subcategories (for modal) ───────────────────────

@app.get("/api/subcategories")
def get_subcategories():
    conn = get_db()
    rows = conn.execute(
        "SELECT subcategory, category, category_type FROM categories ORDER BY category, subcategory"
    ).fetchall()
    conn.close()
    return [
        {"subcategory": r["subcategory"], "category": r["category"], "category_type": r["category_type"]}
        for r in rows
    ]


# ── Add transaction ─────────────────────────────────

@app.post("/api/transactions")
def add_transaction(tx: NewTransaction):
    conn = get_db()

    cat_row = conn.execute(
        "SELECT category, category_type FROM categories WHERE subcategory = ?",
        (tx.subcategory,)
    ).fetchone()

    if not cat_row:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Subcategory '{tx.subcategory}' non trovata")

    category = cat_row["category"]
    category_type = cat_row["category_type"]

    debit = abs(tx.amount) if tx.amount < 0 else None
    credit = tx.amount if tx.amount > 0 else None

    conn.execute(
        """INSERT INTO transactions (date, account, notes, debit, credit, amount, subcategory, category, category_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (tx.date.isoformat(), tx.account, tx.notes or "", debit, credit, tx.amount, tx.subcategory, category, category_type)
    )
    conn.commit()
    last_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()

    return {"status": "ok", "id": last_id, "category": category, "category_type": category_type}


# ── Transfer between accounts ──────────────────────

class TransferRequest(BaseModel):
    date: date
    from_account: str
    to_account: str
    amount: float       # sempre positivo
    notes: str = ""

@app.post("/api/transfer")
def transfer(tr: TransferRequest):
    if tr.amount <= 0:
        raise HTTPException(status_code=400, detail="L'importo deve essere positivo")
    if tr.from_account == tr.to_account:
        raise HTTPException(status_code=400, detail="I due conti devono essere diversi")

    conn = get_db()

    # Verifica che le subcategory Transfer esistano
    sub_out = f"Transfer to {tr.to_account}"
    sub_in = f"Transfer from {tr.from_account}"

    for sub in [sub_out, sub_in]:
        row = conn.execute("SELECT subcategory FROM categories WHERE subcategory = ?", (sub,)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=400, detail=f"Subcategory '{sub}' non trovata nel DB")

    note = tr.notes or f"{tr.from_account} → {tr.to_account}"

    # Uscita dal conto di partenza
    conn.execute(
        """INSERT INTO transactions (date, account, notes, debit, credit, amount, subcategory, category, category_type)
           VALUES (?, ?, ?, ?, NULL, ?, ?, 'Transfer', 'Transfer')""",
        (tr.date.isoformat(), tr.from_account, note, tr.amount, -tr.amount, sub_out)
    )

    # Entrata nel conto di arrivo
    conn.execute(
        """INSERT INTO transactions (date, account, notes, debit, credit, amount, subcategory, category, category_type)
           VALUES (?, ?, ?, NULL, ?, ?, ?, 'Transfer', 'Transfer')""",
        (tr.date.isoformat(), tr.to_account, note, tr.amount, tr.amount, sub_in)
    )

    conn.commit()
    conn.close()

    return {"status": "ok", "note": note}


# ── Delete transaction ──────────────────────────────

@app.delete("/api/transactions/{tx_id}")
def delete_transaction(tx_id: int):
    conn = get_db()
    row = conn.execute("SELECT id FROM transactions WHERE id = ?", (tx_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Transazione non trovata")

    conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
    conn.commit()
    conn.close()
    return {"status": "ok", "deleted_id": tx_id}


# ── Edit transaction ───────────────────────────────

@app.put("/api/transactions/{tx_id}")
def edit_transaction(tx_id: int, tx: NewTransaction):
    conn = get_db()

    row = conn.execute("SELECT id FROM transactions WHERE id = ?", (tx_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Transazione non trovata")

    cat_row = conn.execute(
        "SELECT category, category_type FROM categories WHERE subcategory = ?",
        (tx.subcategory,)
    ).fetchone()

    if not cat_row:
        conn.close()
        raise HTTPException(status_code=400, detail=f"Subcategory '{tx.subcategory}' non trovata")

    category = cat_row["category"]
    category_type = cat_row["category_type"]

    debit = abs(tx.amount) if tx.amount < 0 else None
    credit = tx.amount if tx.amount > 0 else None

    conn.execute(
        """UPDATE transactions
           SET date=?, account=?, notes=?, debit=?, credit=?, amount=?, subcategory=?, category=?, category_type=?
           WHERE id=?""",
        (tx.date.isoformat(), tx.account, tx.notes or "", debit, credit, tx.amount, tx.subcategory, category, category_type, tx_id)
    )
    conn.commit()
    conn.close()

    return {"status": "ok", "id": tx_id, "category": category, "category_type": category_type}


# ── Account balances ────────────────────────────────

@app.get("/api/account-balances")
def get_account_balances():
    conn = get_db()

    # Prendi snapshot
    snapshots = conn.execute("SELECT account, balance, as_of_date FROM account_balances").fetchall()
    result = []

    for snap in snapshots:
        account = snap["account"]
        base_balance = snap["balance"]
        as_of_date = snap["as_of_date"]

        # Somma transazioni DOPO la data dello snapshot
        delta = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account = ? AND date > ?",
            (account, as_of_date)
        ).fetchone()[0]

        current = base_balance + delta
        result.append({
            "account": account,
            "balance": round(current, 2),
            "snapshot_date": as_of_date,
        })

    # Totale
    total = sum(r["balance"] for r in result)
    result.append({"account": "Totale", "balance": round(total, 2), "snapshot_date": None})

    conn.close()
    return result


# ── Cumulative balance ──────────────────────────────

@app.get("/api/cumulative-balance")
def get_cumulative_balance():
    conn = get_db()
    rows = conn.execute("""
        SELECT date, SUM(amount) OVER (ORDER BY date, id) AS cumulative
        FROM transactions
        ORDER BY date, id
    """).fetchall()
    conn.close()
    return [{"Date": r["date"], "cumulative": round(r["cumulative"], 2)} for r in rows]


# ── Export Excel ────────────────────────────────────

@app.get("/api/export")
def export_excel():
    import pandas as pd

    conn = sqlite3.connect(DB_PATH)
    df_tx = pd.read_sql("SELECT date, account, notes, debit, credit, amount, subcategory, category, category_type FROM transactions ORDER BY date", conn)
    df_cat = pd.read_sql("SELECT category, subcategory, category_type FROM categories ORDER BY category, subcategory", conn)
    conn.close()

    df_tx.columns = ['Date', 'Account', 'Notes', 'Debit (Spend)', 'Credit (Income)',
                     'Income/(Expense)', 'Subcategory', 'Category', 'Category Type']

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine='openpyxl') as writer:
        df_tx.to_excel(writer, sheet_name='Transactions', index=False)
        df_cat.to_excel(writer, sheet_name='Categories', index=False)
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=BudgetExport.xlsx"}
    )