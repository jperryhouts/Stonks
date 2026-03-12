const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeMortgageEquity, computeIBondValue, computeMarginLoan, mergeAssets } = require("../app/js/assets.js");

// ---------------------------------------------------------------------------
// computeMortgageEquity
// ---------------------------------------------------------------------------

describe("computeMortgageEquity", () => {
  const BASE = {
    purchaseDate: "2020-01-01",
    homeValue: "500000",
    downPayment: "100000",     // $100k down, $400k loan
    loanTermYears: "30",
    annualRate: "0.04",        // 4% annual = 0.333%/month
  };

  it("returns 0 before purchase date", () => {
    const val = computeMortgageEquity(BASE, "2019-12-31");
    assert.equal(val, 0);
  });

  it("returns down payment on purchase date (0 months elapsed)", () => {
    const val = computeMortgageEquity(BASE, "2020-01-01");
    assert.equal(val, 100000);
  });

  it("equity grows over time (more equity after 5 years than at purchase)", () => {
    const at5y = computeMortgageEquity(BASE, "2025-01-01");
    assert.ok(at5y > 100000, `Expected equity > 100000, got ${at5y}`);
  });

  it("equity approaches home value as loan is paid off", () => {
    const at30y = computeMortgageEquity(BASE, "2050-02-01"); // well past payoff
    assert.ok(at30y >= 499000, `Expected ~$500k equity at payoff, got ${at30y}`);
  });

  it("handles zero-down-payment loan (loanAmount = homeValue)", () => {
    const noDown = { ...BASE, downPayment: "0" };
    const val = computeMortgageEquity(noDown, "2025-01-01");
    assert.ok(val > 0);
    assert.ok(val < 500000);
  });

  it("handles zero interest rate with linear amortization", () => {
    const zeroRate = { ...BASE, annualRate: "0" };
    // At 15 years (halfway) with 0% rate, ~50% of loan repaid
    const at15y = computeMortgageEquity(zeroRate, "2035-01-01");
    // equity = downPayment + half of loanAmount ≈ 100000 + 200000 = 300000
    assert.ok(at15y > 250000 && at15y < 350000, `Expected ~300k, got ${at15y}`);
  });

  it("extra payments reduce balance faster", () => {
    const withExtra = {
      ...BASE,
      extraPayments: [{ date: "2020-06-01", amount: "10000" }],
    };
    const normalAt1y = computeMortgageEquity(BASE, "2021-01-01");
    const extraAt1y = computeMortgageEquity(withExtra, "2021-01-01");
    assert.ok(extraAt1y > normalAt1y, "Extra payment should result in more equity");
  });
});

// ---------------------------------------------------------------------------
// computeIBondValue — real-world I-bond values from Treasury / eyebonds.info
// ---------------------------------------------------------------------------

