#!/bin/sh
set -e

echo "Starting fetcher cron daemon..."

# Export container env vars so cron jobs can read them via /etc/environment
printenv | grep -E '^(TICKERS|TZ)=' > /etc/environment || true

# Run an initial fetch on startup
echo "Running initial price fetch..."
python3 /opt/portfolio/utils/tickers/fetch_prices.py -d /opt/portfolio/data || true

exec cron -f
