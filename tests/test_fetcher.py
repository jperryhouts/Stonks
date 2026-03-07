"""Unit tests for fetch_prices.py pure functions.

Run with:
    python3 -m unittest tests/test_fetcher.py
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import date

# fetch_prices.py is not a package — add its directory to the path.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "utils", "tickers"))
from fetch_prices import (
    compute_min_transaction_date,
    find_symbols_needing_backfill,
    get_symbol_coverage,
    resolve_symbols_from_data_files,
    write_to_csv,
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


if __name__ == "__main__":
    unittest.main()