describe("computeIBondValue", () => {
  // October 2022 I-Bond, $10,000, fixed rate 0.00%
  // Rates from TreasuryDirect; values verified against eyebonds.info/ibonds/10000/ib_2022_10.html
  const OCT_2022 = {
    purchaseDate: "2022-10-01",
    purchaseValue: "10000",
    fixedRate: "0",
    rates: [
      { setDate: "2022-10-01", semiannualInflation: "0.0481" }, // May 2022 announcement
      { setDate: "2023-04-01", semiannualInflation: "0.0324" }, // Nov 2022
      { setDate: "2023-10-01", semiannualInflation: "0.0169" }, // May 2023
      { setDate: "2024-04-01", semiannualInflation: "0.0197" }, // Nov 2023
      { setDate: "2024-10-01", semiannualInflation: "0.0148" }, // May 2024
      { setDate: "2025-04-01", semiannualInflation: "0.0095" }, // Nov 2024
      { setDate: "2025-10-01", semiannualInflation: "0.0143" }, // May 2025
    ],
  };

  // November 2021 I-Bond, $10,000, fixed rate 0.00%
  // Values verified against eyebonds.info/ibonds/10000/ib_2021_11.html
  const NOV_2021 = {
    purchaseDate: "2021-11-01",
    purchaseValue: "10000",
    fixedRate: "0",
    rates: [
      { setDate: "2021-11-01", semiannualInflation: "0.0356" }, // Nov 2021 announcement
      { setDate: "2022-05-01", semiannualInflation: "0.0481" }, // May 2022
      { setDate: "2022-11-01", semiannualInflation: "0.0324" }, // Nov 2022
      { setDate: "2023-05-01", semiannualInflation: "0.0169" }, // May 2023
      { setDate: "2023-11-01", semiannualInflation: "0.0197" }, // Nov 2023
      { setDate: "2024-05-01", semiannualInflation: "0.0148" }, // May 2024
      { setDate: "2024-11-01", semiannualInflation: "0.0095" }, // Nov 2024
      { setDate: "2025-05-01", semiannualInflation: "0.0143" }, // May 2025
    ],
  };

  it("returns 0 before purchase date", () => {
    assert.equal(computeIBondValue(OCT_2022, "2022-09-30"), 0);
  });

  it("returns purchase value on purchase date", () => {
    assert.equal(computeIBondValue(OCT_2022, "2022-10-01"), 10000);
  });

  // -- Oct 2022 bond: monthly values within period 1 --

  it("Oct 2022 bond — 1 month (Nov 2022): $10,080", () => {
    assert.equal(computeIBondValue(OCT_2022, "2022-11-01"), 10080);
  });

  it("Oct 2022 bond — 2 months (Dec 2022): $10,156", () => {
    assert.equal(computeIBondValue(OCT_2022, "2022-12-01"), 10156);
  });

  it("Oct 2022 bond — 3 months (Jan 2023): $10,236", () => {
    assert.equal(computeIBondValue(OCT_2022, "2023-01-01"), 10236);
  });

  it("Oct 2022 bond — mid-month returns same value as 1st", () => {
    assert.equal(computeIBondValue(OCT_2022, "2022-12-15"), 10156);
  });

  // -- Oct 2022 bond: period boundaries --

  it("Oct 2022 bond — end of period 1 (Apr 2023): $10,480", () => {
    assert.equal(computeIBondValue(OCT_2022, "2023-04-01"), 10480);
  });

  it("Oct 2022 bond — 1 month into period 2 (May 2023): $10,536", () => {
    assert.equal(computeIBondValue(OCT_2022, "2023-05-01"), 10536);
  });

  it("Oct 2022 bond — end of period 2 (Oct 2023): $10,820", () => {
    assert.equal(computeIBondValue(OCT_2022, "2023-10-01"), 10820);
  });

  it("Oct 2022 bond — end of period 3 (Apr 2024): $11,004", () => {
    assert.equal(computeIBondValue(OCT_2022, "2024-04-01"), 11004);
  });

  it("Oct 2022 bond — end of period 4 (Oct 2024): $11,220", () => {
    assert.equal(computeIBondValue(OCT_2022, "2024-10-01"), 11220);
  });

  it("Oct 2022 bond — end of period 5 (Apr 2025): $11,388", () => {
    assert.equal(computeIBondValue(OCT_2022, "2025-04-01"), 11388);
  });

  it("Oct 2022 bond — end of period 6 (Oct 2025): $11,496", () => {
    assert.equal(computeIBondValue(OCT_2022, "2025-10-01"), 11496);
  });

  // -- Nov 2021 bond: monthly values within period 1 --

  it("Nov 2021 bond — purchase date: $10,000", () => {
    assert.equal(computeIBondValue(NOV_2021, "2021-11-01"), 10000);
  });

  it("Nov 2021 bond — 1 month (Dec 2021): $10,060", () => {
    assert.equal(computeIBondValue(NOV_2021, "2021-12-01"), 10060);
  });

  it("Nov 2021 bond — 2 months (Jan 2022): $10,116", () => {
    assert.equal(computeIBondValue(NOV_2021, "2022-01-01"), 10116);
  });

  it("Nov 2021 bond — 3 months (Feb 2022): $10,176", () => {
    assert.equal(computeIBondValue(NOV_2021, "2022-02-01"), 10176);
  });

  // -- Nov 2021 bond: period boundaries --

  it("Nov 2021 bond — end of period 1 (May 2022): $10,356", () => {
    assert.equal(computeIBondValue(NOV_2021, "2022-05-01"), 10356);
  });

  it("Nov 2021 bond — 1 month into period 2 (Jun 2022): $10,436", () => {
    assert.equal(computeIBondValue(NOV_2021, "2022-06-01"), 10436);
  });

  it("Nov 2021 bond — 3 months into period 2 (Aug 2022): $10,604", () => {
    assert.equal(computeIBondValue(NOV_2021, "2022-08-01"), 10604);
  });

  it("Nov 2021 bond — end of period 2 (Nov 2022): $10,856", () => {
    assert.equal(computeIBondValue(NOV_2021, "2022-11-01"), 10856);
  });

  it("Nov 2021 bond — end of period 3 (May 2023): $11,208", () => {
    assert.equal(computeIBondValue(NOV_2021, "2023-05-01"), 11208);
  });

  it("Nov 2021 bond — end of period 5 (Nov 2024): $11,792", () => {
    assert.equal(computeIBondValue(NOV_2021, "2024-11-01"), 11792);
  });

  it("Nov 2021 bond — end of period 7 (May 2025): $11,904", () => {
    assert.equal(computeIBondValue(NOV_2021, "2025-05-01"), 11904);
  });

  it("Nov 2021 bond — end of period 8 (Nov 2025): $12,076", () => {
    assert.equal(computeIBondValue(NOV_2021, "2025-11-01"), 12076);
  });

  // -- Composite rate floor: negative inflation cannot reduce bond value --

  it("floors composite rate at 0 when inflation is negative", () => {
    const bondNeg = {
      purchaseDate: "2022-01-01",
      purchaseValue: "10000",
      fixedRate: "0",
      rates: [{ setDate: "2022-01-01", semiannualInflation: "-0.02" }],
    };
    // Composite = 0 + 2*(-0.02) + 0 = -0.04, floored to 0 → no loss
    assert.equal(computeIBondValue(bondNeg, "2022-07-01"), 10000);
  });
});

