# 💶 Budget Dashboard

A personal finance dashboard to track income, expenses, and account balances — built as a full-stack containerized web app.

Originally migrated from an Excel-based tracker, the app now runs on a SQLite database with a FastAPI backend, a Chart.js frontend served by nginx, and is fully orchestrated with Docker Compose.

Accessible remotely via Tailscale and installable as a PWA on Android.

---

## Features

- **KPI cards** — monthly income, expenses, net balance, transaction count (with hide/show toggle)
- **Account balances** — real-time balances for Unicredit, Revolut, and Contanti
- **Monthly bar chart** — income vs. expenses trend with net balance line
- **Category donut chart** — breakdown of spending by category
- **Account bar chart** — spending distribution per account
- **Subcategory table** — filterable breakdown with distribution bars
- **Cumulative balance chart** — net worth over time
- **Transaction table** — last 100 transactions with inline edit and delete
- **Add / edit transaction modal** — with subcategory selector and category preview
- **Transfer modal** — move funds between accounts (auto-creates paired transactions)
- **Excel export** — download full transaction history
- **PWA support** — installable on Android via Chrome, fullscreen, HTTPS via Tailscale

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

---

## Project Structure

```
BudgetDashboard/
├── backend/
│   ├── app/
│   │   └── main.py            # FastAPI — all API endpoints
│   ├── migrate.py             # One-shot migration: Excel → SQLite
│   ├── upgrade_db.py          # Schema upgrades without data loss
│   └── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── index.html             # Full dashboard (HTML + CSS + JS inline)
│   ├── nginx.conf             # Reverse proxy config
│   ├── manifest.json          # PWA manifest
│   └── sw.js                  # Service worker
├── data/                      # Not tracked in git (contains personal data)
│   └── budget.db              # SQLite database
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

### `categories`

Lookup table with ~77 rows mapping subcategories to categories and types.

### `account_balances`

Point-in-time balance snapshot per account. Current balance = snapshot + sum of transactions after snapshot date.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/transactions` | List transactions (filterable by month, category, account) |
| POST | `/api/transactions` | Add a new transaction |
| PUT | `/api/transactions/{id}` | Edit a transaction |
| DELETE | `/api/transactions/{id}` | Delete a transaction |
| POST | `/api/transfer` | Create a transfer between accounts |
| GET | `/api/summary` | Monthly KPIs (income, expenses, balance) |
| GET | `/api/by-month` | Monthly income vs. expenses trend |
| GET | `/api/by-category` | Expenses aggregated by category |
| GET | `/api/by-subcategory` | Expenses by subcategory |
| GET | `/api/by-account` | Expenses by account |
| GET | `/api/account-balances` | Current balance per account |
| GET | `/api/cumulative-balance` | Cumulative balance over time |
| GET | `/api/export` | Download Excel export |

---

## Backup

The `backup.sh` script performs a safe SQLite backup and uploads it to Google Drive via `rclone`. Intended to run as a cron job (e.g. every 3 days at 3 AM).

Requires `rclone` configured with a Google Drive remote named `gdrive`.

---

## Deployment on Raspberry Pi

```bash
scp -r BudgetDashboard/ pi@<PI_IP>:~/BudgetDashboard/
ssh pi@<PI_IP>
cd ~/BudgetDashboard
docker compose up --build -d
tailscale serve --bg http://localhost:3000
```

---

## Notes

- Transfers between accounts (e.g. Unicredit → Revolut) are recorded as two paired transactions with `category_type = Transfer` and are excluded from income/expense statistics.
- The `data/` directory is intentionally excluded from version control. You need to bring your own `budget.db` or run `migrate.py` to get started.

---

## License

MIT