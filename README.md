# 💶 Budget Dashboard

A personal finance dashboard to track income, expenses, account balances, and investments — built as a full-stack containerized web app.

Originally migrated from an Excel-based tracker, the app now runs on a SQLite database with a FastAPI backend, a Chart.js frontend served by nginx, and is fully orchestrated with Docker Compose.

Accessible remotely via Tailscale and installable as a PWA on Android.

---

## Features

### Budget Dashboard (`index.html`)

- **KPI cards** — monthly income, expenses, net balance, transaction count (with per-card hide/show toggle)
- **Account balances** — real-time balances for Unicredit, Revolut, and Contanti
- **Monthly bar chart** — income vs. expenses trend with net balance line
- **Category donut chart** — breakdown of spending by category
- **Account bar chart** — spending distribution per account
- **Subcategory table** — filterable breakdown with distribution bars
- **Cumulative balance chart** — net worth over time
- **Transaction table** — last 100 transactions with inline edit, delete, and status toggle
- **Planned transactions** — mark transactions as *planned* (shown dimmed, excluded from KPIs and charts)
- **Add / edit transaction modal** — with subcategory selector, category preview, and planned flag
- **Transfer modal** — move funds between accounts (auto-creates paired transactions)
- **Multi-month filter** — compare data across multiple months at once
- **Excel export** — download full transaction history
- **Sync from Drive** — pull the latest DB backup from Google Drive (replica nodes)
- **Backup to Drive** — manually trigger a DB backup to Google Drive (primary node only)
- **PWA support** — installable on Android via Chrome, fullscreen, HTTPS via Tailscale

### Investments (`investments.html`)

- **Portfolio KPI cards** — total invested, current market value, P&L (€ and %)
- **Holdings table** — per-position breakdown with live prices, quantity, cost basis, and P&L
- **Allocation chart** — portfolio split by asset type and ticker
- **Price history chart** — configurable period (1m / 3m / 6m / 1y / 5y) per ticker via yfinance
- **Investment history** — cumulative deposit history sourced from transactions
- **Add / edit / delete holding** — full CRUD for portfolio positions
- **Refresh prices** — on-demand price update from Yahoo Finance

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI (Python 3.12) |
| Database | SQLite |
| Frontend | HTML + CSS + JavaScript + Chart.js |
| Web server | nginx (reverse proxy + static files) |
| Containerization | Docker + Docker Compose |
| Remote access | Tailscale |
| Market data | yfinance (Yahoo Finance) |

---

## Project Structure

```
BudgetDashboard/
├── backend/
│   ├── app/
│   │   └── main.py            # FastAPI — budget + sync/backup endpoints
│   ├── investments.py         # FastAPI router — investments endpoints
│   ├── migrate.py             # One-shot migration: Excel → SQLite
│   ├── upgrade_db.py          # Schema upgrades without data loss
│   ├── upgrade_db_status.py   # Adds `status` column to transactions
│   └── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── index.html             # Budget dashboard (HTML + CSS + JS inline)
│   ├── investments.html       # Investments dashboard
│   ├── nginx.conf             # Reverse proxy config
│   ├── manifest.json          # PWA manifest
│   └── sw.js                  # Service worker
├── data/                      # Not tracked in git (contains personal data)
│   └── budget.db              # SQLite database
├── rclone_config/             # rclone config (mounted read-only into container)
├── backup.sh                  # DB backup script (rclone → Google Drive)
├── docker-compose.yml
└── README.md
```

