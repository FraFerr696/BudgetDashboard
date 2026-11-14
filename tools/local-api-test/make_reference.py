"""
Genera il riferimento per il test di frontend/js/local-api.js.

Esegue una sequenza di richieste (letture, poi scritture, poi di nuovo letture)
contro il backend FastAPI VERO, su una COPIA temporanea del DB, e salva:
  out/reference.js  ->  window.REFERENCE = { db_b64, cases: [...] }

db_b64 è il DB di partenza (dopo la stessa normalizzazione di schema che fa
LocalDB), così test.html riparte esattamente dallo stesso stato.

Requisiti: fastapi + httpx (pandas/yfinance NON servono: senza yfinance
il backend usa i prezzi salvati, come fa LocalApi senza price provider).

Uso:
  python tools/local-api-test/make_reference.py [percorso/budget.db]

out/ contiene dati personali ed è git-ignored.
"""
import base64
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SRC_DB = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "budget.db"
OUT = HERE / "out"


def normalize_schema(path):
    """Stesse aggiunte idempotenti di LocalDB.ensureSchema (solo colonne mancanti)."""
    c = sqlite3.connect(path)
    cols = lambda t: [r[1] for r in c.execute(f"PRAGMA table_info({t})")]
    if "status" not in cols("transactions"):
        c.execute("ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'")
        c.execute("CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)")
    if "isin" not in cols("holdings"):
        c.execute("ALTER TABLE holdings ADD COLUMN isin TEXT DEFAULT ''")
    c.commit()
    c.close()


