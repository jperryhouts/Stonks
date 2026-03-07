#!/usr/bin/env python3
"""Import contribution history from Fidelity CSV exports into retirement.json.

Supports two Fidelity CSV export formats:
  - Account History (401k / workplace): columns include "Date", "Investment",
    "Transaction Type". Filters rows where Transaction Type == "Contributions".
  - Brokerage/HSA History: columns include "Run Date", "Action". Filters rows
    where Action contains "CONTR".

Both formats sum contribution amounts by date before upserting.

Usage:
    python3 utils/importers/import_fidelity_401k.py \\
        --csv Fidelity_History_for_Account_XXXXX.csv \\
        --retirement app/data/retirement.json \\
        --account "401k"

    python3 utils/importers/import_fidelity_401k.py \\
        --csv Fidelity_History_for_Account_YYYYY.csv \\
        --retirement app/data/retirement.json \\
        --account "HSA"

The script edits retirement.json in-place. Run with --dry-run to preview changes.
"""

import argparse
import csv
import io
import json
from collections import defaultdict
from datetime import datetime


def parse_args():
    p = argparse.ArgumentParser(description="Import Fidelity 401k contributions into retirement.json")
    p.add_argument("--csv", required=True, metavar="FILE", help="Fidelity account history CSV export")
    p.add_argument("--retirement", required=True, metavar="FILE", help="Path to retirement.json")
    p.add_argument("--account", required=True, metavar="NAME", help="Account name in retirement.json (e.g. '401k')")
    p.add_argument("--dry-run", action="store_true", help="Print what would change without writing")
    return p.parse_args()


def iso_date(s):
    return datetime.strptime(s.strip(), "%m/%d/%Y").strftime("%Y-%m-%d")


def extract_data_lines(raw):
    """Strip leading blank lines and trailing footer, returning only data lines."""
    data_lines = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith('"') and not stripped[:1].isdigit():
            first_field = next(csv.reader([stripped]))[0]
            if first_field.lower() in ("date", "run date"):
                data_lines.append(line)
                continue
            else:
                break  # footer reached
        data_lines.append(line)
    return data_lines


def load_contributions_from_csv(path):
    """Return {iso_date: total_amount} for all contribution rows in the CSV.

    Auto-detects format from the header row:
      - "Date" + "Transaction Type" columns → 401k/workplace format
      - "Run Date" + "Action" columns → brokerage/HSA format
    """
    totals = defaultdict(float)

    with open(path, newline="", encoding="utf-8-sig") as f:
        raw = f.read()

    data_lines = extract_data_lines(raw)
    if not data_lines:
        return totals

    reader = csv.DictReader(io.StringIO("\n".join(data_lines)))
    headers = [h.strip() for h in (reader.fieldnames or [])]

    if "Transaction Type" in headers:
        # 401k / workplace account format
        for row in reader:
            if row.get("Transaction Type", "").strip() != "Contributions":
                continue
            date_str = row.get("Date", "").strip()
            amount_str = row.get("Amount ($)", "").strip()
            if not date_str or not amount_str:
                continue
            try:
                totals[iso_date(date_str)] += float(amount_str)
            except ValueError:
                continue

    elif "Action" in headers:
        # Brokerage / HSA format
        for row in reader:
            if "CONTR" not in row.get("Action", "").upper():
                continue
            date_str = row.get("Run Date", "").strip()
            amount_str = row.get("Amount ($)", "").strip()
            if not date_str or not amount_str:
                continue
            try:
                totals[iso_date(date_str)] += float(amount_str)
            except ValueError:
                continue

    else:
        raise ValueError(f"Unrecognized CSV format — headers: {headers}")

    return totals


def main():
    args = parse_args()

    totals = load_contributions_from_csv(args.csv)
    if not totals:
        print("No Contributions rows found in CSV.")
        return

    with open(args.retirement, encoding="utf-8") as f:
        data = json.load(f)

    contributions = data.setdefault("contributions", [])

    # Build an index keyed by (date, account) → list index for fast lookup
    index = {(c["date"], c["account"]): i for i, c in enumerate(contributions)}

    added = 0
    updated = 0
    for date in sorted(totals):
        amount = str(round(totals[date], 2))
        key = (date, args.account)
        if key in index:
            existing = contributions[index[key]]
            if existing["amount"] != amount:
                if args.dry_run:
                    print(f"UPDATE {date}: {existing['amount']} → {amount}")
                else:
                    existing["amount"] = amount
                updated += 1
        else:
            entry = {"date": date, "account": args.account, "amount": amount}
            if args.dry_run:
                print(f"ADD    {date}: {amount}")
            else:
                contributions.append(entry)
                index[key] = len(contributions) - 1
            added += 1

    if args.dry_run:
        print(f"\n(dry run) Would add {added}, update {updated} contribution record(s).")
        return

    # Sort contributions by date then account for clean output
    data["contributions"].sort(key=lambda c: (c["date"], c["account"]))

    with open(args.retirement, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print(f"Done. Added {added}, updated {updated} contribution record(s) for account '{args.account}'.")


if __name__ == "__main__":
    main()
