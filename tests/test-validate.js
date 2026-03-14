const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateData } = require("../app/js/validate.js");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeGains(warnings = []) {
  return {
    realized: warnings.map((msg) => (msg ? { warning: msg } : {})),
    donated: [],
    unrealized: [],
    summary: { stRealizedThisYear: 0, ltRealizedThisYear: 0, stUnrealized: 0, ltUnrealized: 0 },
  };
}

function makeMarket(tickers = []) {
  if (tickers.length === 0) return [];
  const row = { timestamp: "2024-01-02 16:00" };
  for (const t of tickers) row[t] = "100";
  return [row];
}

function makeRetirement(accounts = []) {
  return { accounts, values: [], contributions: [] };
}

// ---------------------------------------------------------------------------
// validateData — gains warnings
// ---------------------------------------------------------------------------

describe("validateData — gains warnings", () => {
  it("returns empty array when there are no warnings", () => {
    const result = validateData([], makeGains([null, null]), null, []);
    assert.deepEqual(result, []);
  });

  it("returns a warning item when one trade has a cost-basis gap", () => {
    const result = validateData([], makeGains(["Insufficient shares"]), null, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].level, "warning");
    assert.match(result[0].text, /1 trade\b/);
    assert.match(result[0].text, /Gains tab/);
  });

  it("uses plural 'trades' when multiple warnings exist", () => {
    const result = validateData(
      [],
      makeGains(["Insufficient shares", "No lot found"]),
      null,
      [],
    );
    assert.equal(result.length, 1);
    assert.match(result[0].text, /2 trades\b/);
  });

  it("counts only entries that have a truthy warning field", () => {
    // mix of warned and clean entries
    const result = validateData(
      [],
      makeGains([null, "Insufficient shares", null, "No lot found", null]),
      null,
      [],
    );
    assert.equal(result.length, 1);
    assert.match(result[0].text, /2 trades\b/);
  });

  it("returns empty array when gainsData is null", () => {
    assert.deepEqual(validateData([], null, null, []), []);
  });

  it("returns empty array when gainsData.realized is absent", () => {
    assert.deepEqual(validateData([], { donated: [], unrealized: [] }, null, []), []);
  });
});

// ---------------------------------------------------------------------------
// validateData — retirement proxy coverage
// ---------------------------------------------------------------------------