---

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- (Optional) [Tailscale](https://tailscale.com/) for remote HTTPS access

### Run locally

```bash
git clone https://github.com/<your-username>/BudgetDashboard.git
cd BudgetDashboard

# Create the data directory (not tracked in git)
mkdir -p data

# Start the stack
docker compose up --build -d
```

The dashboard will be available at [http://localhost:3000](http://localhost:3000).

### Migrate from Excel (optional)

If you have an existing Excel file with your transactions:

```bash
docker compose run --rm backend python migrate.py /data/YourFile.xlsx /data/budget.db
```

### Remote access via Tailscale

```bash
tailscale serve --bg http://localhost:3000
```

This exposes the dashboard over HTTPS on your Tailscale network.

---

## Database Schema

### `transactions`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key |
| `date` | TEXT | Format: `YYYY-MM-DD` |
| `account` | TEXT | e.g. `Unicredit`, `Revolut`, `Contanti` |
| `notes` | TEXT | Optional description |
| `debit` | REAL | Absolute value if expense, else NULL |
| `credit` | REAL | Absolute value if income, else NULL |
| `amount` | REAL | Signed: negative = expense, positive = income |
| `subcategory` | TEXT | Links to `categories` table |
| `category` | TEXT | Parent category |
| `category_type` | TEXT | `Income`, `Expense`, or `Transfer` |
| `status` | TEXT | `confirmed` (default) or `planned` |

### `categories`

Lookup table with ~77 rows mapping subcategories to categories and types.

### `account_balances`

Point-in-time balance snapshot per account. Current balance = snapshot + sum of confirmed transactions after snapshot date.

### `holdings`

Investment positions: ticker, name, asset type, quantity, average cost per unit.

### `price_history`

Cached market prices per ticker and date, populated by yfinance on demand.

---

## API Endpoints

### Budget

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/transactions` | List transactions (filterable by month, category, account, category_type) |
| POST | `/api/transactions` | Add a new transaction |
| PUT | `/api/transactions/{id}` | Edit a transaction |
| DELETE | `/api/transactions/{id}` | Delete a transaction |
| PATCH | `/api/transactions/{id}/toggle-status` | Toggle between `confirmed` and `planned` |
| POST | `/api/transfer` | Create a transfer between accounts |
| GET | `/api/summary` | Monthly KPIs (income, expenses, balance) — confirmed only |
| GET | `/api/by-month` | Monthly income vs. expenses trend |
| GET | `/api/by-category` | Expenses aggregated by category |
| GET | `/api/by-subcategory` | Expenses by subcategory |
| GET | `/api/by-account` | Expenses by account |
| GET | `/api/account-balances` | Current balance per account |
| GET | `/api/cumulative-balance` | Cumulative balance over time |
| GET | `/api/categories` | Full categories lookup table |
| GET | `/api/subcategories` | Subcategory list |
| GET | `/api/months` | List of months with at least one transaction |
| GET | `/api/export` | Download Excel export |
| GET | `/api/node-role` | Returns `NODE_ROLE` env var (`primary` / `secondary`) |
| POST | `/api/backup-to-drive` | Backup DB to Google Drive (primary node only) |
| POST | `/api/sync-from-drive` | Pull latest DB backup from Google Drive |

### Investments

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/investments/holdings` | List all holdings with current prices and P&L |
| POST | `/api/investments/holdings` | Add a new holding |
| PUT | `/api/investments/holdings/{id}` | Edit a holding |
| DELETE | `/api/investments/holdings/{id}` | Delete a holding |
| GET | `/api/investments/summary` | KPIs: invested, market value, P&L |
| GET | `/api/investments/history` | Cumulative investment deposit history |
| GET | `/api/investments/allocation` | Allocation breakdown by type and ticker |
| GET | `/api/investments/price-history` | Price history for a ticker (`?ticker=&period=`) |
| POST | `/api/investments/refresh-prices` | Refresh all prices from Yahoo Finance |

---

## Backup & Sync

The `backup.sh` script performs a safe SQLite backup and uploads it to Google Drive via `rclone`. Intended to run as a cron job (e.g. every 3 days at 3 AM).

The backend also exposes two manual endpoints:
- **`POST /api/backup-to-drive`** — triggers an immediate backup (only on nodes where `NODE_ROLE=primary`).
- **`POST /api/sync-from-drive`** — downloads the latest backup from Drive and replaces the local DB, useful for keeping a secondary node in sync.

Both require `rclone` configured with a Google Drive remote. The `rclone_config/` directory is mounted read-only into the backend container.

---

## Deployment on Raspberry Pi

```bash
scp -r BudgetDashboard/ pi@<PI_IP>:~/BudgetDashboard/
ssh pi@<PI_IP>
cd ~/BudgetDashboard
docker compose up --build -d
tailscale serve --bg http://localhost:3000
```

Set `NODE_ROLE=primary` in `docker-compose.yml` on the main node. Secondary nodes should set `NODE_ROLE=secondary` and use the **Sync da Drive** button to pull updates.

---

## Notes

- Planned transactions are displayed dimmed and in italic in the transaction table, and are excluded from all KPIs, charts, and balance calculations.
- Transfers between accounts (e.g. Unicredit → Revolut) are recorded as two paired transactions with `category_type = Transfer` and are excluded from income/expense statistics.
- The `data/` directory is intentionally excluded from version control. You need to bring your own `budget.db` or run `migrate.py` to get started.
- Market prices in the investments module are fetched via `yfinance`. If the library is not installed, the investments endpoints still work but return `null` for live prices.

---

## License

MIT
