"""
Test di POST /api/backup-upload e della modalità mirror (backend/app/main.py).

Usa una copia temporanea del DB; non tocca data/ né Google Drive.
Requisiti: fastapi + httpx.

    python tools/local-api-test/test_backup_upload.py [percorso/budget.db]
"""
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC_DB = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "budget.db"

tmp = Path(tempfile.mkdtemp(prefix="backup_upload_test_"))
db_path = tmp / "budget.db"
src = sqlite3.connect(f"file:{SRC_DB.as_posix()}?mode=ro", uri=True)
dst = sqlite3.connect(db_path)
src.backup(dst)
src.close()
dst.close()

os.environ["DB_PATH"] = str(db_path)
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "backend" / "app"))
from fastapi.testclient import TestClient  # noqa: E402
import main as backend  # noqa: E402

client = TestClient(backend.app)
TOKEN = "test-token-123"
fails = []


def check(cond, title, detail=""):
    print(("✓ " if cond else "✗ ") + title + ("" if cond else f"\n    {detail}"))
    if not cond:
        fails.append(title)


def upload(data, token=TOKEN, **params):
    return client.post("/api/backup-upload", content=data, params=params,
                       headers={"X-Backup-Token": token, "Content-Type": "application/octet-stream"})


def tx_count():
    c = sqlite3.connect(db_path)
    n = c.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    c.close()
    return n


# DB "del telefono": stessa base + una transazione in più
phone_db = tmp / "phone.db"
c = sqlite3.connect(phone_db)
sqlite3.connect(db_path).backup(c)
c.execute("""INSERT INTO transactions (date, account, notes, amount, subcategory, category, category_type)
             VALUES ('2026-11-14', 'Unicredit', 'dal telefono', -9.99, 'x', 'y', 'Expense')""")
c.commit()
c.close()
phone_bytes = phone_db.read_bytes()
before = tx_count()

# 1) senza BACKUP_TOKEN l'endpoint è spento
os.environ.pop("BACKUP_TOKEN", None)
os.environ["NODE_ROLE"] = "mirror"
r = upload(phone_bytes)
check(r.status_code == 503, "senza BACKUP_TOKEN → 503", r.text)

os.environ["BACKUP_TOKEN"] = TOKEN

# 2) token sbagliato / mancante
r = upload(phone_bytes, token="sbagliato")
check(r.status_code == 401, "token sbagliato → 401", r.text)
r = client.post("/api/backup-upload", content=phone_bytes)
check(r.status_code == 401, "token mancante → 401", r.text)

# 3) nodo primary: rifiuta per non sovrascrivere
os.environ["NODE_ROLE"] = "primary"
r = upload(phone_bytes)
check(r.status_code == 409 and tx_count() == before, "NODE_ROLE=primary → 409, DB intatto", r.text)
r = client.post("/api/transactions", json={"date": "2026-11-14", "account": "Unicredit", "amount": -1, "subcategory": "nope"})
check(r.status_code == 400, "primary: le scritture passano ancora (400 = subcategory inesistente)", r.text)

os.environ["NODE_ROLE"] = "mirror"

# 4) file non validi
r = upload(b"ciao, non sono un database")
check(r.status_code == 400 and tx_count() == before, "file non SQLite → 400, DB intatto", r.text)
r = upload(phone_bytes[: len(phone_bytes) // 2])
check(r.status_code == 400 and tx_count() == before, "DB troncato → 400, DB intatto", r.text)
empty = tmp / "empty.db"
sqlite3.connect(empty).execute("CREATE TABLE foo (x)").connection.commit()
r = upload(empty.read_bytes())
check(r.status_code == 400 and "Tabelle mancanti" in r.text and tx_count() == before, "DB senza tabelle del budget → 400", r.text)
check(not (tmp / "budget_upload_tmp.db").exists(), "nessun file temporaneo lasciato in giro")

# 5) upload valido
r = upload(phone_bytes)
body = r.json()
check(r.status_code == 200 and body.get("transactions") == before + 1, "upload valido → 200", r.text)
check(tx_count() == before + 1, "budget.db sostituito con quello del telefono", f"{before} → {tx_count()}")
archived = tmp / "backups" / "phone" / body.get("saved_as", "?")
check(archived.exists() and archived.read_bytes() == phone_bytes, "copia archiviata in backups/phone/")

# 6) mirror: web in sola lettura
r = client.get("/api/summary")
check(r.status_code == 200, "mirror: le letture funzionano", r.text)
for method, path in [("POST", "/api/transactions"), ("PUT", "/api/transactions/1"), ("DELETE", "/api/transactions/1"),
                     ("PATCH", "/api/transactions/1/toggle-status"), ("POST", "/api/transfer"),
                     ("POST", "/api/investments/holdings"), ("POST", "/api/investments/refresh-prices"),
                     ("POST", "/api/sync-from-drive")]:
    r = client.request(method, path, json={})
    check(r.status_code == 403 and "sola lettura" in r.json().get("detail", ""), f"mirror: {method} {path} → 403", r.text)
check(tx_count() == before + 1, "mirror: nessuna scrittura è passata")
r = client.get("/api/node-role")
check(r.json() == {"role": "mirror"}, "node-role = mirror", r.text)

# 7) CORS: l'app gira su https://localhost, header custom → preflight
r = client.options("/api/backup-upload", headers={
    "Origin": "https://localhost", "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "x-backup-token,content-type"})
check(r.status_code == 200 and r.headers.get("access-control-allow-origin") in ("*", "https://localhost"),
      "preflight CORS dal WebView ok", f"{r.status_code} {dict(r.headers)}")

# 8) rotazione: tiene solo gli ultimi KEEP_PHONE_BACKUPS
phone_dir = tmp / "backups" / "phone"
for i in range(backend.KEEP_PHONE_BACKUPS + 5):
    (phone_dir / f"budget_phone_20000101_0000{i:02d}.db").write_bytes(b"x")
r = upload(phone_bytes)
n = len(list(phone_dir.glob("budget_phone_*.db")))
check(r.status_code == 200 and n == backend.KEEP_PHONE_BACKUPS, f"rotazione: restano {backend.KEEP_PHONE_BACKUPS} copie", f"{n}")
check(any(p.name == r.json()["saved_as"] for p in phone_dir.iterdir()), "la copia appena fatta non viene cancellata")

print(f"\n{'✗ ' + str(len(fails)) + ' falliti' if fails else '✓ Tutti i controlli passati'}")
sys.exit(1 if fails else 0)