describe("validateData — retirement proxy coverage", () => {
  it("returns empty array when proxy ticker is present in market data", () => {
    const retirement = makeRetirement([{ name: "401k", proxy: "VTI" }]);
    const result = validateData([], makeGains([]), retirement, makeMarket(["VTI", "BND"]));
    assert.deepEqual(result, []);
  });

  it("returns a warning when proxy ticker is absent from market data", () => {
    const retirement = makeRetirement([{ name: "401k", proxy: "MISSING" }]);
    const result = validateData([], makeGains([]), retirement, makeMarket(["VTI", "BND"]));
    assert.equal(result.length, 1);
    assert.equal(result[0].level, "warning");
    assert.match(result[0].text, /401k/);
    assert.match(result[0].text, /MISSING/);
    assert.match(result[0].text, /no market data/);
  });

  it("defaults proxy to VTI when proxy field is absent", () => {
    const retirement = makeRetirement([{ name: "HSA" }]); // no proxy field
    // VTI present → no warning
    assert.deepEqual(
      validateData([], makeGains([]), retirement, makeMarket(["VTI"])),
      [],
    );
    // VTI absent → warning mentioning VTI
    const result = validateData([], makeGains([]), retirement, makeMarket(["BND"]));
    assert.equal(result.length, 1);
    assert.match(result[0].text, /VTI/);
  });

  it("emits one warning per account with a missing proxy", () => {
    const retirement = makeRetirement([
      { name: "401k", proxy: "VTI" },
      { name: "HSA", proxy: "GONE1" },
      { name: "IRA", proxy: "GONE2" },
    ]);
    const result = validateData([], makeGains([]), retirement, makeMarket(["VTI"]));
    assert.equal(result.length, 2);
    assert.match(result[0].text, /HSA/);
    assert.match(result[1].text, /IRA/);
  });

  it("returns empty array when market data is empty", () => {
    const retirement = makeRetirement([{ name: "401k", proxy: "VTI" }]);
    assert.deepEqual(validateData([], makeGains([]), retirement, []), []);
  });

  it("returns empty array when retirement is null", () => {
    assert.deepEqual(validateData([], makeGains([]), null, makeMarket(["VTI"])), []);
  });

  it("returns empty array when retirement has no accounts array", () => {
    assert.deepEqual(
      validateData([], makeGains([]), { values: [] }, makeMarket(["VTI"])),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// validateData — combined
// ---------------------------------------------------------------------------

describe("validateData — combined warnings", () => {
  it("returns both gains and proxy warnings together", () => {
    const retirement = makeRetirement([{ name: "401k", proxy: "MISSING" }]);
    const result = validateData(
      [],
      makeGains(["Insufficient shares"]),
      retirement,
      makeMarket(["VTI"]),
    );
    assert.equal(result.length, 2);
    assert.match(result[0].text, /trade/);
    assert.match(result[1].text, /MISSING/);
  });
});

// ---------------------------------------------------------------------------
// validateData — config: unknown allocation symbols
// ---------------------------------------------------------------------------

describe("validateData — config: unknown allocation symbols", () => {
  const market = makeMarket(["VTI", "BND"]);
  const trades = [{ date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" }];

  it("returns no warning when all allocation symbols are in market data", () => {
    const config = { exposureMap: { VTI: { Domestic: 1.0 }, BND: { Bonds: 1.0 } } };
    assert.deepEqual(validateData(trades, makeGains([]), null, market, config), []);
  });

  it("warns when an allocation symbol is not in market, trades, or retirement", () => {
    const config = { exposureMap: { TYPO: { Domestic: 1.0 } } };
    const result = validateData([], makeGains([]), null, market, config);
    assert.equal(result.length, 1);
    assert.match(result[0].text, /TYPO/);
    assert.match(result[0].text, /not found/);
  });

  it("accepts a symbol that appears only in trades (not market data)", () => {
    const config = { exposureMap: { VTI: { Domestic: 1.0 } } };
    // VTI is in trades but not in market
    const result = validateData(
      [{ symbol: "VTI" }],
      makeGains([]),
      null,
      makeMarket([]),
      config,
    );
    assert.deepEqual(result, []);
  });

  it("accepts a symbol that is a retirement account name", () => {
    const retirement = makeRetirement([{ name: "401k", proxy: "VTI" }]);
    const config = { exposureMap: { "401k": { Retirement: 1.0 } } };
    const result = validateData([], makeGains([]), retirement, makeMarket(["VTI"]), config);
    assert.deepEqual(result, []);
  });

  it("emits one warning per unknown symbol", () => {
    const config = { exposureMap: { GHOST1: { A: 1.0 }, VTI: { B: 1.0 }, GHOST2: { C: 1.0 } } };
    const result = validateData([], makeGains([]), null, market, config);
    assert.equal(result.length, 2);
    assert.match(result[0].text, /GHOST1/);
    assert.match(result[1].text, /GHOST2/);
  });

  it("returns no warnings when exposureMap is empty", () => {
    const config = { exposureMap: {} };
    assert.deepEqual(validateData([], makeGains([]), null, market, config), []);
  });

  it("returns no warnings when config is omitted", () => {
    assert.deepEqual(validateData([], makeGains([]), null, market), []);
  });
});

// ---------------------------------------------------------------------------
// validateData — config: allocation fractions sum
// ---------------------------------------------------------------------------

describe("validateData — config: allocation fractions sum", () => {
  const market = makeMarket(["VTI"]);

  it("returns no warning when fractions sum to exactly 1.0", () => {
    const config = { exposureMap: { VTI: { Domestic: 0.6, International: 0.4 } } };
    assert.deepEqual(validateData([], makeGains([]), null, market, config), []);
  });

  it("returns no warning when fractions sum within 0.01 tolerance", () => {
    // floating-point: 0.1 + 0.2 + 0.7 = 0.9999999... in JS
    const config = { exposureMap: { VTI: { A: 0.1, B: 0.2, C: 0.7 } } };
    assert.deepEqual(validateData([], makeGains([]), null, market, config), []);
  });

  it("warns when fractions sum to less than 1 beyond tolerance", () => {
    const config = { exposureMap: { VTI: { Domestic: 0.6 } } };
    const result = validateData([], makeGains([]), null, market, config);
    assert.equal(result.length, 1);
    assert.match(result[0].text, /VTI/);
    assert.match(result[0].text, /0\.6000/);
    assert.match(result[0].text, /expected 1\.0/);
  });

  it("warns when fractions sum to more than 1 beyond tolerance", () => {
    const config = { exposureMap: { VTI: { Domestic: 0.7, International: 0.5 } } };
    const result = validateData([], makeGains([]), null, market, config);
    assert.equal(result.length, 1);
    assert.match(result[0].text, /1\.2000/);
  });

  it("warns when a fraction is NaN (non-numeric config value)", () => {
    const config = { exposureMap: { VTI: { Domestic: NaN } } };
    const result = validateData([], makeGains([]), null, market, config);
    assert.equal(result.length, 1);
    assert.match(result[0].text, /invalid/);
  });
});

// ---------------------------------------------------------------------------
// validateData — config: symbolOrder unknown entries
// ---------------------------------------------------------------------------

describe("validateData — config: symbolOrder unknown entries", () => {
  const market = makeMarket(["VTI", "BND"]);

  it("returns no warning when all symbolOrder entries are known", () => {
    const config = { symbolOrder: ["VTI", "BND"] };
    assert.deepEqual(validateData([], makeGains([]), null, market, config), []);
  });

  it("warns when a symbolOrder entry is not in any data source", () => {
    const config = { symbolOrder: ["VTI", "OLD_TICKER"] };
    const result = validateData([], makeGains([]), null, market, config);
    assert.equal(result.length, 1);
    assert.match(result[0].text, /OLD_TICKER/);
    assert.match(result[0].text, /not found/);
  });

  it("accepts a symbolOrder entry that matches a retirement account name", () => {
    const retirement = makeRetirement([{ name: "401k", proxy: "VTI" }]);
    const config = { symbolOrder: ["401k"] };
    const result = validateData([], makeGains([]), retirement, makeMarket(["VTI"]), config);
    assert.deepEqual(result, []);
  });

  it("accepts a symbolOrder entry that matches an asset name", () => {
    const config = {
      symbolOrder: ["Home Equity", "I-Bond"],
      assets: [{ name: "Home Equity" }, { name: "I-Bond" }],
    };
    assert.deepEqual(validateData([], makeGains([]), null, makeMarket(["VTI"]), config), []);
  });

  it("accepts a symbolOrder entry that appears only in trades", () => {
    const config = { symbolOrder: ["VTI"] };
    const result = validateData(
      [{ symbol: "VTI" }],
      makeGains([]),
      null,
      makeMarket([]),
      config,
    );
    assert.deepEqual(result, []);
  });

  it("emits one warning per unknown symbolOrder entry", () => {
    const config = { symbolOrder: ["GONE1", "VTI", "GONE2"] };
    const result = validateData([], makeGains([]), null, market, config);
    assert.equal(result.length, 2);
    assert.match(result[0].text, /GONE1/);
    assert.match(result[1].text, /GONE2/);
  });

  it("returns no warnings for an empty symbolOrder array", () => {
    const config = { symbolOrder: [] };
    assert.deepEqual(validateData([], makeGains([]), null, market, config), []);
  });
});
