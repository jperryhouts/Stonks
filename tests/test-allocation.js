const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeRebalancing, computeContributions } = require("../app/js/allocation.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFullData(valuesBySymbol) {
  var symbols = Object.keys(valuesBySymbol);
  var values = Object.assign({}, valuesBySymbol);
  return {
    symbols: symbols,
    chartData: [{ date: "2026-01-01", values: values, cumulative: [] }],
  };
}

// ---------------------------------------------------------------------------
// computeRebalancing — basic category aggregation
// ---------------------------------------------------------------------------

describe("computeRebalancing - category values", () => {
  it("sums symbol values by exposure category", () => {
    var fullData = makeFullData({ VTI: 6000, BND: 4000 });
    var exposureMap = { VTI: { Domestic: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Domestic" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 60, Bonds: 40 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    assert.equal(result.portfolioTotal, 10000);
    var stocks = result.categories.find((c) => c.name === "Stocks");
    var bonds = result.categories.find((c) => c.name === "Bonds");
    assert.ok(Math.abs(stocks.currentValue - 6000) < 0.01);
    assert.ok(Math.abs(bonds.currentValue - 4000) < 0.01);
  });

  it("splits fractional symbol values across categories", () => {
    var fullData = makeFullData({ VTI: 1000 });
    var exposureMap = { VTI: { Domestic: 0.5, International: 0.5 } };
    var rebalCats = [
      { name: "Domestic", category: "Domestic" },
      { name: "International", category: "International" },
    ];
    var targets = { Domestic: 50, International: 50 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    assert.equal(result.portfolioTotal, 1000);
    var dom = result.categories.find((c) => c.name === "Domestic");
    assert.ok(Math.abs(dom.currentValue - 500) < 0.01);
  });

  it("resolves subcategories (comma-separated) from rebalCats entry", () => {
    var fullData = makeFullData({ VTI: 700, NVDA: 300, BND: 200 });
    var exposureMap = {
      VTI:  { "Domestic (ex-NVDA)": 1.0 },
      NVDA: { NVDA: 1.0 },
      BND:  { Bonds: 1.0 },
    };
    var rebalCats = [
      { name: "Domestic", subcategories: "NVDA, Domestic (ex-NVDA)" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Domestic: 83, Bonds: 17 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    var dom = result.categories.find((c) => c.name === "Domestic");
    assert.ok(Math.abs(dom.currentValue - 1000) < 0.01);
  });
});

// ---------------------------------------------------------------------------
// computeRebalancing — buy/sell amounts
// ---------------------------------------------------------------------------

describe("computeRebalancing - buy/sell", () => {
  it("returns zero buy/sell when allocation already matches target", () => {
    var fullData = makeFullData({ VTI: 6000, BND: 4000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 60, Bonds: 40 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    result.categories.forEach((c) => {
      assert.ok(Math.abs(c.buySell) < 0.01, "expected ~0 buySell for " + c.name);
    });
  });

  it("computes positive buySell for underweight category", () => {
    var fullData = makeFullData({ VTI: 5000, BND: 5000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 70, Bonds: 30 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    var stocks = result.categories.find((c) => c.name === "Stocks");
    var bonds = result.categories.find((c) => c.name === "Bonds");
    assert.ok(Math.abs(stocks.buySell - 2000) < 0.01);
    assert.ok(Math.abs(bonds.buySell - (-2000)) < 0.01);
  });

  it("category buySell sums to zero (zero-sum rebalancing)", () => {
    var fullData = makeFullData({ VTI: 3000, VXUS: 4000, BND: 3000 });
    var exposureMap = {
      VTI:  { Domestic: 1.0 },
      VXUS: { International: 1.0 },
      BND:  { Bonds: 1.0 },
    };
    var rebalCats = [
      { name: "Domestic", category: "Domestic" },
      { name: "International", category: "International" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Domestic: 40, International: 40, Bonds: 20 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    var total = result.categories.reduce((s, c) => s + c.buySell, 0);
    assert.ok(Math.abs(total) < 0.01);
  });
});

// ---------------------------------------------------------------------------
// computeRebalancing — per-ticker implied targets
// ---------------------------------------------------------------------------

describe("computeRebalancing - per-ticker", () => {
  it("single-ticker single-category: implied target matches category target", () => {
    var fullData = makeFullData({ VTI: 6000, BND: 4000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 70, Bonds: 30 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    var vti = result.tickers.find((t) => t.symbol === "VTI");
    assert.ok(Math.abs(vti.impliedTarget - 7000) < 0.01);
    assert.ok(Math.abs(vti.buySell - 1000) < 0.01);
  });

  it("unmapped symbol is absent from tickers output", () => {
    var fullData = makeFullData({ VTI: 6000, HomeEquity: 200000 });
    var exposureMap = { VTI: { Stocks: 1.0 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 100 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    assert.ok(!result.tickers.find((t) => t.symbol === "HomeEquity"),
      "unmapped symbol should not appear in tickers");
  });

  it("multi-category ticker: implied target is sum across categories", () => {
    var fullData = makeFullData({ "401k": 4000 });
    var exposureMap = { "401k": { Stocks: 0.75, Bonds: 0.25 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 60, Bonds: 40 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    var acct = result.tickers.find((t) => t.symbol === "401k");
    assert.ok(Math.abs(acct.impliedTarget - 4000) < 0.01);
    assert.ok(Math.abs(acct.buySell) < 0.01);
  });
});

// ---------------------------------------------------------------------------
// computeRebalancing — edge cases
// ---------------------------------------------------------------------------

describe("computeRebalancing - edge cases", () => {
  it("empty portfolio returns zeros", () => {
    var fullData = { symbols: [], chartData: [{ date: "2026-01-01", values: {}, cumulative: [] }] };
    var result = computeRebalancing(fullData, {}, [], {});
    assert.equal(result.portfolioTotal, 0);
    assert.equal(result.categories.length, 0);
    assert.equal(result.tickers.length, 0);
  });

  it("targets not summing to 100 still runs without error", () => {
    var fullData = makeFullData({ VTI: 6000, BND: 4000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 50, Bonds: 30 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    assert.ok(isFinite(result.categories[0].buySell));
    assert.ok(isFinite(result.categories[1].buySell));
  });

  it("currentPct reflects fraction of portfolioTotal", () => {
    var fullData = makeFullData({ VTI: 3000, BND: 7000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 50, Bonds: 50 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    var stocks = result.categories.find((c) => c.name === "Stocks");
    assert.ok(Math.abs(stocks.currentPct - 30) < 0.01);
  });
});

// ---------------------------------------------------------------------------
// computeRebalancing — tradeable option and unmapped symbol filtering
// ---------------------------------------------------------------------------

describe("computeRebalancing - tradeable option and unmapped symbol filtering", () => {
  it("unmapped symbols are absent from tickers output", () => {
    var fullData = makeFullData({ VTI: 6000, HomeEquity: 200000 });
    var exposureMap = { VTI: { Stocks: 1.0 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 100 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    assert.ok(!result.tickers.find(function(t) { return t.symbol === "HomeEquity"; }),
      "HomeEquity should not appear in tickers (not in exposureMap)");
    assert.ok(result.tickers.find(function(t) { return t.symbol === "VTI"; }),
      "VTI should still appear");
  });

  it("non-tradeable mapped symbols have null impliedTarget and null buySell", () => {
    var fullData = makeFullData({ VTI: 5000, "401k": 5000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, "401k": { Stocks: 1.0 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 100 };
    var options = { tradeable: ["VTI"] };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets, options);

    var acct = result.tickers.find(function(t) { return t.symbol === "401k"; });
    assert.equal(acct.impliedTarget, null);
    assert.equal(acct.buySell, null);
  });

  it("tradeable symbol buy/sell correctly accounts for non-tradeable exposure in same category", () => {
    // 401k ($5000, non-tradeable) already contributes $5000 to Stocks.
    // Target: Stocks 80% of $10000 = $8000.
    // VTI must fill the remaining need: $8000 - $5000 = $3000.
    // VTI implied = $3000, VTI buy/sell = $3000 - $5000 = -$2000 (sell).
    var fullData = makeFullData({ VTI: 5000, "401k": 5000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, "401k": { Stocks: 1.0 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 80 };
    var options = { tradeable: ["VTI"] };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets, options);

    var vti = result.tickers.find(function(t) { return t.symbol === "VTI"; });
    assert.ok(Math.abs(vti.impliedTarget - 3000) < 0.01);
    assert.ok(Math.abs(vti.buySell - (-2000)) < 0.01);
  });

  it("unmapped symbols are excluded even when tradeable option is set", () => {
    var fullData = makeFullData({ VTI: 6000, "401k": 3000, HomeEquity: 200000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, "401k": { Stocks: 1.0 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 100 };
    var options = { tradeable: ["VTI"] };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets, options);

    assert.ok(!result.tickers.find(function(t) { return t.symbol === "HomeEquity"; }),
      "HomeEquity should not appear (not in exposureMap)");
    var acct = result.tickers.find(function(t) { return t.symbol === "401k"; });
    assert.equal(acct.impliedTarget, null, "401k is not tradeable, should have null impliedTarget");
    var vti = result.tickers.find(function(t) { return t.symbol === "VTI"; });
    assert.ok(vti.impliedTarget !== null, "VTI is tradeable, should have impliedTarget");
  });

  it("without options argument, all exposure map symbols get buy/sell", () => {
    // No options means all exposureMap symbols get buy/sell
    var fullData = makeFullData({ VTI: 6000, BND: 4000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 70, Bonds: 30 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    var vti = result.tickers.find(function(t) { return t.symbol === "VTI"; });
    assert.ok(vti.impliedTarget !== null);
    assert.ok(vti.buySell !== null);
  });
});

// ---------------------------------------------------------------------------
// computeRebalancing — cross-category ticker sizing (greedy linear solver)
// ---------------------------------------------------------------------------

describe("computeRebalancing - cross-category greedy solver", () => {
  it("ticker spanning two categories is sized to satisfy the sole-tradeable category", () => {
    // VTI maps to CatA (10%) and CatB (90%).
    // NVDA maps to CatA (100%) only.
    // NonTrad maps to CatA (100%) — non-tradeable.
    // The only tradeable in CatB is VTI, so VTI must be sized from CatB first.
    // NVDA then fills the remaining CatA need after VTI's contribution is deducted.
    //
    // portfolioTotal = 1000 + 500 + 200 = 1700
    // targetA = 40% * 1700 = 680, targetB = 60% * 1700 = 1020
    // fixedA (NonTrad) = 200, availableA = 480
    // fixedB = 0, availableB = 1020
    // x_VTI  = 1020 / 0.9 = 1133.33  (sole tradeable in CatB)
    // deduct VTI from CatA: 480 - 1133.33*0.1 = 366.67
    // x_NVDA = 366.67 / 1.0 = 366.67  (sole remaining tradeable in CatA)
    var fullData = makeFullData({ VTI: 1000, NVDA: 500, NonTrad: 200 });
    var exposureMap = {
      VTI:     { A: 0.1, B: 0.9 },
      NVDA:    { A: 1.0 },
      NonTrad: { A: 1.0 },
    };
    var rebalCats = [
      { name: "Cat A", category: "A" },
      { name: "Cat B", category: "B" },
    ];
    var targets = { "Cat A": 40, "Cat B": 60 };
    var options = { tradeable: ["VTI", "NVDA"] };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets, options);

    var vti  = result.tickers.find(function(t) { return t.symbol === "VTI"; });
    var nvda = result.tickers.find(function(t) { return t.symbol === "NVDA"; });

    var expectedVTI  = 1020 / 0.9;
    var expectedNVDA = (680 - 200 - expectedVTI * 0.1) / 1.0;

    assert.ok(Math.abs(vti.impliedTarget  - expectedVTI)  < 0.01, "VTI sized from CatB");
    assert.ok(Math.abs(nvda.impliedTarget - expectedNVDA) < 0.01, "NVDA fills CatA remainder");

    // Verify both category constraints are simultaneously satisfied.
    var catA_actual = nvda.impliedTarget * 1.0 + vti.impliedTarget * 0.1 + 200;
    var catB_actual = vti.impliedTarget * 0.9;
    assert.ok(Math.abs(catA_actual - 680)  < 0.01, "CatA exactly satisfied");
    assert.ok(Math.abs(catB_actual - 1020) < 0.01, "CatB exactly satisfied");
  });
});

// ---------------------------------------------------------------------------
// computeContributions — basic behavior
// ---------------------------------------------------------------------------

describe("computeContributions - basic", () => {
  it("all contribution goes to sole under-allocated ticker", () => {
    // VTI $6000 (60%), BND $4000 (40%). Targets: Stocks 50%, Bonds 50%. Add $1000.
    // newTotal = $11000. VTI new target = $5500 → over-allocated → delta 0.
    // BND new target = $5500 → delta $1500. Scale: BND gets $1000, VTI gets $0.
    var fullData = makeFullData({ VTI: 6000, BND: 4000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 50, Bonds: 50 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, 1000, {});

    var vti = result.tickers.find((t) => t.symbol === "VTI");
    var bnd = result.tickers.find((t) => t.symbol === "BND");
    assert.ok(Math.abs(vti.contribution) < 0.01, "VTI over-allocated, gets nothing");
    assert.ok(Math.abs(bnd.contribution - 1000) < 0.01, "BND gets full contribution");
  });

  it("splits contribution proportionally across two under-allocated tickers", () => {
    // VTI $3000, VXUS $2000, BND $5000. Total $10000.
    // Targets: Stocks 40%, Intl 20%, Bonds 40%. Contribute $2000.
    // newTotal $12000. Targets: Stocks $4800, Intl $2400, Bonds $4800.
    // VTI delta = max(0, 4800 - 3000) = 1800.
    // VXUS delta = max(0, 2400 - 2000) = 400.
    // BND delta = max(0, 4800 - 5000) = 0.
    // totalDelta = 2200. VTI gets 1800/2200 * 2000 ≈ 1636.36. VXUS gets ≈ 363.64.
    var fullData = makeFullData({ VTI: 3000, VXUS: 2000, BND: 5000 });
    var exposureMap = {
      VTI:  { Stocks: 1.0 },
      VXUS: { Intl: 1.0 },
      BND:  { Bonds: 1.0 },
    };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Intl", category: "Intl" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 40, Intl: 20, Bonds: 40 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, 2000, {});

    var vti  = result.tickers.find((t) => t.symbol === "VTI");
    var vxus = result.tickers.find((t) => t.symbol === "VXUS");
    var bnd  = result.tickers.find((t) => t.symbol === "BND");
    assert.ok(Math.abs(vti.contribution  - (1800 / 2200) * 2000) < 0.01);
    assert.ok(Math.abs(vxus.contribution - (400  / 2200) * 2000) < 0.01);
    assert.ok(Math.abs(bnd.contribution) < 0.01, "BND over-allocated, gets nothing");
  });

  it("total ticker contributions sum exactly to amount", () => {
    var fullData = makeFullData({ VTI: 4000, VXUS: 3000, BND: 3000 });
    var exposureMap = {
      VTI:  { Stocks: 1.0 },
      VXUS: { Intl: 1.0 },
      BND:  { Bonds: 1.0 },
    };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Intl",   category: "Intl"   },
      { name: "Bonds",  category: "Bonds"  },
    ];
    var targets = { Stocks: 50, Intl: 30, Bonds: 20 };
    var amount = 5000;

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, amount, {});

    var totalContrib = result.tickers
      .filter((t) => t.contribution !== null)
      .reduce((s, t) => s + t.contribution, 0);
    assert.ok(Math.abs(totalContrib - amount) < 0.01,
      "contributions should sum to " + amount + ", got " + totalContrib);
  });

  it("amount of 0 returns all-zero contributions", () => {
    var fullData = makeFullData({ VTI: 4000, BND: 6000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds",  category: "Bonds"  },
    ];
    var targets = { Stocks: 60, Bonds: 40 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, 0, {});

    result.tickers.forEach((t) => {
      assert.ok(t.contribution !== null,
        t.symbol + " should have numeric contribution (not null) when amount=0");
      assert.ok(Math.abs(t.contribution) < 0.01,
        t.symbol + " should have zero contribution when amount=0");
    });
  });

  it("non-tradeable mapped symbols have null contribution", () => {
    var fullData = makeFullData({ VTI: 5000, "401k": 5000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, "401k": { Stocks: 1.0 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 100 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, 1000,
      { tradeable: ["VTI"] });

    var acct = result.tickers.find((t) => t.symbol === "401k");
    assert.equal(acct.contribution, null);
    assert.equal(acct.impliedTarget, null);
  });

  it("pro-rata fallback when all tradeable tickers are over-allocated for newTotal", () => {
    // VTI $8000 (tradeable), "401k" $8000 (non-tradeable). Total $16000.
    // Target: Stocks 50%. newTotal = $17000. Stock target = $8500.
    // 401k contributes $8000. VTI implied = $8500 - $8000 = $500. VTI current = $8000.
    // VTI delta = max(0, 500 - 8000) = 0. totalDelta = 0 → pro-rata fallback.
    // VTI is the only tradeable, so it gets the full $1000.
    var fullData = makeFullData({ VTI: 8000, "401k": 8000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, "401k": { Stocks: 1.0 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 50 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, 1000,
      { tradeable: ["VTI"] });

    var vti = result.tickers.find((t) => t.symbol === "VTI");
    assert.ok(Math.abs(vti.contribution - 1000) < 0.01,
      "pro-rata fallback: sole tradeable gets full amount");
  });

  it("result includes portfolioTotal and newTotal", () => {
    var fullData = makeFullData({ VTI: 6000, BND: 4000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds",  category: "Bonds"  },
    ];
    var targets = { Stocks: 60, Bonds: 40 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, 2000, {});

    assert.equal(result.portfolioTotal, 10000);
    assert.equal(result.newTotal, 12000);
  });

  it("empty portfolio returns zeros", () => {
    var fullData = { symbols: [], chartData: [{ date: "2026-01-01", values: {}, cumulative: [] }] };
    var result = computeContributions(fullData, {}, [], {}, 1000, {});
    assert.equal(result.portfolioTotal, 0);
    assert.equal(result.categories.length, 0);
    assert.equal(result.tickers.length, 0);
  });

  it("pro-rata fallback: sole tradeable with zero current value still gets full amount", () => {
    // VTI $0 (tradeable, brand new position), "401k" $10000 (non-tradeable).
    // Target: Stocks 50%. newTotal = $11000. Stock target = $5500.
    // 401k alone covers $10000 > $5500, so VTI implied = max(0, 5500-10000) = 0. totalDelta = 0.
    // Pro-rata fallback fires. VTI current = $0, so equal-weight: VTI gets full $1000.
    var fullData = makeFullData({ VTI: 0, "401k": 10000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, "401k": { Stocks: 1.0 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 50 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, 1000,
      { tradeable: ["VTI"] });

    var vti = result.tickers.find((t) => t.symbol === "VTI");
    assert.ok(Math.abs(vti.contribution - 1000) < 0.01,
      "sole tradeable with zero current value should receive full contribution via equal-weight fallback");
  });
});

describe("computeContributions - category breakdown", () => {
  it("per-category contribution reflects ticker contributions weighted by exposure", () => {
    // VTI $3000, BND $7000. Targets: Stocks 50%, Bonds 50%. Contribute $2000.
    // newTotal = $12000. VTI target = $6000, delta = 3000. BND delta = max(0,6000-7000) = 0.
    // VTI gets full $2000. Category Stocks contribution = $2000.
    var fullData = makeFullData({ VTI: 3000, BND: 7000 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds",  category: "Bonds"  },
    ];
    var targets = { Stocks: 50, Bonds: 50 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, 2000, {});

    var stocks = result.categories.find((c) => c.name === "Stocks");
    var bonds  = result.categories.find((c) => c.name === "Bonds");
    assert.ok(Math.abs(stocks.contribution - 2000) < 0.01);
    assert.ok(Math.abs(bonds.contribution) < 0.01);
  });
});

// ---------------------------------------------------------------------------
// computeContributions — withdrawal (negative amount)
// ---------------------------------------------------------------------------

describe("computeContributions - withdrawal", () => {
  it("sole over-allocated ticker gets sold, under-allocated gets nothing", () => {
    // VTI $8000 (80%), BND $2000 (20%). Targets: Stocks 50%, Bonds 50%.
    // Withdraw $1000. newTotal = $9000. VTI target = $4500 → over by $3500.
    // BND target = $4500 → under by $2500 → delta = 0 (don't buy when withdrawing).
    // All $1000 goes to selling VTI.
    var fullData = {
      symbols: ["VTI", "BND"],
      chartData: [{ date: "2026-01-01", values: { VTI: 8000, BND: 2000 }, cumulative: [] }],
    };
    var exposureMap = { VTI: { Stocks: 1 }, BND: { Bonds: 1 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds",  category: "Bonds"  },
    ];
    var targets = { Stocks: 50, Bonds: 50 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, -1000, {});

    var vti = result.tickers.find((t) => t.symbol === "VTI");
    var bnd = result.tickers.find((t) => t.symbol === "BND");
    assert.ok(vti.contribution < -0.01, "VTI should be sold");
    assert.ok(Math.abs(vti.contribution - (-1000)) < 0.01, "VTI gets all $1000 withdrawal");
    assert.ok(Math.abs(bnd.contribution) < 0.01, "BND is not sold (under-allocated)");
    assert.equal(result.newTotal, 9000);
    assert.equal(result.portfolioTotal, 10000);
  });

  it("withdrawal splits proportionally between two over-allocated tickers", () => {
    // VTI $6000, VXUS $4000. Targets: Stocks 40%, Intl 20%, Bonds 40%.
    // Bonds $0 — only Stocks and Intl present.
    // newTotal = $9000. VTI target = $3600 (over by $2400). VXUS target = $1800 (over by $2200).
    // totalDelta = $4600. VTI gets $1000 * 2400/4600 ≈ $521.74. VXUS gets ≈ $478.26.
    var fullData = {
      symbols: ["VTI", "VXUS"],
      chartData: [{ date: "2026-01-01", values: { VTI: 6000, VXUS: 4000 }, cumulative: [] }],
    };
    var exposureMap = { VTI: { Stocks: 1 }, VXUS: { Intl: 1 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Intl",   category: "Intl"   },
      { name: "Bonds",  category: "Bonds"  },
    ];
    var targets = { Stocks: 40, Intl: 20, Bonds: 40 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, -1000, {});

    var vti  = result.tickers.find((t) => t.symbol === "VTI");
    var vxus = result.tickers.find((t) => t.symbol === "VXUS");
    // Both should be sold (negative contributions)
    assert.ok(vti.contribution < -0.01,  "VTI should be sold");
    assert.ok(vxus.contribution < -0.01, "VXUS should be sold");
    // Sum must equal amount
    var total = vti.contribution + vxus.contribution;
    assert.ok(Math.abs(total - (-1000)) < 0.01, "contributions sum to -1000");
    // VTI gets more (higher over-allocation delta)
    assert.ok(vti.contribution < vxus.contribution, "VTI sells more than VXUS");
  });

  it("withdrawal sum invariant: ticker contributions sum to amount", () => {
    var fullData = {
      symbols: ["VTI", "VXUS", "BND"],
      chartData: [{ date: "2026-01-01", values: { VTI: 5000, VXUS: 3000, BND: 2000 }, cumulative: [] }],
    };
    var exposureMap = { VTI: { Stocks: 1 }, VXUS: { Intl: 1 }, BND: { Bonds: 1 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Intl",   category: "Intl"   },
      { name: "Bonds",  category: "Bonds"  },
    ];
    var targets = { Stocks: 50, Intl: 30, Bonds: 20 };
    var amount = -3000;

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, amount, {});

    var totalContrib = result.tickers
      .filter((t) => t.contribution !== null)
      .reduce((s, t) => s + t.contribution, 0);
    assert.ok(Math.abs(totalContrib - amount) < 0.01, "contributions sum to amount");
  });

  it("pro-rata fallback when portfolio is at target (nothing over-allocated)", () => {
    // VTI $5000, BND $5000. Targets: 50/50. Already perfectly balanced.
    // No ticker has delta > 0 when withdrawing. Fall back to pro-rata: sell equally.
    var fullData = {
      symbols: ["VTI", "BND"],
      chartData: [{ date: "2026-01-01", values: { VTI: 5000, BND: 5000 }, cumulative: [] }],
    };
    var exposureMap = { VTI: { Stocks: 1 }, BND: { Bonds: 1 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds",  category: "Bonds"  },
    ];
    var targets = { Stocks: 50, Bonds: 50 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, -1000, {});

    var vti = result.tickers.find((t) => t.symbol === "VTI");
    var bnd = result.tickers.find((t) => t.symbol === "BND");
    // Pro-rata: each has 50% weight → each sells $500
    assert.ok(Math.abs(vti.contribution - (-500)) < 0.01, "VTI sells $500 pro-rata");
    assert.ok(Math.abs(bnd.contribution - (-500)) < 0.01, "BND sells $500 pro-rata");
  });

  it("non-tradeable ticker contribution is null during withdrawal", () => {
    var fullData = {
      symbols: ["VTI", "401k"],
      chartData: [{ date: "2026-01-01", values: { VTI: 8000, "401k": 2000 }, cumulative: [] }],
    };
    var exposureMap = { VTI: { Stocks: 1 }, "401k": { Stocks: 1 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 100 };

    var result = computeContributions(fullData, exposureMap, rebalCats, targets, -1000,
      { tradeable: ["VTI"] });

    var acct = result.tickers.find((t) => t.symbol === "401k");
    assert.equal(acct.contribution, null, "non-tradeable contribution is null");
  });

  it("withdrawal amount clamped to portfolio total", () => {
    var fullData = {
      symbols: ["VTI"],
      chartData: [{ date: "2026-01-01", values: { VTI: 5000 }, cumulative: [] }],
    };
    var exposureMap = { VTI: { Stocks: 1 } };
    var rebalCats = [{ name: "Stocks", category: "Stocks" }];
    var targets = { Stocks: 100 };

    // Attempt to withdraw more than the portfolio is worth
    var result = computeContributions(fullData, exposureMap, rebalCats, targets, -99999, {});

    var totalContrib = result.tickers
      .filter((t) => t.contribution !== null)
      .reduce((s, t) => s + t.contribution, 0);
    assert.ok(Math.abs(totalContrib - (-5000)) < 0.01, "withdrawal clamped to portfolio total");
    assert.ok(result.newTotal >= 0, "newTotal is never negative");
  });
});

// ---------------------------------------------------------------------------
// computeRebalancing — edge cases
// ---------------------------------------------------------------------------

describe("computeRebalancing - zero portfolio", () => {
  it("does not throw when portfolio total is zero", () => {
    var fullData = makeFullData({ VTI: 0, BND: 0 });
    var exposureMap = { VTI: { Stocks: 1.0 }, BND: { Bonds: 1.0 } };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 60, Bonds: 40 };
    // Should not throw
    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);
    assert.equal(result.portfolioTotal, 0);
  });

  it("does not throw with empty symbols", () => {
    var fullData = { symbols: [], chartData: [{ date: "2026-01-01", values: {}, cumulative: [] }] };
    var result = computeRebalancing(fullData, {}, [], {});
    assert.equal(result.portfolioTotal, 0);
    assert.deepEqual(result.categories, []);
  });
});

describe("computeRebalancing - symbol in exposureMap but absent from fullData", () => {
  it("treats missing symbol value as zero", () => {
    // BND is in the exposureMap but not in fullData.values
    var fullData = makeFullData({ VTI: 10000 });
    var exposureMap = {
      VTI: { Stocks: 1.0 },
      BND: { Bonds: 1.0 },  // BND absent from fullData
    };
    var rebalCats = [
      { name: "Stocks", category: "Stocks" },
      { name: "Bonds", category: "Bonds" },
    ];
    var targets = { Stocks: 80, Bonds: 20 };

    var result = computeRebalancing(fullData, exposureMap, rebalCats, targets);

    // portfolioTotal should only count what's actually in the data
    assert.equal(result.portfolioTotal, 10000);

    var bonds = result.categories.find((c) => c.name === "Bonds");
    // BND is absent → current value of Bonds category is 0
    assert.ok(Math.abs(bonds.currentValue) < 0.01,
      `Expected Bonds currentValue ~0, got ${bonds.currentValue}`);
  });
});
