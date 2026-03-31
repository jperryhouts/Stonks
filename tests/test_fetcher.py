"""Unit tests for fetch_prices.py pure functions.

Run with:
    python3 -m unittest tests/test_fetcher.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import date
from unittest.mock import patch

import pandas as pd

# fetch_prices.py is not a package — add its directory to the path.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "utils", "tickers"))
from fetch_prices import (
    compute_min_transaction_date,
    find_symbols_needing_backfill,
    get_symbol_coverage,
    resolve_symbols_from_data_files,
    write_to_csv,
    resolve_tickers,
    fetch_prices,
    fetch_historical_prices,
    run_backfill_check,
)


def _write_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f)


def _write_csv(path, lines):
    """Write a CSV as a list of raw text lines (including header)."""
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


class TestComputeMinTransactionDate(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _path(self, name):
        return os.path.join(self.tmp, name)

    def test_both_paths_none(self):
        self.assertIsNone(compute_min_transaction_date(None, None))

    def test_missing_files(self):
        self.assertIsNone(
            compute_min_transaction_date(
                self._path("trades.json"), self._path("retirement.json")
            )
        )

    def test_trades_only(self):
        trades = [
            {"date": "2024-06-01", "symbol": "VTI", "price": "100", "quantity": "1"},
            {"date": "2024-03-15", "symbol": "VTI", "price": "100", "quantity": "1"},
        ]
        p = self._path("trades.json")
        _write_json(p, trades)
        self.assertEqual(compute_min_transaction_date(p, None), date(2024, 3, 15))

    def test_retirement_only(self):
        retirement = {
            "accounts": [{"name": "401k", "proxy": "VTI"}],
            "values": [{"date": "2024-05-01", "account": "401k", "value": "10000"}],
            "contributions": [{"date": "2024-02-10", "account": "401k", "value": "500"}],
        }
        p = self._path("retirement.json")
        _write_json(p, retirement)
        self.assertEqual(compute_min_transaction_date(None, p), date(2024, 2, 10))

    def test_both_files_returns_global_minimum(self):
        trades = [{"date": "2024-06-01", "symbol": "VTI", "price": "100", "quantity": "1"}]
        retirement = {
            "accounts": [],
            "values": [{"date": "2023-11-15", "account": "401k", "value": "5000"}],
            "contributions": [],
        }
        tp = self._path("trades.json")
        rp = self._path("retirement.json")
        _write_json(tp, trades)
        _write_json(rp, retirement)
        self.assertEqual(compute_min_transaction_date(tp, rp), date(2023, 11, 15))

    def test_malformed_json_treated_as_missing(self):
        p = self._path("trades.json")
        with open(p, "w") as f:
            f.write("not json {{{")
        self.assertIsNone(compute_min_transaction_date(p, None))

    def test_empty_trades_array(self):
        p = self._path("trades.json")
        _write_json(p, [])
        self.assertIsNone(compute_min_transaction_date(p, None))

    def test_weekend_date_returned_as_is(self):
        # Weekend dates are valid inputs — the caller adds the 7-day buffer.
        trades = [{"date": "2024-03-16", "symbol": "VTI", "price": "100", "quantity": "1"}]
        p = self._path("trades.json")
        _write_json(p, trades)
        self.assertEqual(compute_min_transaction_date(p, None), date(2024, 3, 16))

    def test_invalid_date_string_skipped(self):
        trades = [
            {"date": "not-a-date", "symbol": "VTI", "price": "100", "quantity": "1"},
            {"date": "2024-06-01", "symbol": "VTI", "price": "100", "quantity": "1"},
        ]
        p = self._path("trades.json")
        _write_json(p, trades)
        self.assertEqual(compute_min_transaction_date(p, None), date(2024, 6, 1))


class TestGetSymbolCoverage(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _path(self, name):
        return os.path.join(self.tmp, name)

    def test_missing_csv_returns_empty(self):
        self.assertEqual(get_symbol_coverage(self._path("market.csv")), {})

    def test_none_path_returns_empty(self):
        self.assertEqual(get_symbol_coverage(None), {})

    def test_symbol_with_data_before_date(self):
        p = self._path("market.csv")
        _write_csv(p, [
            "timestamp,VTI,VXUS",
            "2024-03-01 16:00,250.00,55.00",
            "2024-03-04 16:00,251.00,55.50",
        ])
        cov = get_symbol_coverage(p)
        self.assertEqual(cov["VTI"], date(2024, 3, 1))
        self.assertEqual(cov["VXUS"], date(2024, 3, 1))

    def test_symbol_with_empty_values_excluded(self):
        p = self._path("market.csv")
        _write_csv(p, [
            "timestamp,VTI,NVDA",
            "2024-03-01 16:00,250.00,",
            "2024-03-04 16:00,251.00,",
        ])
        cov = get_symbol_coverage(p)
        self.assertIn("VTI", cov)
        self.assertNotIn("NVDA", cov)

    def test_symbol_added_later_shows_later_start(self):
        p = self._path("market.csv")
        _write_csv(p, [
            "timestamp,VTI,NVDA",
            "2024-01-02 16:00,240.00,",
            "2024-06-03 16:00,261.00,120.00",
        ])
        cov = get_symbol_coverage(p)
        self.assertEqual(cov["VTI"], date(2024, 1, 2))
        self.assertEqual(cov["NVDA"], date(2024, 6, 3))

    def test_empty_csv_returns_empty(self):
        p = self._path("market.csv")
        _write_csv(p, ["timestamp,VTI"])
        self.assertEqual(get_symbol_coverage(p), {})


class TestFindSymbolsNeedingBackfill(unittest.TestCase):

    def test_none_min_date_returns_empty(self):
        result = find_symbols_needing_backfill({"VTI", "VXUS"}, {}, None)
        self.assertEqual(result, set())

    def test_all_symbols_covered(self):
        coverage = {"VTI": date(2024, 1, 2), "VXUS": date(2024, 1, 2)}
        result = find_symbols_needing_backfill(
            {"VTI", "VXUS"}, coverage, date(2024, 3, 15)
        )
        self.assertEqual(result, set())

    def test_symbol_missing_from_csv(self):
        coverage = {"VTI": date(2024, 1, 2)}
        result = find_symbols_needing_backfill(
            {"VTI", "NVDA"}, coverage, date(2024, 3, 15)
        )
        self.assertEqual(result, {"NVDA"})

    def test_symbol_coverage_starts_after_min_date(self):
        # NVDA was added mid-history; its coverage starts after the first trade.
        coverage = {
            "VTI": date(2024, 1, 2),
            "NVDA": date(2024, 6, 1),
        }
        result = find_symbols_needing_backfill(
            {"VTI", "NVDA"}, coverage, date(2024, 3, 15)
        )
        self.assertEqual(result, {"NVDA"})

    def test_symbol_coverage_exactly_on_min_date_is_covered(self):
        coverage = {"VTI": date(2024, 3, 15)}
        result = find_symbols_needing_backfill(
            {"VTI"}, coverage, date(2024, 3, 15)
        )
        self.assertEqual(result, set())

    def test_symbol_coverage_before_min_date_is_covered(self):
        # Data goes back before the first trade — definitely covered.
        coverage = {"VTI": date(2024, 3, 8)}  # one week before first trade
        result = find_symbols_needing_backfill(
            {"VTI"}, coverage, date(2024, 3, 15)
        )
        self.assertEqual(result, set())

    def test_no_required_symbols(self):
        result = find_symbols_needing_backfill(set(), {}, date(2024, 3, 15))
        self.assertEqual(result, set())


class TestWriteToCsv(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _path(self, name):
        return os.path.join(self.tmp, name)

    def _read_csv_raw(self, path):
        import csv as _csv
        with open(path, newline="") as f:
            return list(_csv.DictReader(f))

    def test_creates_new_file(self):
        p = self._path("market.csv")
        self.assertTrue(write_to_csv("2024-03-15 16:00", {"VTI": 250.0}, p))
        rows = self._read_csv_raw(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["VTI"], "250.00")

    def test_same_date_does_not_duplicate(self):
        p = self._path("market.csv")
        write_to_csv("2024-03-15 16:00", {"VTI": 250.0}, p)
        write_to_csv("2024-03-15 16:00", {"VTI": 251.0}, p)
        rows = self._read_csv_raw(p)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["VTI"], "251.00")

    def test_new_symbol_column_appended_existing_data_retained(self):
        p = self._path("market.csv")
        write_to_csv("2024-03-15 16:00", {"VTI": 250.0}, p)
        write_to_csv("2024-03-18 16:00", {"VTI": 252.0, "NVDA": 120.0}, p)
        rows = self._read_csv_raw(p)
        self.assertEqual(len(rows), 2)
        # Original VTI row should still have its value; NVDA blank for that date.
        self.assertEqual(rows[0]["VTI"], "250.00")
        self.assertEqual(rows[0].get("NVDA", ""), "")
        self.assertEqual(rows[1]["VTI"], "252.00")
        self.assertEqual(rows[1]["NVDA"], "120.00")

    def test_none_price_does_not_overwrite_existing(self):
        p = self._path("market.csv")
        write_to_csv("2024-03-15 16:00", {"VTI": 250.0}, p)
        write_to_csv("2024-03-15 16:00", {"VTI": None}, p)
        rows = self._read_csv_raw(p)
        self.assertEqual(rows[0]["VTI"], "250.00")

    def test_rows_sorted_by_date(self):
        p = self._path("market.csv")
        write_to_csv("2024-03-18 16:00", {"VTI": 252.0}, p)
        write_to_csv("2024-03-15 16:00", {"VTI": 250.0}, p)
        write_to_csv("2024-03-19 16:00", {"VTI": 253.0}, p)
        rows = self._read_csv_raw(p)
        dates = [r["timestamp"][:10] for r in rows]
        self.assertEqual(dates, ["2024-03-15", "2024-03-18", "2024-03-19"])


class TestResolveSymbolsFromDataFiles(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _path(self, name):
        return os.path.join(self.tmp, name)

    def test_both_paths_none(self):
        self.assertEqual(resolve_symbols_from_data_files(None, None), set())

    def test_missing_files_return_empty(self):
        result = resolve_symbols_from_data_files(
            self._path("trades.json"), self._path("retirement.json")
        )
        self.assertEqual(result, set())

    def test_trades_symbols_extracted(self):
        trades = [
            {"date": "2024-03-15", "symbol": "VTI", "price": "100", "quantity": "1"},
            {"date": "2024-03-16", "symbol": "vxus", "price": "55", "quantity": "2"},
        ]
        p = self._path("trades.json")
        _write_json(p, trades)
        result = resolve_symbols_from_data_files(p, None)
        self.assertEqual(result, {"VTI", "VXUS"})  # uppercased

    def test_retirement_proxy_extracted(self):
        retirement = {
            "accounts": [
                {"name": "401k", "proxy": "VTI"},
                {"name": "HSA", "proxy": "VXUS"},
            ],
            "values": [],
            "contributions": [],
        }
        p = self._path("retirement.json")
        _write_json(p, retirement)
        result = resolve_symbols_from_data_files(None, p)
        self.assertEqual(result, {"VTI", "VXUS"})

    def test_retirement_proxy_defaults_to_vti_when_absent(self):
        retirement = {
            "accounts": [{"name": "401k"}],  # no proxy key
            "values": [],
            "contributions": [],
        }
        p = self._path("retirement.json")
        _write_json(p, retirement)
        result = resolve_symbols_from_data_files(None, p)
        self.assertEqual(result, {"VTI"})

    def test_both_files_returns_union(self):
        trades = [{"date": "2024-01-01", "symbol": "BND", "price": "70", "quantity": "5"}]
        retirement = {
            "accounts": [{"name": "401k", "proxy": "VTI"}],
            "values": [],
            "contributions": [],
        }
        tp = self._path("trades.json")
        rp = self._path("retirement.json")
        _write_json(tp, trades)
        _write_json(rp, retirement)
        result = resolve_symbols_from_data_files(tp, rp)
        self.assertEqual(result, {"BND", "VTI"})

    def test_malformed_json_treated_as_missing(self):
        p = self._path("trades.json")
        with open(p, "w") as f:
            f.write("not valid json")
        result = resolve_symbols_from_data_files(p, None)
        self.assertEqual(result, set())


class TestResolveTickers(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        # Isolate each test from the ambient TICKERS env var
        self._orig = os.environ.pop("TICKERS", None)

    def tearDown(self):
        if self._orig is not None:
            os.environ["TICKERS"] = self._orig
        elif "TICKERS" in os.environ:
            del os.environ["TICKERS"]

    def _make_csv(self, tickers):
        """Write a minimal market.csv so resolve_tickers can read column headers."""
        p = os.path.join(self.tmp, "market.csv")
        with open(p, "w") as f:
            f.write("timestamp," + ",".join(tickers) + "\n")
            f.write("2024-01-02 16:00," + ",".join(["100"] * len(tickers)) + "\n")
        return p

    def test_cli_args_uppercased_and_returned(self):
        result = resolve_tickers(["vti", "vxus"])
        self.assertEqual(result, ["VTI", "VXUS"])

    def test_cli_args_take_precedence_over_env(self):
        os.environ["TICKERS"] = "BND"
        result = resolve_tickers(["VTI"])
        self.assertEqual(result, ["VTI"])

    def test_env_var_comma_separated(self):
        os.environ["TICKERS"] = "VTI,VXUS,BND"
        result = resolve_tickers([])
        self.assertEqual(result, ["VTI", "VXUS", "BND"])

    def test_env_var_entries_uppercased_and_trimmed(self):
        os.environ["TICKERS"] = " vti , vxus "
        result = resolve_tickers([])
        self.assertEqual(result, ["VTI", "VXUS"])

    def test_env_var_blank_entries_skipped(self):
        os.environ["TICKERS"] = "VTI,,VXUS"
        result = resolve_tickers([])
        self.assertEqual(result, ["VTI", "VXUS"])

    def test_empty_env_var_falls_through_to_csv(self):
        os.environ["TICKERS"] = ""
        csv_path = self._make_csv(["BND"])
        result = resolve_tickers([], csv_path=csv_path)
        self.assertEqual(result, ["BND"])

    def test_csv_path_used_when_no_cli_or_env(self):
        csv_path = self._make_csv(["VTI", "VXUS"])
        result = resolve_tickers([], csv_path=csv_path)
        self.assertEqual(result, ["VTI", "VXUS"])

    def test_missing_csv_falls_through_to_defaults(self):
        result = resolve_tickers([], csv_path=os.path.join(self.tmp, "nonexistent.csv"))
        self.assertEqual(result, ["VTI", "VXUS", "BND"])

    def test_no_args_no_env_no_csv_uses_defaults(self):
        result = resolve_tickers([])
        self.assertEqual(result, ["VTI", "VXUS", "BND"])


def _make_yf_data(ticker_prices, date_str="2024-03-15"):
    """Return a minimal MultiIndex DataFrame mimicking yf.download output.

    ticker_prices: {"VTI": 250.0, "BND": 72.0}
    Access pattern used by fetch_prices: data["Close"][ticker].iloc[-1]
    """
    idx = pd.DatetimeIndex([pd.Timestamp(date_str)])
    tuples = [("Close", t) for t in ticker_prices]
    cols = pd.MultiIndex.from_tuples(tuples)
    values = [[ticker_prices[t] for t in ticker_prices]]
    return pd.DataFrame(values, index=idx, columns=cols)


class TestFetchPrices(unittest.TestCase):

    def setUp(self):
        import logging
        logging.disable(logging.CRITICAL)

    def tearDown(self):
        import logging
        logging.disable(logging.NOTSET)

    def test_empty_tickers_returns_empty_immediately(self):
        ts, prices = fetch_prices([])
        self.assertEqual(ts, "")
        self.assertEqual(prices, {})

    @patch("fetch_prices._get_market_state", return_value="CLOSED")
    @patch("fetch_prices.yf.download")
    def test_closed_market_timestamp_is_16_00(self, mock_dl, _mock_state):
        mock_dl.return_value = _make_yf_data({"VTI": 250.0}, "2024-03-15")
        ts, prices = fetch_prices(["VTI"])
        self.assertEqual(ts, "2024-03-15 16:00")
        self.assertAlmostEqual(prices["VTI"], 250.0, places=2)

    @patch("fetch_prices._get_market_state", return_value="POST")
    @patch("fetch_prices.yf.download")
    def test_post_market_timestamp_is_16_00(self, mock_dl, _mock_state):
        mock_dl.return_value = _make_yf_data({"VTI": 251.0}, "2024-03-15")
        ts, prices = fetch_prices(["VTI"])
        self.assertTrue(ts.endswith("16:00"), f"Expected 16:00 suffix, got {ts!r}")

    @patch("fetch_prices._get_market_state", return_value="PRE")
    @patch("fetch_prices.yf.download")
    def test_pre_market_timestamp_is_16_00(self, mock_dl, _mock_state):
        mock_dl.return_value = _make_yf_data({"VTI": 249.0}, "2024-03-14")
        ts, prices = fetch_prices(["VTI"])
        self.assertTrue(ts.endswith("16:00"), f"Expected 16:00 suffix, got {ts!r}")

    @patch("fetch_prices._get_market_state", return_value="CLOSED")
    @patch("fetch_prices.yf.download")
    def test_nan_price_becomes_none(self, mock_dl, _mock_state):
        mock_dl.return_value = _make_yf_data({"VTI": float("nan")}, "2024-03-15")
        _, prices = fetch_prices(["VTI"])
        self.assertIsNone(prices["VTI"])

    @patch("fetch_prices._get_market_state", return_value="CLOSED")
    @patch("fetch_prices.yf.download")
    def test_negative_price_becomes_none(self, mock_dl, _mock_state):
        mock_dl.return_value = _make_yf_data({"VTI": -1.0}, "2024-03-15")
        _, prices = fetch_prices(["VTI"])
        self.assertIsNone(prices["VTI"])

    @patch("fetch_prices._get_market_state", return_value="CLOSED")
    @patch("fetch_prices.yf.download", side_effect=Exception("network timeout"))
    def test_download_exception_returns_none_prices(self, _mock_dl, _mock_state):
        ts, prices = fetch_prices(["VTI", "BND"])
        self.assertEqual(ts, "")
        self.assertIsNone(prices["VTI"])
        self.assertIsNone(prices["BND"])

    @patch("fetch_prices._get_market_state", return_value="CLOSED")
    @patch("fetch_prices.yf.download")
    def test_empty_dataframe_returns_empty(self, mock_dl, _mock_state):
        # Decorator order: innermost @patch arg comes first → mock_dl = yf.download
        mock_dl.return_value = pd.DataFrame()
        ts, prices = fetch_prices(["VTI"])
        self.assertEqual(ts, "")
        self.assertIsNone(prices.get("VTI"))

    @patch("fetch_prices._get_market_state", return_value="CLOSED")
    @patch("fetch_prices.yf.download")
    def test_multiple_tickers_all_returned(self, mock_dl, _mock_state):
        mock_dl.return_value = _make_yf_data({"VTI": 250.0, "BND": 72.0}, "2024-03-15")
        ts, prices = fetch_prices(["VTI", "BND"])
        self.assertAlmostEqual(prices["VTI"], 250.0, places=2)
        self.assertAlmostEqual(prices["BND"], 72.0, places=2)


def _make_yf_multi(date_ticker_prices):
    """Build a multi-row, multi-ticker yfinance DataFrame.

    date_ticker_prices: {"2024-03-15": {"VTI": 250.0}, "2024-03-18": {"VTI": 252.0}}
    """
    dates = sorted(date_ticker_prices.keys())
    all_tickers = sorted(next(iter(date_ticker_prices.values())).keys())
    idx = pd.DatetimeIndex([pd.Timestamp(d) for d in dates])
    tuples = [("Close", t) for t in all_tickers]
    cols = pd.MultiIndex.from_tuples(tuples)
    rows = [[date_ticker_prices[d].get(t, float("nan")) for t in all_tickers] for d in dates]
    return pd.DataFrame(rows, index=idx, columns=cols)


class TestFetchHistoricalPrices(unittest.TestCase):

    def setUp(self):
        import logging
        logging.disable(logging.CRITICAL)

    def tearDown(self):
        import logging
        logging.disable(logging.NOTSET)

    def test_empty_tickers_returns_empty_list(self):
        result = fetch_historical_prices([], date(2024, 1, 2), date(2024, 1, 5))
        self.assertEqual(result, [])

    @patch("fetch_prices._get_market_state", return_value="CLOSED")
    @patch("fetch_prices.yf.download")
    def test_returns_one_entry_per_trading_day(self, mock_dl, _mock_state):
        mock_dl.return_value = _make_yf_multi({
            "2024-03-15": {"VTI": 250.0},
            "2024-03-18": {"VTI": 252.0},
        })
        results = fetch_historical_prices(["VTI"], date(2024, 3, 15), date(2024, 3, 18))
        self.assertEqual(len(results), 2)

    @patch("fetch_prices.yf.download")
    def test_purely_historical_range_skips_market_state_check(self, mock_dl):
        """Ranges ending before today should not call _get_market_state."""
        mock_dl.return_value = _make_yf_multi({"2020-01-02": {"VTI": 160.0}})
        with patch("fetch_prices._get_market_state", side_effect=AssertionError("should not be called")):
            results = fetch_historical_prices(["VTI"], date(2020, 1, 2), date(2020, 1, 2))
        self.assertEqual(len(results), 1)

    @patch("fetch_prices.yf.download", side_effect=Exception("network error"))
    def test_download_exception_returns_empty(self, _mock_dl):
        with patch("fetch_prices._get_market_state", return_value="CLOSED"):
            results = fetch_historical_prices(["VTI"], date(2024, 3, 15), date(2024, 3, 18))
        self.assertEqual(results, [])

    @patch("fetch_prices.yf.download")
    def test_timestamps_use_16_00_for_closed_session(self, mock_dl):
        mock_dl.return_value = _make_yf_multi({"2020-01-02": {"VTI": 160.0}})
        with patch("fetch_prices._get_market_state", return_value="CLOSED"):
            results = fetch_historical_prices(["VTI"], date(2020, 1, 2), date(2020, 1, 2))
        self.assertEqual(results[0][0], "2020-01-02 16:00")

    @patch("fetch_prices.yf.download")
    def test_entries_sorted_ascending_by_date(self, mock_dl):
        mock_dl.return_value = _make_yf_multi({
            "2024-03-15": {"VTI": 250.0},
            "2024-03-18": {"VTI": 252.0},
            "2024-03-19": {"VTI": 253.0},
        })
        with patch("fetch_prices._get_market_state", return_value="CLOSED"):
            results = fetch_historical_prices(["VTI"], date(2024, 3, 15), date(2024, 3, 19))
        dates = [r[0][:10] for r in results]
        self.assertEqual(dates, ["2024-03-15", "2024-03-18", "2024-03-19"])


class TestRunBackfillCheck(unittest.TestCase):
    """Integration tests for run_backfill_check.

    Mocks fetch_historical_prices (network) but uses real file I/O via a temp directory.
    """

    def setUp(self):
        import logging
        logging.disable(logging.CRITICAL)
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        import logging
        logging.disable(logging.NOTSET)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _path(self, name):
        return os.path.join(self.tmp, name)

    def _write_trades(self, trades):
        _write_json(self._path("trades.json"), trades)

    def _write_market_csv(self, lines):
        _write_csv(self._path("market.csv"), lines)

    def _read_csv_rows(self):
        import csv as _csv
        p = self._path("market.csv")
        if not os.path.exists(p):
            return []
        with open(p, newline="") as f:
            return list(_csv.DictReader(f))

    def test_no_transaction_data_does_nothing(self):
        """When trades.json and retirement.json are absent, backfill is skipped."""
        with patch("fetch_prices.fetch_historical_prices") as mock_fetch:
            run_backfill_check(
                self._path("market.csv"), None, None, ["VTI"]
            )
        mock_fetch.assert_not_called()

    def test_all_coverage_complete_skips_fetch(self):
        """If CSV already covers back to the earliest trade, no fetch occurs."""
        self._write_trades([
            {"date": "2024-03-15", "symbol": "VTI", "price": "250", "quantity": "1"}
        ])
        self._write_market_csv([
            "timestamp,VTI",
            "2024-03-01 16:00,248.00",
            "2024-03-15 16:00,250.00",
        ])
        with patch("fetch_prices.fetch_historical_prices") as mock_fetch:
            run_backfill_check(
                self._path("market.csv"),
                self._path("trades.json"),
                None,
                ["VTI"],
            )
        mock_fetch.assert_not_called()

    @patch("fetch_prices.fetch_historical_prices")
    def test_missing_symbol_triggers_backfill_write(self, mock_fetch):
        """New symbol NVDA not in CSV → backfill fetched and written."""
        self._write_trades([
            {"date": "2024-03-15", "symbol": "VTI", "price": "250", "quantity": "1"}
        ])
        self._write_market_csv([
            "timestamp,VTI",
            "2024-03-15 16:00,250.00",
        ])
        mock_fetch.return_value = [("2024-03-15 16:00", {"NVDA": 880.0})]

        run_backfill_check(
            self._path("market.csv"),
            self._path("trades.json"),
            None,
            ["VTI", "NVDA"],
        )

        rows = self._read_csv_rows()
        self.assertTrue(any("NVDA" in r for r in rows))

    @patch("fetch_prices.fetch_historical_prices", return_value=[])
    def test_empty_fetch_result_logs_error_but_does_not_crash(self, _mock_fetch):
        """If fetch returns no data, run_backfill_check should not raise."""
        self._write_trades([
            {"date": "2024-03-15", "symbol": "NVDA", "price": "880", "quantity": "1"}
        ])
        run_backfill_check(
            self._path("market.csv"),
            self._path("trades.json"),
            None,
            ["NVDA"],
        )  # should not raise


if __name__ == "__main__":
    unittest.main()