def main():
    tmpdir = Path(tempfile.mkdtemp(prefix="localapi_ref_"))
    db_path = tmpdir / "budget.db"
    # copia via backup API: non tocca l'originale, che si apre in sola lettura
    src = sqlite3.connect(f"file:{SRC_DB.as_posix()}?mode=ro", uri=True)
    dst = sqlite3.connect(db_path)
    src.backup(dst)
    src.close()
    dst.close()
    normalize_schema(db_path)
    start_bytes = db_path.read_bytes()

    os.environ["DB_PATH"] = str(db_path)
    sys.path.insert(0, str(ROOT / "backend"))
    sys.path.insert(0, str(ROOT / "backend" / "app"))
    from fastapi.testclient import TestClient
    import main as backend  # noqa: E402

    client = TestClient(backend.app)
    cases = []

    def call(method, path, body=None, compare="full"):
        r = client.request(method, path, json=body)
        try:
            data = r.json()
        except Exception:
            data = None
        cases.append({"method": method, "path": path, "body": body,
                      "status": r.status_code, "response": data, "compare": compare})
        return data

    # ── dati per costruire i casi ──
    months = call("GET", "/api/months")
    cats = call("GET", "/api/categories")
    subs = call("GET", "/api/subcategories")
    balances = call("GET", "/api/account-balances")
    accounts = [b["account"] for b in balances if b["account"] != "Totale"]
    month = months[-1]
    month2 = months[len(months) // 2]
    cat = cats[0]
    expense_sub = next(s["subcategory"] for s in subs if s["category_type"] == "Expense")
    income_sub = next(s["subcategory"] for s in subs if s["category_type"] == "Income")
    sub_names = {s["subcategory"] for s in subs}
    pair = next(((a, b) for a in accounts for b in accounts
                 if a != b and f"Transfer to {b}" in sub_names and f"Transfer from {a}" in sub_names), None)

    # ── letture ──
    def reads(tag=""):
        call("GET", "/health")
        call("GET", "/api/transactions")
        call("GET", f"/api/transactions?month={month}")
        call("GET", f"/api/transactions?month={month}&category={cat}")
        call("GET", f"/api/transactions?account={accounts[0]}&category_type=Expense")
        call("GET", "/api/transactions?month=")
        call("GET", "/api/summary")
        call("GET", f"/api/summary?month={month}")
        call("GET", f"/api/summary?month={month2}")
        call("GET", "/api/summary?month=1999-01")
        call("GET", "/api/by-month")
        call("GET", "/api/by-category")
        call("GET", f"/api/by-category?month={month}")
        call("GET", "/api/by-subcategory")
        call("GET", f"/api/by-subcategory?month={month}")
        call("GET", f"/api/by-subcategory?month={month2}&category={cat}")
        call("GET", "/api/categories")
        call("GET", "/api/by-account")
        call("GET", f"/api/by-account?month={month}")
        call("GET", "/api/months")
        call("GET", "/api/subcategories")
        call("GET", "/api/account-balances")
        call("GET", "/api/cumulative-balance")
        call("GET", "/api/investments/holdings")
        call("GET", "/api/investments/summary")
        call("GET", "/api/investments/history")
        call("GET", "/api/investments/allocation")

    reads()
    call("GET", "/api/investments/price-history?ticker=VWCE.DE")
    call("GET", "/api/nope")

    # ── scritture: transazioni ──
    r1 = call("POST", "/api/transactions", {"date": "2026-11-10", "account": accounts[0], "amount": -12.34,
                                            "subcategory": expense_sub, "notes": "test spesa"})
    r2 = call("POST", "/api/transactions", {"date": "2026-11-11", "account": accounts[-1], "amount": 1500,
                                            "subcategory": income_sub, "status": "planned"})
    call("POST", "/api/transactions", {"date": "2026-11-12", "account": accounts[0], "amount": -1,
                                       "subcategory": "Non esiste"})
    call("POST", "/api/transactions", {"account": accounts[0], "amount": -1}, compare="status")
    call("POST", "/api/transactions", {"date": "2026-13-45", "account": accounts[0], "amount": -1,
                                       "subcategory": expense_sub}, compare="status")
    call("PUT", f"/api/transactions/{r1['id']}", {"date": "2026-11-09", "account": accounts[0], "amount": -20.5,
                                                  "subcategory": expense_sub, "notes": ""})
    call("PUT", "/api/transactions/99999999", {"date": "2026-11-09", "account": accounts[0], "amount": -1,
                                               "subcategory": expense_sub})
    call("PATCH", f"/api/transactions/{r2['id']}/toggle-status")
    call("PATCH", f"/api/transactions/{r1['id']}/toggle-status")
    call("PATCH", f"/api/transactions/{r1['id']}/toggle-status")
    call("PATCH", "/api/transactions/99999999/toggle-status")
    call("GET", "/api/transactions?month=2026-11")
    call("DELETE", f"/api/transactions/{r1['id']}")
    call("DELETE", f"/api/transactions/{r1['id']}")

    # ── trasferimenti ──
    if pair:
        call("POST", "/api/transfer", {"date": "2026-11-13", "from_account": pair[0], "to_account": pair[1], "amount": 250})
        call("POST", "/api/transfer", {"date": "2026-11-13", "from_account": pair[0], "to_account": pair[1],
                                       "amount": 10, "notes": "con nota"})
    call("POST", "/api/transfer", {"date": "2026-11-13", "from_account": accounts[0], "to_account": accounts[0], "amount": 5})
    call("POST", "/api/transfer", {"date": "2026-11-13", "from_account": accounts[0], "to_account": "Banca X", "amount": 5})
    call("POST", "/api/transfer", {"date": "2026-11-13", "from_account": accounts[0], "to_account": accounts[-1], "amount": 0})

    # ── investimenti ──
    h = call("POST", "/api/investments/holdings", {"ticker": "TEST.MI", "name": "Test ETF", "shares": 3.5,
                                                   "avg_price": 101.25, "opened_at": "2026-11-01"})
    call("PUT", f"/api/investments/holdings/{h['id']}", {"shares": 4, "notes": "aggiornata", "isin": "IE00TEST"})
    call("PUT", "/api/investments/holdings/99999999", {"shares": 1})
    call("POST", "/api/investments/holdings", {"ticker": "X"}, compare="status")
    call("POST", "/api/investments/refresh-prices", compare="nodate")  # 'date' = oggi

    reads("after")
    call("DELETE", f"/api/investments/holdings/{h['id']}")
    call("DELETE", f"/api/investments/holdings/{h['id']}")
    call("GET", "/api/investments/holdings")

    # campioni per confrontare pyRound (JS) con round() di Python
    import random
    rnd = random.Random(42)
    xs = [0.125, 0.375, -0.125, 2.675, 1.005, 0.5, 1.5, 2.5, -2.5, 0.25, 0.35, 1234.565, -0.001, 0.0,
          12.345, 99.995, 7.0625]
    xs += [round(rnd.uniform(-5000, 5000), rnd.randint(2, 4)) * rnd.choice([1, 3, 7]) / rnd.choice([1, 3, 10])
           for _ in range(400)]
    round_samples = [[x, n, round(x, n)] for x in xs for n in (1, 2, 4)]

    OUT.mkdir(exist_ok=True)
    ref = {"source": str(SRC_DB), "db_b64": base64.b64encode(start_bytes).decode(), "cases": cases,
           "round_samples": round_samples}
    (OUT / "reference.js").write_text("window.REFERENCE = " + json.dumps(ref, ensure_ascii=False) + ";\n",
                                      encoding="utf-8")
    shutil.rmtree(tmpdir, ignore_errors=True)
    print(f"{len(cases)} casi -> {OUT / 'reference.js'}")


if __name__ == "__main__":
    main()
