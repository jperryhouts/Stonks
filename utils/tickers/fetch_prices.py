#!/usr/bin/env python3
"""Fetch the most recent closing prices for a set of tickers.

When the market is closed, records the regular-session close with a 16:00 ET
timestamp.  When the market is open, records the current price with the
actual time.

Tickers can be supplied as positional CLI arguments, via the TICKERS
environment variable (comma-separated), or inferred from the columns of an
existing market.csv.  Falls back to a built-in default list when none of
these are available.

If --data-dir / -d is given, prices are upserted into market.csv inside that
directory (one row per date, columns added as new tickers appear).  Symbols
are also resolved from trades.json and retirement.json in the same directory
when those files exist.  If --data-dir is omitted, prices are printed to
stdout.

Use --start / --end (YYYY-MM-DD) to backfill a historical date range.  Each
trading day in that range is written as a separate row.  Both flags must be
supplied together.

Examples:
    # Use defaults, print to console
    python fetch_prices.py

    # Specify tickers, write to a data directory
    python fetch_prices.py VTI VXUS BND -d data/

    # Tickers from env, write to a data directory
    TICKERS=VTI,VXUS,BND python fetch_prices.py -d data/

    # Infer tickers from existing CSV and data files
    python fetch_prices.py -d data/

    # Backfill a historical range
    python fetch_prices.py VTI VXUS BND --start 2024-01-01 --end 2024-12-31 -d data/
"""

import argparse
import csv
import json
import logging
import math
import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import yfinance as yf

_ET = ZoneInfo("America/New_York")

DEFAULT_TICKERS = ["VTI", "VXUS", "BND"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s]: %(message)s",
)
log = logging.getLogger(__name__)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch latest prices for a set of tickers.",
    )
    parser.add_argument(
        "tickers",
        nargs="*",
        help=(
            "Ticker symbols to fetch. Can also be set via the TICKERS "
            "environment variable (comma-separated). "
            f"Defaults to {', '.join(DEFAULT_TICKERS)}."
        ),
    )
    parser.add_argument(
        "-d", "--data-dir",
        metavar="DIR",
        help=(
            "Path to the data directory. Prices are written to market.csv "
            "inside this directory, and trades.json and retirement.json are "
            "read from it for symbol resolution and backfill. "
            "If omitted, prices are printed to stdout."
        ),
    )
    parser.add_argument(
        "--start",
        metavar="YYYY-MM-DD",
        help="Start date for historical backfill (inclusive). Requires --end.",
    )
    parser.add_argument(
        "--end",
        metavar="YYYY-MM-DD",
        help="End date for historical backfill (inclusive). Requires --start.",
    )
    args = parser.parse_args(argv)
    if bool(args.start) != bool(args.end):
        parser.error("--start and --end must be used together")
    return args


def resolve_tickers(
    cli_tickers: list[str], csv_path: str | None = None,
) -> list[str]:
    """Resolve tickers from CLI args → TICKERS env var → CSV columns → defaults."""
    if cli_tickers:
        return [t.upper() for t in cli_tickers]

    env = os.environ.get("TICKERS", "").strip()
    if env:
        tickers = [t.strip().upper() for t in env.split(",") if t.strip()]
        if tickers:
            return tickers

    if csv_path:
        csv_tickers, _ = _read_csv(csv_path)
        if csv_tickers:
            log.info("Using tickers from %s: %s", csv_path, ", ".join(csv_tickers))
            return csv_tickers

    return list(DEFAULT_TICKERS)


