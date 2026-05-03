FROM python:3.12-slim

WORKDIR /app

# Installa sqlite3, curl e rclone
RUN apt-get update && apt-get install -y \
    sqlite3 \
    curl \
    unzip \
    && curl https://rclone.org/install.sh | bash \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

COPY app/ ./app/
COPY migrate.py .
COPY upgrade_db.py .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
