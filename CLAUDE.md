# CLAUDE.md

Personal budget dashboard: FastAPI + SQLite backend, static HTML/JS (Chart.js) frontend served by nginx, orchestrated with Docker Compose. Runs on a Raspberry Pi (primary node), reachable via Tailscale, installable as a PWA. UI text is in Italian; category/subcategory names are in English.

## Layout

- `backend/app/main.py` — all budget endpoints (`/api/transactions`, `/api/summary`, `/api/by-*`, `/api/subcategories`, `/api/transfer`, export, Drive sync/backup).
- `backend/investments.py` — `APIRouter` mounted at `/api/investments` (holdings, prices via yfinance, allocation, history).
- `backend/migrate.py` — one-shot Excel → SQLite (destructive: drops tables). Don't run on an existing DB.
- `backend/upgrade_db*.py` — idempotent, manual schema/data upgrades. Follow this pattern for DB changes.
- `frontend/*.html` — self-contained pages (CSS + JS inline): `index.html` (overview), `transactions.html`, `categories.html`, `investments.html`. Each defines `const API = ''` and calls `/api/...`, which nginx proxies to `backend:8000`.
- `frontend/sw.js` — service worker: HTML network-first, other static assets cache-first. Bump `CACHE_NAME` if you change cached static assets (icons, manifest).
- `data/budget.db` — the live SQLite DB (git-ignored, personal data). `data/backups/` holds backups.

## Key domain rules

- **Categories live in the DB, not in code.** The `categories` table (`category`, `subcategory` UNIQUE, `category_type` ∈ Income/Expense/Transfer) feeds the transaction modal via `/api/subcategories`. To add or rename a subcategory, add it to `NEW_CATEGORIES` in `backend/upgrade_db_categories.py` and run it (see Commands). No frontend change is needed.
- `transactions.category` / `category_type` are denormalized copies, resolved from `categories` on insert/update. Renaming a subcategory means updating the matching transactions too.
- `amount` is signed (negative = expense); `debit`/`credit` hold absolute values.
- `status` is `confirmed` or `planned`. Planned rows are excluded from all KPIs, charts and balances (`COALESCE(status,'confirmed') = 'confirmed'`). Keep that filter in new aggregate queries.
- Transfers are two paired rows with `category_type = 'Transfer'`, using subcategories `Transfer to X` / `Transfer from Y`. They're excluded from income/expense stats. Adding a new account requires adding those subcategories plus an `account_balances` row.
- Account balance = `account_balances` snapshot + sum of confirmed transactions after `as_of_date`.
- The known typo `Vairable` (Income → Extras) exists in the DB. Leave it unless asked to fix it.

## Commands

```bash
docker compose up --build -d                       # rebuild + restart (backend code is baked into the image)
docker compose exec -T backend python upgrade_db_categories.py /data/budget.db
docker compose logs -f backend
sqlite3 data/budget.db "SELECT * FROM categories ORDER BY category, subcategory;"
curl -s localhost:3000/api/subcategories           # check via nginx
```

- Frontend is bind-mounted read-only into nginx, so HTML edits go live immediately (reload the page). Backend `.py` changes need `--build`.
- Ports: frontend 3000, backend 8000.
- No test suite. Verify with `curl` against the API and by opening the dashboard.

## Cautions

- Back up before touching the DB: `cp data/budget.db data/backups/budget_pre_<change>_$(date +%Y%m%d_%H%M%S).db`.
- This node is `NODE_ROLE=primary`. `POST /api/sync-from-drive` **overwrites** the local DB with Drive's `budget_latest.db`. Don't call it on the primary after local DB changes that haven't been backed up to Drive.
- `backup.sh` (git-ignored, cron) and `rclone_config/` (git-ignored, mounted ro) handle Google Drive backups. Never commit secrets or `data/`.