def resolve_symbols_from_data_files(
    trades_path: str | None,
    retirement_path: str | None,
) -> set[str]:
    """Return ticker symbols referenced in trades and retirement data.

    Reads ``symbol`` fields from *trades_path* and ``proxy`` fields from
    the ``accounts`` array in *retirement_path*.  Missing or malformed
    files are silently skipped.
    """
    symbols: set[str] = set()

    if trades_path:
        try:
            with open(trades_path) as f:
                trades = json.load(f)
            if isinstance(trades, list):
                for trade in trades:
                    if isinstance(trade, dict) and "symbol" in trade:
                        s = str(trade["symbol"]).strip().upper()
                        if s:
                            symbols.add(s)
        except (OSError, json.JSONDecodeError):
            log.warning("Could not read %s for symbol resolution", trades_path)

    if retirement_path:
        try:
            with open(retirement_path) as f:
                retirement = json.load(f)
            if isinstance(retirement, dict):
                for account in retirement.get("accounts", []):
                    proxy = str(account.get("proxy", "VTI")).strip().upper()
                    if proxy:
                        symbols.add(proxy)
        except (OSError, json.JSONDecodeError):
            log.warning("Could not read %s for symbol resolution", retirement_path)

    return symbols


def _get_market_state(sample_ticker: str) -> str:
    """Return the current market state string.

    Common values: PRE, PREPRE, REGULAR, POST, POSTPOST, CLOSED.
    Falls back to "CLOSED" on error.
    """
    try:
        state = yf.Ticker(sample_ticker).info.get("marketState", "CLOSED")
        log.info("Market state: %s", state)
        return state
    except Exception:
        log.warning("Could not determine market state — assuming closed")
        return "CLOSED"


def fetch_prices(
    tickers: list[str],
) -> tuple[str, dict[str, float | None]]:
    """Fetch the most recent price for each ticker.

    Returns a (timestamp, prices) tuple where *timestamp* is an ET
    datetime string (``YYYY-MM-DD HH:MM``) and *prices* maps each ticker
    to its price (or None if unavailable).

    The timestamp reflects:
    - **REGULAR** session: today's date + current ET time (live price).
    - **PRE / PREPRE**: previous trading day + ``16:00`` (last close).
    - **POST / CLOSED / etc.**: most recent trading day + ``16:00``.
    """
    if not tickers:
        log.warning("No tickers provided")
        return "", {}

    now_et = datetime.now(_ET)
    today_et = now_et.date()
    start = today_et - timedelta(days=10)

    market_state = _get_market_state(tickers[0])

    if market_state in ("PRE", "PREPRE"):
        # Market hasn't opened yet — get previous close.
        end = today_et
        log.info("Market is pre-session — fetching previous close (end=%s)", end)
    elif market_state == "REGULAR":
        # Market is open — include today's live data.
        end = today_et + timedelta(days=1)
        log.info("Market is open — fetching current prices (end=%s)", end)
    else:
        # POST, POSTPOST, CLOSED — include today for the regular-session close.
        # Explicit dates (not period="1d") to avoid post-market prices.
        end = today_et + timedelta(days=1)
        log.info("Market is closed — fetching most recent close (end=%s)", end)

    try:
        data = yf.download(
            tickers, start=start, end=end, progress=False,
        )
    except Exception:
        log.exception("Failed to download data from yfinance")
        return "", {t: None for t in tickers}

    if data.empty:
        log.error("yfinance returned an empty DataFrame")
        return "", {t: None for t in tickers}

    trade_date = data.index[-1].strftime("%Y-%m-%d")

    # Build the timestamp: actual time for live session, 16:00 for closes.
    if market_state == "REGULAR":
        timestamp = f"{trade_date} {now_et.strftime('%H:%M')}"
    else:
        timestamp = f"{trade_date} 16:00"

    prices: dict[str, float | None] = {}
    for ticker in tickers:
        try:
            raw = data["Close"][ticker].iloc[-1]
            price = float(raw)
            if math.isnan(price) or math.isinf(price):
                log.warning("Got non-finite price for %s: %s", ticker, raw)
                prices[ticker] = None
            elif price < 0:
                log.warning("Got negative price for %s: %s", ticker, price)
                prices[ticker] = None
            else:
                prices[ticker] = price
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            log.warning("Could not extract price for %s: %s", ticker, exc)
            prices[ticker] = None

    return timestamp, prices


