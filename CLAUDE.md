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

## Local-first Android app (`mobile/`)

A Capacitor app (package `com.fraferr.budgetdashboard`, replaces the old TWA, whose repo `BudgetDashboardAndroid` is archived) that runs the same pages with the DB **on the phone**. The Pi is only a backup target.

- `frontend/js/local-api.js` — the endpoints of `main.py` + `investments.py` ported to JS: same SQL, same response shapes and error messages. It intercepts `fetch('/api/...')`, so the pages don't change. **If you change an endpoint in Python, change it here too**, then regenerate the reference and run the tests (see below).
- `frontend/js/local-db.js` — sql.js (SQLite/WASM). The whole DB lives in memory and is saved atomically to a file after every write (Capacitor Filesystem; IndexedDB in the browser). `ensureSchema()` is the app's equivalent of the `upgrade_db*.py` scripts: add new columns there too.
- `frontend/js/local-prices.js` — ETF prices for the app (replaces yfinance): Yahoo's `v8/finance/chart` API, called natively via `CapacitorHttp` (the WebView's CORS would block it), registered with `LocalApi.setPriceProvider`. It matches yfinance: current price = last unadjusted daily close (`regularMarketPrice` is wrong for some ETFs, e.g. CEU2.MI), history = `adjclose` (auto_adjust). Current prices are cached for 2 min. In the browser (`npm run serve`) there's no provider, so saved prices are used. Tests: `tools/local-api-test/prices.mjs` (`LIVE=1` also queries Yahoo through curl; Node's `fetch` gets a 429).
- `frontend/js/local-boot.js` — app-only: import screen, the "💾 Dati" button, Excel/DB export via the Share sheet, no service worker.
- **Backup phone → Pi**: the app POSTs the whole DB to `/api/backup-upload` (header `X-Backup-Token` = env `BACKUP_TOKEN`) 30 s after a change, when it goes to the background, and at startup if needed. `?drive=1` (the "Backup" button) also runs `_drive_backup()`. The endpoint works **only with `NODE_ROLE=mirror`**: it archives the file in `data/backups/phone/` (last 30 kept) and atomically replaces `data/budget.db`. In mirror mode, middleware rejects every web write with a 403 (read-only dashboard); `backup.sh` keeps sending `budget.db` to Drive. `NODE_ROLE` and `BACKUP_TOKEN` come from `.env` (git-ignored) via `docker-compose.yml`. Tests: `python tools/local-api-test/test_backup_upload.py`, and `PYTHON=<venv python> node ../tools/local-api-test/smoke.mjs` for the end-to-end run.
- `mobile/scripts/build-www.mjs` builds `mobile/www/` from `frontend/`: it swaps Chart.js from the CDN for `vendor/` and injects the `local-*.js` scripts. The Pi never loads these scripts.
- Tests: `python tools/local-api-test/make_reference.py data/<db>` (needs fastapi + httpx; runs the real backend on a copy of the DB), then `cd mobile && npm run test:api` (JS vs Python comparison + prices) and `node ../tools/local-api-test/smoke.mjs` (pages in headless Edge, screenshots). `tools/local-api-test/out/` contains personal data and is git-ignored.
- Build/install: `cd mobile && npm run sync`, then in `mobile/android` with `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk` and `JAVA_HOME` = JDK 21 (`C:\Program Files\Microsoft\jdk-21.*`; Android Studio's JDK 25 does not work with Gradle 8.14): `gradlew.bat assembleDebug`, then `adb install -r app/build/outputs/apk/debug/app-debug.apk`. Debug WebView: `adb forward tcp:9444 localabstract:webview_devtools_remote_<pid>` (debug builds only).
- Release (the build installed on the phone): `gradlew.bat assembleRelease`, then `adb install -r app/build/outputs/apk/release/app-release.apk`. It is signed with **the same debug key** (`~/.android/debug.keystore`, override with env `BUDGET_KEYSTORE`) as the old TWA and the debug builds, so it installs as an update and the phone keeps its DB. If that keystore is lost, the app can't be updated anymore: it would have to be uninstalled, which deletes the DB, so export it first. The release WebView is not inspectable, so install a debug build when you need CDP. Bump `versionCode` in `mobile/android/app/build.gradle` for each release.

## Key domain rules

- **Categories live in the DB, not in code.** The `categories` table (`category`, `subcategory` UNIQUE, `category_type` ∈ Income/Expense/Transfer) feeds the transaction modal via `/api/subcategories`. To add or rename a subcategory, add it to `NEW_CATEGORIES` in `backend/upgrade_db_categories.py` and run it (see Commands). No frontend change is needed.
- `transactions.category` / `category_type` are denormalized copies, resolved from `categories` on insert/update. Renaming a subcategory means updating the matching transactions too.
- `amount` is signed (negative = expense); `debit`/`credit` hold absolute values.
- `status` is `confirmed` or `planned`. Planned rows are excluded from all KPIs, charts and balances (`COALESCE(status,'confirmed') = 'confirmed'`). Keep that filter in new aggregate queries.
- Transfers are two paired rows with `category_type = 'Transfer'`, using subcategories `Transfer to X` / `Transfer from Y`. They're excluded from income/expense stats. Adding a new account requires adding those subcategories plus an `account_balances` row.
- Account balance = `account_balances` snapshot + sum of confirmed transactions after `as_of_date`.
- **Investment history** (`GET /api/investments/history`, "Storico versamenti mensili" table/chart) counts only confirmed expense rows with `subcategory = 'ETF investment'` (category "Savings or investments"). Other investment subcategories (`Investment account`, `Retirement account`, …) are intentionally excluded. Changed 2026-11-14; previously it matched `%invest%` on category or subcategory.
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

## Mobile layout (≤ 720px)

The Android app and phone browsers use the `@media (max-width: 720px)` rules in each page: sidebar becomes an off-canvas drawer, `.bottom-nav` appears. Rules learned the hard way:

- Single-column grids must use `grid-template-columns: minmax(0, 1fr)` plus `> * { min-width: 0 }`. Plain `1fr` won't shrink below the canvas/content width and cards overflow off-screen (fixed in `.two-col` on categories, `.chart-grid` on index).
- `transactions.html`: on mobile the table is rendered as stacked cards via CSS grid on `tr` (description + amount / date · account · subcategory + actions; Category and Type columns hidden). Column positions are referenced with `td:nth-child(n)`, so keep the `<td>` order in `render()` in sync. `.filters-bar` uses `top: 0` on mobile (its desktop `top: 60px` pushed it over the first row).
- To debug on the phone: USB debugging + `adb forward tcp:9222 localabstract:chrome_devtools_remote`, then inspect via `chrome://inspect` or the DevTools protocol.
- nginx sends no `Cache-Control`, so Chrome may serve stale HTML after an edit. Clear Chrome's cache on the phone (or reload ignoring cache) when a change doesn't show up.
- If the page renders at ~980px wide with the desktop sidebar on a phone, Chrome's "Desktop site" setting is on (user agent becomes `X11; Linux`). It's a Chrome setting, not a bug in the page.

## Cautions

- Back up before touching the DB: `cp data/budget.db data/backups/budget_pre_<change>_$(date +%Y%m%d_%H%M%S).db`.
- This node is `NODE_ROLE=primary`. `POST /api/sync-from-drive` **overwrites** the local DB with Drive's `budget_latest.db`. Don't call it on the primary after local DB changes that haven't been backed up to Drive.
- Python `open().read()/write()` converts CRLF to LF. Some files (e.g. `investments.py`, `investments.html`) were committed with CRLF, so scripted edits produce whole-file diffs. Use `git diff --ignore-cr-at-eol` to review.
- `backup.sh` (git-ignored, cron) and `rclone_config/` (git-ignored, mounted ro) handle Google Drive backups. Never commit secrets or `data/`.
