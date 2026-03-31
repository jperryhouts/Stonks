"""Tests for utils/importers/import_schwab.py."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "utils", "importers"))
from import_schwab import clean_num, iso, parse_schwab_data


class TestCleanNum(unittest.TestCase):

    def test_strips_dollar_sign(self):
        self.assertEqual(clean_num("$250.00"), "250.00")

    def test_strips_commas(self):
        self.assertEqual(clean_num("1,250.00"), "1250.00")

    def test_strips_dollar_and_commas(self):
        self.assertEqual(clean_num("$1,250.00"), "1250.00")

    def test_strips_whitespace(self):
        self.assertEqual(clean_num("  100.00  "), "100.00")

    def test_none_returns_empty_string(self):
        self.assertEqual(clean_num(None), "")

    def test_empty_string_returns_empty_string(self):
        self.assertEqual(clean_num(""), "")


class TestIso(unittest.TestCase):

    def test_basic_date(self):
        self.assertEqual(iso("03/15/2024"), "2024-03-15")

    def test_strips_as_of_suffix(self):
        self.assertEqual(iso("03/15/2024 as of 03/14/2024"), "2024-03-15")

    def test_zero_pads(self):
        self.assertEqual(iso("1/5/2024"), "2024-01-05")


class TestParseSchwabBrokerage(unittest.TestCase):
    """Tests for the BrokerageTransactions format."""

    def _data(self, transactions):
        return {"BrokerageTransactions": transactions}

    def _tx(self, action, symbol="VTI", date="03/15/2024", price="$250.00",
             quantity="10", amount=None):
        t = {"Action": action, "Symbol": symbol, "Date": date,
             "Price": price, "Quantity": quantity}
        if amount is not None:
            t["Amount"] = amount
        return t

    def test_buy_action_produces_buy_trade(self):
        trades = parse_schwab_data(self._data([self._tx("Buy")]))
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["type"], "buy")
        self.assertEqual(trades[0]["symbol"], "VTI")
        self.assertEqual(trades[0]["date"], "2024-03-15")
        self.assertAlmostEqual(float(trades[0]["price"]), 250.0, places=4)
        self.assertAlmostEqual(float(trades[0]["quantity"]), 10.0, places=4)

    def test_sell_action_produces_sell_trade_with_positive_quantity(self):
        trades = parse_schwab_data(self._data([self._tx("Sell", quantity="-5")]))
        self.assertEqual(trades[0]["type"], "sell")
        self.assertGreater(float(trades[0]["quantity"]), 0,
                           "Sell quantity should be stored as positive")

    def test_reinvest_shares_produces_drip_trade(self):
        trades = parse_schwab_data(self._data([self._tx("Reinvest Shares", quantity="0.5")]))
        self.assertEqual(trades[0]["type"], "drip")
        self.assertEqual(trades[0]["note"], "reinvested dividend")

    def test_journaled_shares_skipped(self):
        trades = parse_schwab_data(self._data([self._tx("Journaled Shares")]))
        self.assertEqual(trades, [])

    def test_empty_symbol_skipped(self):
        trades = parse_schwab_data(self._data([self._tx("Buy", symbol="")]))
        self.assertEqual(trades, [])

    def test_whitespace_symbol_skipped(self):
        trades = parse_schwab_data(self._data([self._tx("Buy", symbol="   ")]))
        self.assertEqual(trades, [])

    def test_multiple_transactions_all_returned(self):
        trades = parse_schwab_data(self._data([
            self._tx("Buy", symbol="VTI"),
            self._tx("Sell", symbol="BND"),
        ]))
        self.assertEqual(len(trades), 2)


class TestParseSchwabEquityAwards(unittest.TestCase):
    """Tests for the Transactions (equity awards) format."""

    def _data(self, transactions):
        return {"Transactions": transactions}

    def _lapse_tx(self, symbol="NVDA", date="03/15/2024", qty="10",
                  fmv_price="$880.00", award_id="ABC123"):
        return {
            "Action": "Lapse",
            "Symbol": symbol,
            "Date": date,
            "Quantity": qty,
            "TransactionDetails": [{"Details": {
                "FairMarketValuePrice": fmv_price,
                "AwardId": award_id,
            }}],
        }

    def test_lapse_produces_buy_trade_at_fmv(self):
        trades = parse_schwab_data(self._data([self._lapse_tx()]))
        self.assertEqual(len(trades), 1)
        self.assertEqual(trades[0]["type"], "buy")
        self.assertIn("RSU vest", trades[0]["note"])
        self.assertAlmostEqual(float(trades[0]["price"]), 880.0, places=4)

    def test_espp_deposit_produces_buy_trade(self):
        tx = {
            "Action": "Deposit",
            "Description": "ESPP",
            "Symbol": "NVDA",
            "Date": "03/15/2024",
            "Quantity": "5",
            "TransactionDetails": [{"Details": {"PurchasePrice": "$800.00"}}],
        }
        trades = parse_schwab_data(self._data([tx]))
        self.assertEqual(trades[0]["type"], "buy")
        self.assertEqual(trades[0]["note"], "ESPP purchase")

    def test_sale_uses_sale_price_from_details(self):
        tx = {
            "Action": "Sale",
            "Symbol": "NVDA",
            "Date": "03/15/2024",
            "Quantity": "-3",
            "Amount": "$2640.00",
            "TransactionDetails": [{"Details": {"SalePrice": "$880.00"}}],
        }
        trades = parse_schwab_data(self._data([tx]))
        self.assertEqual(trades[0]["type"], "sell")
        self.assertAlmostEqual(float(trades[0]["price"]), 880.0, places=4)
        self.assertGreater(float(trades[0]["quantity"]), 0)

    def test_sale_falls_back_to_amount_divided_by_qty(self):
        tx = {
            "Action": "Sale",
            "Symbol": "NVDA",
            "Date": "03/15/2024",
            "Quantity": "3",
            "Amount": "$2640.00",
            "TransactionDetails": [{"Details": {}}],  # no SalePrice
        }
        trades = parse_schwab_data(self._data([tx]))
        self.assertAlmostEqual(float(trades[0]["price"]), 880.0, places=4)

    def test_deposit_without_espp_description_skipped(self):
        tx = {
            "Action": "Deposit",
            "Description": "RS",  # not ESPP
            "Symbol": "NVDA",
            "Date": "03/15/2024",
            "Quantity": "5",
            "TransactionDetails": [{"Details": {}}],
        }
        trades = parse_schwab_data(self._data([tx]))
        self.assertEqual(trades, [])


class TestParseSchwabUnrecognizedFormat(unittest.TestCase):

    def test_returns_empty_for_unrecognized_format(self):
        trades = parse_schwab_data({"UnknownKey": []})
        self.assertEqual(trades, [])


if __name__ == "__main__":
    unittest.main()