def fetch_historical_prices(
    tickers: list[str],
    start: date,
    end: date,
) -> list[tuple[str, dict[str, float | None]]]:
    """Fetch closing prices for each trading day in [start, end].

    Returns a list of (timestamp, prices) tuples sorted ascending by date,
    one entry per trading day.  Timestamps use 16:00 ET (close).
    """
    if not tickers:
        log.warning("No tickers provided")
        return []

    # yfinance end is exclusive, so add one day.
    yf_end = end + timedelta(days=1)
    log.info("Fetching historical prices from %s to %s", start, end)

    try:
        data = yf.download(tickers, start=start, end=yf_end, progress=False)
    except Exception:
        log.exception("Failed to download historical data from yfinance")
        return []

    if data.empty:
        log.error("yfinance returned an empty DataFrame for range %s–%s", start, end)
        return []

    results: list[tuple[str, dict[str, float | None]]] = []
    for idx in data.index:
        trade_date = idx.strftime("%Y-%m-%d")
        timestamp = f"{trade_date} 16:00"
        prices: dict[str, float | None] = {}
        for ticker in tickers:
            try:
                raw = data["Close"][ticker].loc[idx]
                price = float(raw)
                if math.isnan(price) or math.isinf(price):
                    log.warning("Non-finite price for %s on %s", ticker, trade_date)
                    prices[ticker] = None
                elif price < 0:
                    log.warning("Negative price for %s on %s", ticker, trade_date)
                    prices[ticker] = None
                else:
                    prices[ticker] = price
            except (KeyError, TypeError, ValueError) as exc:
                log.warning("Could not extract price for %s on %s: %s", ticker, trade_date, exc)
                prices[ticker] = None
        results.append((timestamp, prices))

    log.info("Fetched %d trading day(s) in range", len(results))
    return results


def _read_csv(path: str) -> tuple[list[str], list[dict[str, str]]]:
    """Read an existing CSV and return (ticker_columns, rows).

    Each row is a dict keyed by column name.  Returns empty lists if the
    file does not exist or cannot be read.
    """
    if not os.path.exists(path):
        return [], []

    try:
        with open(path, newline="") as f:
            reader = csv.DictReader(f)
            fieldnames = list(reader.fieldnames or [])
            ticker_cols = [c for c in fieldnames if c != "timestamp"]
            return ticker_cols, list(reader)
    except OSError:
        log.exception("Failed to read existing CSV at %s", path)
        return [], []


def write_to_csv(
    timestamp: str, prices: dict[str, float | None], path: str,
) -> bool:
    """Upsert a row of prices into the CSV.

    - Rows are matched by the **date portion** (first 10 characters) of
      the ``timestamp`` column, so multiple runs on the same calendar day
      overwrite the same row (with an updated timestamp).
    - Only non-None prices overwrite existing cells.
    - New ticker columns are added to the header; historical rows get
      blank values for those columns.

    Returns True on success, False on failure.
    """
    if not prices:
        log.warning("No price data to write")
        return False

    existing_tickers, rows = _read_csv(path)

    # Build the full column list: existing columns first, then any new
    # tickers in sorted order so the header is stable.
    new_tickers = sorted(t for t in prices if t not in existing_tickers)
    all_tickers = existing_tickers + new_tickers

    # Find an existing row for this date, if any.
    date_part = timestamp[:10]
    target_row = None
    for row in rows:
        if row.get("timestamp", "")[:10] == date_part:
            target_row = row
            break

    if target_row is not None:
        log.info("Updating existing row for %s", date_part)
        target_row["timestamp"] = timestamp  # refresh the timestamp
        for ticker, price in prices.items():
            if price is not None:
                target_row[ticker] = f"{price:.2f}"
    else:
        new_row: dict[str, str] = {"timestamp": timestamp}
        for ticker, price in prices.items():
            new_row[ticker] = f"{price:.2f}" if price is not None else ""
        rows.append(new_row)

    rows.sort(key=lambda r: r.get("timestamp", "")[:10])
    fieldnames = ["timestamp"] + all_tickers

    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", newline="") as f:
            writer = csv.DictWriter(
                f, fieldnames=fieldnames, restval="", lineterminator="\n"
            )
            writer.writeheader()
            writer.writerows(rows)
    except OSError:
        log.exception("Failed to write to %s", path)
        return False

    return True


