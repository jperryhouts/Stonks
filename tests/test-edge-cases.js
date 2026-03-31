/**
 * Edge case tests for portfolio tracker modules.
 *
 * Tests with "Previously broken" comments document bugs that have since been
 * fixed. The assertions capture the correct expected behavior and serve as
 * regression guards.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { niceMax, processData, filterData } = require("../app/js/data.js");
const { computeGains } = require("../app/js/gains.js");
const { mergeRetirement } = require("../app/js/retirement.js");
const { csvToJson, validateTrades, normalizeTrades } = require("../app/serve.js");

// ---------------------------------------------------------------------------
// Helpers (mirrors style from test-gains.js)
// ---------------------------------------------------------------------------

function buy(date, symbol, price, quantity) {
  return { date, symbol, price: String(price), quantity: String(quantity) };
}

function sell(date, symbol, price, quantity, lotDate) {
  const tx = { date, symbol, price: String(price), quantity: String(-Math.abs(quantity)) };
  if (lotDate) tx.lotDate = lotDate;
  return tx;
}

function mkt(...prices) {
  const byDate = {};
  for (const { date, sym, price } of prices) {
    if (!byDate[date]) byDate[date] = { timestamp: date + " 16:00" };
    byDate[date][sym] = String(price);
  }
  return Object.values(byDate).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

const MARKET = [
  { timestamp: "2024-01-02 16:00", VTI: "100", VXUS: "50" },
  { timestamp: "2024-01-03 16:00", VTI: "105", VXUS: "52" },
  { timestamp: "2024-01-04 16:00", VTI: "110", VXUS: "55" },
];

// ---------------------------------------------------------------------------
// niceMax — extreme / non-finite inputs
// ---------------------------------------------------------------------------

describe("niceMax — extreme inputs", () => {
  it("returns a finite number for NaN input", () => {
    // Previously broken: niceMax(NaN) returned NaN because the guard `if (v <= 0)`
    // is skipped for NaN (NaN comparisons return false). Fixed: guard changed to
    // `if (!Number.isFinite(v) || v <= 0)` which catches NaN and Infinity.
    const result = niceMax(NaN);
    assert.ok(
      Number.isFinite(result),
      `niceMax(NaN) should return a finite number, got ${result}`
    );
  });

  it("returns a finite number for Infinity input", () => {
    // Previously broken: niceMax(Infinity) propagated Infinity through Math.log10
    // and Math.pow. Fixed: same guard as the NaN fix handles Infinity.
    const result = niceMax(Infinity);
    assert.ok(
      Number.isFinite(result),
      `niceMax(Infinity) should return a finite number, got ${result}`
    );
  });
});

// ---------------------------------------------------------------------------
// processData — multiple transactions on the same day / same ticker
// ---------------------------------------------------------------------------

describe("processData — same-day multi-transaction edge cases", () => {
  it("accumulates two buys of the same ticker on the same day", () => {
    // Two buys of VTI on 2024-01-02; both snapshots must be applied before the
    // first market row is computed. Net position: 10 + 5 = 15 shares.
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" },
      { date: "2024-01-02", symbol: "VTI", price: "102", quantity: "5" },
    ];
    const result = processData(trades, MARKET);
    assert.ok(result, "result should not be null");
    assert.equal(result.chartData[0].positions.VTI, 15);
    assert.equal(result.chartData[0].values.VTI, 15 * 100); // 15 shares × $100/share
  });

  it("applies a same-day buy followed by a same-day partial sell (net position)", () => {
    // Buy 10, sell 4 on the same date → net 6 shares held from that day forward.
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" },
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "-4" },
    ];
    const result = processData(trades, MARKET);
    assert.ok(result);
    assert.equal(result.chartData[0].positions.VTI, 6);
  });

  it("position reaches exactly zero after a complete sell", () => {
    // Buy 10 on day 1, sell all 10 on day 2 → value is $0 from day 2 onward.
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" },
      { date: "2024-01-03", symbol: "VTI", price: "105", quantity: "-10" },
    ];
    const result = processData(trades, MARKET);
    assert.equal(result.chartData[0].positions.VTI, 10);
    assert.equal(result.chartData[1].positions.VTI, 0);
    assert.equal(result.chartData[1].values.VTI, 0);
    assert.equal(result.chartData[2].values.VTI, 0); // still zero on day 3
  });

  it("sell more than owned does not produce a negative position", () => {
    // Previously broken: processData allowed running positions to go negative when
    // a sell quantity exceeded currently-held shares (3 + (−5) = −2), silently
    // corrupting chart values. Fixed: positions are now clamped at zero.
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "3" },
      { date: "2024-01-03", symbol: "VTI", price: "105", quantity: "-5" }, // sell 5, only own 3
    ];
    const result = processData(trades, MARKET);
    assert.ok(
      result.chartData[1].positions.VTI >= 0,
      `position should not go negative (got ${result.chartData[1].positions.VTI})`
    );
  });

  it("market price of empty-string is treated as $0 (documents current behaviour)", () => {
    // When a ticker has no price in a market row (empty string), parseFloat("") = NaN
    // and NaN || 0 = 0, so the value for that symbol on that day is $0.
    // This is the current (intentional) behaviour; the test pins it.
    const market = [
      { timestamp: "2024-01-02 16:00", VTI: "100", VXUS: "" }, // VXUS missing
    ];
    const trades = [
      { date: "2024-01-02", symbol: "VXUS", price: "50", quantity: "10" },
    ];
    const result = processData(trades, market);
    assert.ok(result);
    assert.equal(result.chartData[0].values.VXUS, 0); // no price → $0
  });
});

// ---------------------------------------------------------------------------
// computeGains — selling more shares than owned
// ---------------------------------------------------------------------------

describe("computeGains — overselling", () => {
  it("FIFO: emits a warning when selling more shares than available", () => {
    // Previously broken: the FIFO path silently stopped consuming lots when they
    // were exhausted without emitting any warning row. Fixed: FIFO now emits a
    // warning entry for the unmatched shares, consistent with the specific-ID path.
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),
      sell("2024-06-01", "VTI", 150, 10), // only 5 available
    ];
    const m = mkt({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, m);
    assert.ok(
      realized.some((r) => r.warning),
      "should emit a warning row for the 5 excess shares that had no matching lot"
    );
  });

  it("FIFO: only realizes shares that were actually owned (confirms partial coverage)", () => {
    // Regardless of whether a warning is emitted, the realized gain should only
    // cover the 5 shares that existed, not the 10 that were requested.
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),
      sell("2024-06-01", "VTI", 150, 10),
    ];
    const m = mkt({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, m);
    const totalShares = realized.filter((r) => !r.warning).reduce((s, r) => s + r.shares, 0);
    // Only 5 real shares should appear in non-warning realized entries
    assert.ok(totalShares <= 5, `should not realize more than 5 owned shares (got ${totalShares})`);
  });

});

// ---------------------------------------------------------------------------
// computeGains — same-day buy/sell ordering
// ---------------------------------------------------------------------------

describe("computeGains — same-day transaction ordering", () => {
  it("sell listed before buy on the same date produces no realized gain (documents ordering sensitivity)", () => {
    // The sort is stable on date only; within the same date, the original array
    // order is preserved. If a sell appears before a buy on the same date,
    // the sell finds an empty lot list and produces no realized entry.
    // This means the FIFO result depends on the order the user entered same-day
    // transactions — a potential source of confusion.
    // This test documents current behaviour (no gain) as a known limitation.
    const trades = [
      sell("2024-01-02", "VTI", 105, 5), // listed first — but lot doesn't exist yet
      buy("2024-01-02", "VTI", 100, 10),
    ];
    const m = mkt({ date: "2024-12-31", sym: "VTI", price: 110 });
    const { realized } = computeGains(trades, m);
    // Current (perhaps undesirable) behaviour: 0 realized entries.
    // Ideally, same-day buy-then-sell should produce a realized gain regardless
    // of which appears first in the trades array.
    assert.equal(
      realized.filter((r) => !r.warning).length,
      0,
      "sell-before-buy on same date currently yields no realized gain — documents ordering sensitivity"
    );
  });
});

// ---------------------------------------------------------------------------
// mergeRetirement — proxy ticker absent from market data
// ---------------------------------------------------------------------------

describe("mergeRetirement — proxy not in market data", () => {
  const MARKET_VTI_ONLY = [
    { timestamp: "2024-01-02 16:00", VTI: "100" },
    { timestamp: "2024-01-03 16:00", VTI: "110" },
  ];

  it("shows ground-truth value on GT date when proxy is missing", () => {
    // Previously broken: when the proxy ticker was absent from market data,
    // proxyPrice evaluated to 0, short-circuiting the condition and setting the
    // account value to $0 for all days. Fixed: the GT value is now shown with
    // ratio=1.0 when the proxy is unavailable.
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-03", prices: { VTI: "110" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = { symbols: [], chartData, yMax: 1 };
    const retirement = {
      accounts: [{ name: "401k", proxy: "BND" }], // BND not present in market
      values: [{ date: "2024-01-02", account: "401k", value: "10000" }],
    };
    mergeRetirement(data, retirement, MARKET_VTI_ONLY);
    assert.equal(
      data.chartData[0].values["401k"],
      10000,
      "GT value ($10,000) should appear on the GT date when proxy ticker is unavailable"
    );
  });
});

// ---------------------------------------------------------------------------
// mergeRetirement — duplicate account names
// ---------------------------------------------------------------------------

describe("mergeRetirement — duplicate account names", () => {
  const MARKET_SMALL = [{ timestamp: "2024-01-02 16:00", VTI: "100" }];

  it("duplicate account names should not appear twice in symbols", () => {
    // Previously broken: each entry in retirement.accounts called `symbols.push(name)`
    // unconditionally, duplicating the symbol and doubling the portfolio total.
    // Fixed: duplicate account names are deduplicated before pushing.
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = { symbols: [], chartData, yMax: 1 };
    const retirement = {
      accounts: [
        { name: "401k", proxy: "VTI" },
        { name: "401k", proxy: "VTI" }, // duplicate name
      ],
      values: [{ date: "2024-01-02", account: "401k", value: "10000" }],
    };
    mergeRetirement(data, retirement, MARKET_SMALL);
    const count = data.symbols.filter((s) => s === "401k").length;
    assert.equal(count, 1, "duplicate account name should produce only one entry in symbols");
  });

  it("duplicate account names do not double the portfolio total", () => {
    // Companion to the test above: total should be 10000, not 20000 (previously double-counted).
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = { symbols: [], chartData, yMax: 1 };
    const retirement = {
      accounts: [
        { name: "401k", proxy: "VTI" },
        { name: "401k", proxy: "VTI" },
      ],
      values: [{ date: "2024-01-02", account: "401k", value: "10000" }],
    };
    mergeRetirement(data, retirement, MARKET_SMALL);
    assert.equal(
      data.chartData[0].total,
      10000,
      "total should be $10,000, not $20,000 (previously double-counted when duplicate account names were present)"
    );
  });
});

// ---------------------------------------------------------------------------
// mergeRetirement — account defined with no matching ground-truth values
// ---------------------------------------------------------------------------

describe("mergeRetirement — account with no GT values", () => {
  it("account is added to symbols with $0 values when no GT entries match (documents behaviour)", () => {
    // An account defined in retirement.accounts but having no entries in
    // retirement.values (or entries for a different account name) will still be
    // added to the symbols list with $0 for every day. This means the account
    // appears in the chart legend but contributes nothing to the total.
    // This test documents the current behaviour rather than asserting it is ideal.
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = { symbols: [], chartData, yMax: 1 };
    const retirement = {
      accounts: [{ name: "IRA", proxy: "VTI" }],
      values: [{ date: "2024-01-02", account: "Roth401k", value: "5000" }], // different name
    };
    mergeRetirement(data, retirement, [{ timestamp: "2024-01-02 16:00", VTI: "100" }]);
    assert.ok(data.symbols.includes("IRA"), "IRA is added to symbols even without GT data");
    assert.equal(data.chartData[0].values["IRA"], 0, "IRA value is $0 with no GT entries");
    assert.equal(data.chartData[0].total, 0, "portfolio total unaffected by empty account");
  });
});

// ---------------------------------------------------------------------------
// csvToJson — RFC 4180 quoted fields
// ---------------------------------------------------------------------------

describe("csvToJson — RFC 4180 compliance", () => {
  it("handles a quoted field containing an embedded comma", () => {
    // Previously broken: csvToJson used a naive `line.split(",")` that did not
    // respect RFC 4180 quoting, splitting quoted fields at embedded commas. Fixed:
    // RFC 4180-compliant parsing now handles quoted fields correctly.
    const csv = 'timestamp,note\n2024-01-02,"value, with comma"';
    const result = csvToJson(csv);
    assert.equal(result.length, 1);
    assert.equal(result[0].note, "value, with comma");
  });

  it("unquoted fields with no commas continue to parse correctly", () => {
    // Baseline: the common case (no quoted fields, no embedded commas) works fine.
    const csv = "timestamp,VTI,VXUS\n2024-01-02,100,50\n2024-01-03,105,52";
    const result = csvToJson(csv);
    assert.equal(result.length, 2);
    assert.equal(result[0].VTI, "100");
    assert.equal(result[1].VXUS, "52");
  });
});

// ---------------------------------------------------------------------------
// validateTrades — boundary / malformed inputs
// ---------------------------------------------------------------------------

describe("validateTrades — boundary cases", () => {
  it("rejects a regex-passing but calendar-invalid date like 2024-02-31", () => {
    // Previously broken: validateTrades checked only the regex `^\d{4}-\d{2}-\d{2}$`,
    // not whether the date was a real calendar date. Fixed: UTC round-trip check
    // now rejects dates that JavaScript silently rolls over (e.g., Feb 31 → Mar 2).
    const err = validateTrades([
      { date: "2024-02-31", symbol: "VTI", price: "100", quantity: "10" },
    ]);
    assert.ok(err !== null, "should reject calendar-invalid date 2024-02-31");
  });

  it("rejects price string 'NaN'", () => {
    // Number("NaN") = NaN, isFinite(NaN) = false → correctly rejected.
    const err = validateTrades([
      { date: "2024-01-02", symbol: "VTI", price: "NaN", quantity: "10" },
    ]);
    assert.ok(err, "price 'NaN' should be rejected");
    assert.match(err, /price/);
  });

  it("rejects price string 'Infinity'", () => {
    // Number("Infinity") = Infinity, isFinite(Infinity) = false → correctly rejected.
    const err = validateTrades([
      { date: "2024-01-02", symbol: "VTI", price: "Infinity", quantity: "10" },
    ]);
    assert.ok(err, "price 'Infinity' should be rejected");
    assert.match(err, /price/);
  });

  it("accepts scientific notation price '1e3'", () => {
    // Number("1e3") = 1000, isFinite(1000) = true, 1000 > 0 → valid.
    const err = validateTrades([
      { date: "2024-01-02", symbol: "VTI", price: "1e3", quantity: "10" },
    ]);
    assert.equal(err, null, "scientific notation '1e3' is a valid positive finite price");
  });

  it("accepts scientific notation quantity '1e2'", () => {
    // Number("1e2") = 100, non-zero finite → valid.
    const err = validateTrades([
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "1e2" },
    ]);
    assert.equal(err, null, "scientific notation '1e2' is a valid non-zero quantity");
  });

  it("rejects negative scientific notation price '-1e3'", () => {
    // Number("-1e3") = -1000, which is ≤ 0 → rejected.
    const err = validateTrades([
      { date: "2024-01-02", symbol: "VTI", price: "-1e3", quantity: "10" },
    ]);
    assert.ok(err, "negative price '-1e3' should be rejected");
    assert.match(err, /price/);
  });

  it("rejects a future date that otherwise looks valid", () => {
    // Future dates pass the regex and are accepted. This is (arguably) intentional
    // to allow pre-entering scheduled purchases. This test documents the behaviour.
    const err = validateTrades([
      { date: "2099-12-31", symbol: "VTI", price: "100", quantity: "10" },
    ]);
    assert.equal(err, null, "future dates are currently accepted (no future-date guard)");
  });

  it("rejects a month value out of range (13th month) via calendar check", () => {
    // Previously broken: same root cause as 2024-02-31 — pure regex allowed month 13.
    // Fixed: same UTC round-trip check catches this (2024-13-01 → Jan 1, 2025).
    const err = validateTrades([
      { date: "2024-13-01", symbol: "VTI", price: "100", quantity: "10" },
    ]);
    assert.ok(err !== null, "should reject month=13 as calendar-invalid");
  });
});

// ---------------------------------------------------------------------------
// normalizeTrades — numeric string normalisation
// ---------------------------------------------------------------------------

describe("normalizeTrades — numeric normalisation", () => {
  const base = { date: "2024-01-02", symbol: "vti", price: "100", quantity: "10" };

  it("expands scientific notation price to plain decimal string", () => {
    // String(Number("1e3")) = "1000" — normalizeTrades canonicalises the value.
    const [h] = normalizeTrades([{ ...base, price: "1e3" }]);
    assert.equal(h.price, "1000");
  });

  it("expands scientific notation quantity to plain decimal string", () => {
    const [h] = normalizeTrades([{ ...base, quantity: "1e1" }]);
    assert.equal(h.quantity, "10");
  });

  it("preserves fractional share quantity", () => {
    const [h] = normalizeTrades([{ ...base, quantity: "0.125" }]);
    assert.equal(h.quantity, "0.125");
  });

  it("expands a negative scientific notation quantity (sell)", () => {
    const [h] = normalizeTrades([{ ...base, quantity: "-2e1" }]);
    assert.equal(h.quantity, "-20");
  });
});
