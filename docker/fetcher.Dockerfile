FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        cron \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir yfinance

WORKDIR /opt/portfolio

COPY utils/ utils/
RUN chmod +x utils/tickers/fetch_prices.py

COPY docker/crontab /etc/cron.d/fetcher
# 0600: cron requires root-owned files with restricted permissions
RUN chmod 0600 /etc/cron.d/fetcher && crontab /etc/cron.d/fetcher

COPY docker/fetcher-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
