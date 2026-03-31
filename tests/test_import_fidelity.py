"""Tests for utils/importers/import_fidelity.py."""
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "utils", "importers"))
from import_fidelity import extract_data_lines, load_contributions_from_csv, iso_date


class TestIsoDate(unittest.TestCase):

    def test_converts_mm_dd_yyyy(self):
        self.assertEqual(iso_date("03/15/2024"), "2024-03-15")

    def test_strips_surrounding_whitespace(self):
        self.assertEqual(iso_date("  01/01/2023  "), "2023-01-01")

    def test_zero_pads_month_and_day(self):
        self.assertEqual(iso_date("1/5/2024"), "2024-01-05")


class TestExtractDataLines(unittest.TestCase):

    def test_blank_lines_at_top_stripped(self):
        raw = "\n\nDate,Investment,Transaction Type\n03/15/2024,VTSAX,Contributions\n"
        lines = extract_data_lines(raw)
        self.assertEqual(lines[0].strip().split(",")[0].lower(), "date")

    def test_footer_lines_excluded(self):
        raw = (
            "Date,Investment,Transaction Type,Amount ($)\n"
            "03/15/2024,VTSAX,Contributions,500.00\n"
            "\n"
            '"Footer text here"\n'
        )
        lines = extract_data_lines(raw)
        # Only header + data row; footer not included
        self.assertEqual(len(lines), 2)

    def test_empty_input_returns_empty(self):
        self.assertEqual(extract_data_lines(""), [])

    def test_whitespace_only_returns_empty(self):
        self.assertEqual(extract_data_lines("   \n\n  "), [])


class TestLoadContributions401k(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_csv(self, content):
        p = os.path.join(self.tmp, "fidelity.csv")
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return p

    def test_basic_401k_format(self):
        content = (
            "Date,Investment,Transaction Type,Amount ($)\n"
            "03/15/2024,VTSAX,Contributions,500.00\n"
        )
        result = load_contributions_from_csv(self._write_csv(content))
        self.assertIn("2024-03-15", result)
        self.assertAlmostEqual(result["2024-03-15"], 500.0, places=2)

    def test_non_contribution_rows_excluded(self):
        content = (
            "Date,Investment,Transaction Type,Amount ($)\n"
            "03/15/2024,VTSAX,Contributions,500.00\n"
            "03/15/2024,VTSAX,Dividends,10.00\n"
            "03/15/2024,VTSAX,Exchange Out,-500.00\n"
        )
        result = load_contributions_from_csv(self._write_csv(content))
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result["2024-03-15"], 500.0, places=2)

    def test_same_date_amounts_summed(self):
        content = (
            "Date,Investment,Transaction Type,Amount ($)\n"
            "03/15/2024,VTSAX,Contributions,300.00\n"
            "03/15/2024,FXAIX,Contributions,200.00\n"
        )
        result = load_contributions_from_csv(self._write_csv(content))
        self.assertAlmostEqual(result["2024-03-15"], 500.0, places=2)

    def test_multiple_dates_separate_entries(self):
        content = (
            "Date,Investment,Transaction Type,Amount ($)\n"
            "03/15/2024,VTSAX,Contributions,500.00\n"
            "03/29/2024,VTSAX,Contributions,500.00\n"
        )
        result = load_contributions_from_csv(self._write_csv(content))
        self.assertEqual(len(result), 2)

    def test_blank_amount_row_skipped(self):
        content = (
            "Date,Investment,Transaction Type,Amount ($)\n"
            "03/15/2024,VTSAX,Contributions,\n"
            "03/22/2024,VTSAX,Contributions,400.00\n"
        )
        result = load_contributions_from_csv(self._write_csv(content))
        self.assertNotIn("2024-03-15", result)
        self.assertIn("2024-03-22", result)


class TestLoadContributionsHSA(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_csv(self, content):
        p = os.path.join(self.tmp, "fidelity_hsa.csv")
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return p

    def test_hsa_format_contr_action(self):
        content = (
            "Run Date,Action,Amount ($)\n"
            "03/15/2024,CONTRIBUTION,250.00\n"
        )
        result = load_contributions_from_csv(self._write_csv(content))
        self.assertIn("2024-03-15", result)
        self.assertAlmostEqual(result["2024-03-15"], 250.0, places=2)

    def test_hsa_format_case_insensitive_contr(self):
        content = (
            "Run Date,Action,Amount ($)\n"
            "03/15/2024,contr payroll,100.00\n"
        )
        result = load_contributions_from_csv(self._write_csv(content))
        self.assertIn("2024-03-15", result)

    def test_hsa_non_contribution_rows_excluded(self):
        content = (
            "Run Date,Action,Amount ($)\n"
            "03/15/2024,DIVIDEND,10.00\n"
            "03/15/2024,CONTRIBUTION,200.00\n"
        )
        result = load_contributions_from_csv(self._write_csv(content))
        self.assertAlmostEqual(result["2024-03-15"], 200.0, places=2)

    def test_unrecognized_format_raises(self):
        content = "WeirdCol1,WeirdCol2\n03/15/2024,500\n"
        with self.assertRaises(ValueError):
            load_contributions_from_csv(self._write_csv(content))


if __name__ == "__main__":
    unittest.main()