def print_prices(timestamp: str, prices: dict[str, float | None]) -> None:
    """Print prices to stdout in a human-readable format."""
    print(f"Prices as of {timestamp} ET:")
    for ticker, price in sorted(prices.items()):
        if price is not None:
            print(f"  {ticker}: ${price:.2f}")
        else:
            print(f"  {ticker}: N/A")


def _parse_date(value: str, label: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise SystemExit(f"Invalid {label} date '{value}' — expected YYYY-MM-DD") from None


def compute_min_transaction_date(
    trades_path: str | None,
    retirement_path: str | None,
) -> date | None:
    """Return the earliest transaction date across trades and retirement data.

    Scans *trades_path* (all ``date`` fields) and *retirement_path*
    (``values[].date`` and ``contributions[].date``).  Returns ``None``
    when no parseable dates are found or both files are missing.
    """
    dates: list[date] = []

    if trades_path:
        try:
            with open(trades_path) as f:
                trades = json.load(f)
            if isinstance(trades, list):
                for trade in trades:
                    if isinstance(trade, dict):
                        try:
                            dates.append(
                                datetime.strptime(trade["date"], "%Y-%m-%d").date()
                            )
                        except (KeyError, ValueError):
                            pass
        except (OSError, json.JSONDecodeError):
            log.warning("Could not read %s — skipping for backfill anchor", trades_path)

    if retirement_path:
        try:
            with open(retirement_path) as f:
                retirement = json.load(f)
            if isinstance(retirement, dict):
                for section in ("values", "contributions"):
                    for entry in retirement.get(section, []):
                        if isinstance(entry, dict):
                            try:
                                dates.append(
                                    datetime.strptime(entry["date"], "%Y-%m-%d").date()
                                )
                            except (KeyError, ValueError):
                                pass
        except (OSError, json.JSONDecodeError):
            log.warning(
                "Could not read %s — skipping for backfill anchor", retirement_path
            )

    return min(dates) if dates else None


def get_symbol_coverage(csv_path: str | None) -> dict[str, date]:
    """Return the earliest date each symbol has a non-empty price in the CSV.

    Returns an empty dict if *csv_path* is ``None``, the file does not
    exist, or it cannot be read.
    """
    if not csv_path:
        return {}

    ticker_cols, rows = _read_csv(csv_path)
    if not rows:
        return {}

    coverage: dict[str, date] = {}
    for row in rows:
        date_str = row.get("timestamp", "")[:10]
        if not date_str:
            continue
        try:
            row_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            continue
        for symbol in ticker_cols:
            if row.get(symbol, "").strip():
                if symbol not in coverage or row_date < coverage[symbol]:
                    coverage[symbol] = row_date

    return coverage


def find_symbols_needing_backfill(
    required_symbols: set[str],
    coverage: dict[str, date],
    min_date: date | None,
) -> set[str]:
    """Return the subset of *required_symbols* that lack coverage back to *min_date*.

    A symbol needs backfill when:
    - it is absent from *coverage* (no data at all), or
    - its earliest covered date is later than *min_date*.

    Returns an empty set when *min_date* is ``None`` (nothing to anchor to).
    """
    if min_date is None:
        return set()

    needing: set[str] = set()
    for symbol in required_symbols:
        earliest = coverage.get(symbol)
        if earliest is None or earliest > min_date:
            needing.add(symbol)
    return needing


def run_backfill_check(
    csv_path: str,
    trades_path: str | None,
    retirement_path: str | None,
    all_symbols: list[str],
) -> None:
    """Detect and fill gaps in historical market data.

    Determines the earliest transaction date across all data sources,
    checks whether each required symbol has CSV coverage back to that date,
    and fetches missing data in a single batched call when needed.

    This is intentionally idempotent: if all symbols are covered, it does
    nothing.  Safe to call on every startup.
    Lightweight enough to call on every fetch: short-circuits after one
    CSV read when coverage is already complete.
    """
    min_date = compute_min_transaction_date(trades_path, retirement_path)
    if min_date is None:
        log.info("No transaction data found — skipping backfill check")
        return

    coverage = get_symbol_coverage(csv_path)
    needing = find_symbols_needing_backfill(set(all_symbols), coverage, min_date)

    if not needing:
        log.info("Historical coverage is complete — no backfill needed")
        return

    log.info(
        "Backfilling %d symbol(s) back to %s: %s",
        len(needing),
        min_date,
        ", ".join(sorted(needing)),
    )
    fetch_start = min_date - timedelta(days=7)
    fetch_end = date.today()

    rows = fetch_historical_prices(sorted(needing), fetch_start, fetch_end)
    if not rows:
        log.error("Backfill fetch returned no data")
        return

    ok_count = 0
    for timestamp, prices in rows:
        if write_to_csv(timestamp, prices, csv_path):
            ok_count += 1
        else:
            log.error("Failed to write backfill row for %s", timestamp[:10])
    log.info("Backfill complete: wrote %d/%d row(s)", ok_count, len(rows))


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    # Derive all file paths from the data directory.
    if args.data_dir:
        csv_path = os.path.join(args.data_dir, "market.csv")
        trades_path = os.path.join(args.data_dir, "trades.json")
        retirement_path = os.path.join(args.data_dir, "retirement.json")
    else:
        csv_path = None
        trades_path = None
        retirement_path = None

    # Resolve tickers from all sources, including data files.
    tickers = resolve_tickers(args.tickers, csv_path)
    data_symbols = resolve_symbols_from_data_files(trades_path, retirement_path)
    all_tickers = sorted(set(tickers) | data_symbols)
    log.info("Fetching prices for: %s", ", ".join(all_tickers))

    if args.start:
        # Historical backfill mode (explicit --start/--end).
        start = _parse_date(args.start, "--start")
        end = _parse_date(args.end, "--end")
        if start > end:
            raise SystemExit("--start must not be later than --end")

        rows = fetch_historical_prices(all_tickers, start, end)
        if not rows:
            log.error("No historical data returned")
            return

        if csv_path:
            ok_count = 0
            for timestamp, prices in rows:
                if write_to_csv(timestamp, prices, csv_path):
                    ok_count += 1
                else:
                    log.error("Failed to write row for %s", timestamp[:10])
            log.info("Wrote %d/%d rows to %s", ok_count, len(rows), csv_path)
        else:
            for timestamp, prices in rows:
                print_prices(timestamp, prices)
        return

    # Default: fetch the most recent price.
    timestamp, prices = fetch_prices(all_tickers)

    if timestamp:
        log.info("Price timestamp: %s ET", timestamp)
    else:
        log.error("Could not determine trading date")

    failed = [t for t, p in prices.items() if p is None]
    if failed:
        log.warning(
            "Failed to fetch prices for: %s  "
            "(Tip: mutual fund tickers like FXAIX are not supported — "
            "use an ETF proxy such as SPY or VTI instead)",
            ", ".join(failed),
        )

    succeeded = {t: p for t, p in prices.items() if p is not None}
    if not succeeded:
        log.error("No valid prices fetched — nothing to report")
        return

    if csv_path:
        if write_to_csv(timestamp, prices, csv_path):
            log.info("Saved to %s", csv_path)
        else:
            log.error("Failed to save to %s", csv_path)

        # After the regular fetch, check for and fill historical gaps.
        run_backfill_check(csv_path, trades_path, retirement_path, all_tickers)
    else:
        print_prices(timestamp, prices)


if __name__ == "__main__":
    main()