// ---------------------------------------------------------------------------
// computeMarginLoan
// ---------------------------------------------------------------------------

describe("computeMarginLoan", () => {
  const LOAN = {
    type: "margin_loan",
    name: "Margin Loan",
    balances: [
      { date: "2025-06-01", amount: "50000" },
      { date: "2025-09-01", amount: "30000" },
    ],
  };

  it("returns 0 for date before first balance", () => {
    assert.equal(computeMarginLoan(LOAN, "2025-05-31"), 0);
  });

  it("returns -amount for date on a balance entry", () => {
    assert.equal(computeMarginLoan(LOAN, "2025-06-01"), -50000);
  });

  it("returns -amount of most recent entry for date between balances", () => {
    assert.equal(computeMarginLoan(LOAN, "2025-07-15"), -50000);
  });

  it("returns -lastAmount for date after last balance", () => {
    assert.equal(computeMarginLoan(LOAN, "2026-01-01"), -30000);
  });

  it("handles single balance entry", () => {
    const single = {
      type: "margin_loan",
      name: "Loan",
      balances: [{ date: "2025-03-01", amount: "10000" }],
    };
    assert.equal(computeMarginLoan(single, "2025-02-28"), 0);
    assert.equal(computeMarginLoan(single, "2025-03-01"), -10000);
    assert.equal(computeMarginLoan(single, "2025-12-01"), -10000);
  });

  it("handles unsorted balances (sorts by date internally)", () => {
    const unsorted = {
      type: "margin_loan",
      name: "Loan",
      balances: [
        { date: "2025-09-01", amount: "30000" },
        { date: "2025-06-01", amount: "50000" },
      ],
    };
    assert.equal(computeMarginLoan(unsorted, "2025-07-15"), -50000);
    assert.equal(computeMarginLoan(unsorted, "2025-10-01"), -30000);
  });
});

// ---------------------------------------------------------------------------
// mergeAssets
// ---------------------------------------------------------------------------

describe("mergeAssets", () => {
  const MARKET = [
    { timestamp: "2022-01-03 16:00", VTI: "200" },
    { timestamp: "2022-07-05 16:00", VTI: "210" },
    { timestamp: "2023-01-03 16:00", VTI: "220" },
  ];

  it("does nothing for empty assets array", () => {
    const data = { symbols: ["VTI"], chartData: [], yMax: 1 };
    mergeAssets(data, [], MARKET);
    assert.deepEqual(data.symbols, ["VTI"]);
  });

  it("adds ibond as a symbol", () => {
    const chartData = [
      { date: "2022-01-03", prices: { VTI: "200" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = { symbols: [], chartData, yMax: 1 };
    const ibond = {
      type: "ibond",
      name: "I-Bond",
      purchaseDate: "2022-01-01",
      purchaseValue: "10000",
      fixedRate: "0",
      rates: [{ setDate: "2022-01-01", semiannualInflation: "0.04" }],
    };
    mergeAssets(data, [ibond], MARKET);
    assert.ok(data.symbols.includes("I-Bond"));
  });

  it("adds mortgage as a symbol with positive equity", () => {
    const chartData = [
      { date: "2022-07-05", prices: {}, values: {}, cumulative: [], total: 0 },
    ];
    const data = { symbols: [], chartData, yMax: 1 };
    const mortgage = {
      type: "mortgage",
      name: "Home Equity",
      purchaseDate: "2020-01-01",
      homeValue: "500000",
      downPayment: "100000",
      loanTermYears: "30",
      annualRate: "0.04",
    };
    mergeAssets(data, [mortgage], MARKET);
    assert.ok(data.chartData[0].values["Home Equity"] > 100000);
  });

  it("builds skeleton chartData when none exists", () => {
    const data = { symbols: [], chartData: [], yMax: 1 };
    const ibond = {
      type: "ibond", name: "I-Bond",
      purchaseDate: "2022-01-01",
      purchaseValue: "1000", fixedRate: "0",
      rates: [{ setDate: "2022-01-01", semiannualInflation: "0.03" }],
    };
    mergeAssets(data, [ibond], MARKET);
    assert.ok(data.chartData.length > 0);
    assert.ok(data.chartData[0].date >= "2022-01-01");
  });

  it("margin_loan produces negative values and sets liabilitySymbols", () => {
    const chartData = [
      { date: "2025-07-01", prices: {}, values: { VTI: 10000 }, cumulative: [10000], total: 10000 },
    ];
    const data = { symbols: ["VTI"], chartData, yMax: 10000 };
    const loan = {
      type: "margin_loan",
      name: "Margin Loan",
      balances: [{ date: "2025-06-01", amount: "5000" }],
    };
    mergeAssets(data, [loan], MARKET);
    assert.equal(data.chartData[0].values["Margin Loan"], -5000);
    assert.deepEqual(data.liabilitySymbols, ["Margin Loan"]);
  });

  it("liabilitySymbols is empty when no margin loans", () => {
    const chartData = [
      { date: "2022-07-05", prices: {}, values: {}, cumulative: [], total: 0 },
    ];
    const data = { symbols: [], chartData, yMax: 1 };
    const mortgage = {
      type: "mortgage",
      name: "Home Equity",
      purchaseDate: "2020-01-01",
      homeValue: "500000",
      downPayment: "100000",
      loanTermYears: "30",
      annualRate: "0.04",
    };
    mergeAssets(data, [mortgage], MARKET);
    assert.ok(!data.liabilitySymbols || data.liabilitySymbols.length === 0);
  });

  it("rebuilds cumulative totals after adding assets", () => {
    const chartData = [
      { date: "2022-07-05", prices: {}, values: { VTI: 5000 }, cumulative: [5000], total: 5000 },
    ];
    const data = { symbols: ["VTI"], chartData, yMax: 1 };
    const mortgage = {
      type: "mortgage",
      name: "Home Equity",
      purchaseDate: "2020-01-01",
      homeValue: "500000",
      downPayment: "100000",
      loanTermYears: "30",
      annualRate: "0.04",
    };
    mergeAssets(data, [mortgage], MARKET);
    const equity = data.chartData[0].values["Home Equity"];
    assert.equal(data.chartData[0].total, 5000 + equity);
  });
});
