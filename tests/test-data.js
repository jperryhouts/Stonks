const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { niceMax, processData, filterData, rebuildCumulatives, applySymbolOrder } = require("../app/js/data.js");

// ---------------------------------------------------------------------------
// niceMax
// ---------------------------------------------------------------------------

describe("niceMax", () => {
  it("returns 1 for zero", () => {
    assert.equal(niceMax(0), 1);
  });

  it("returns 1 for negative", () => {
    assert.equal(niceMax(-100), 1);
  });

  it("rounds up to the next nice number", () => {
    assert.equal(niceMax(73000), 80000);
    assert.equal(niceMax(100000), 100000);
    assert.equal(niceMax(100001), 125000);
    assert.equal(niceMax(250000), 250000);
    assert.equal(niceMax(250001), 300000);
  });

  it("handles small values", () => {
    assert.equal(niceMax(1), 1);
    assert.equal(niceMax(1.5), 1.5);
    assert.equal(niceMax(9), 10);
  });
});

// ---------------------------------------------------------------------------
// processData
// ---------------------------------------------------------------------------

const MARKET = [
  { timestamp: "2024-01-02 16:00", VTI: "100", VXUS: "50" },
  { timestamp: "2024-01-03 16:00", VTI: "105", VXUS: "52" },
  { timestamp: "2024-01-04 16:00", VTI: "110", VXUS: "55" },
];

describe("processData", () => {
  it("returns null for empty trades", () => {
    assert.equal(processData([], MARKET), null);
  });

  it("returns empty chartData when trades are after all market dates", () => {
    const trades = [{ date: "2025-01-01", symbol: "VTI", price: "100", quantity: "10" }];
    const result = processData(trades, MARKET);
    assert.ok(result, "result should not be null");
    assert.equal(result.chartData.length, 0);
  });

  it("computes values for a single trade", () => {
    const trades = [{ date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" }];
    const result = processData(trades, MARKET);
    assert.ok(result, "result should not be null");
    assert.deepEqual(result.symbols, ["VTI"]);
    assert.equal(result.chartData.length, 3);
    assert.equal(result.chartData[0].values.VTI, 1000);  // 10 shares * 100
    assert.equal(result.chartData[1].values.VTI, 1050);  // 10 shares * 105
    assert.equal(result.chartData[2].values.VTI, 1100);  // 10 shares * 110
  });

  it("cumulative stacks add up correctly", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" },
      { date: "2024-01-02", symbol: "VXUS", price: "50", quantity: "5" },
    ];
    const result = processData(trades, MARKET);
    // Day 1: VTI=1000, VXUS=250, cumulative=[1000, 1250]
    assert.deepEqual(result.chartData[0].cumulative, [1000, 1250]);
    assert.equal(result.chartData[0].total, 1250);
  });

  it("handles sells (negative quantity)", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" },
      { date: "2024-01-03", symbol: "VTI", price: "105", quantity: "-3" },
    ];
    const result = processData(trades, MARKET);
    // After sell: 7 shares
    assert.equal(result.chartData[1].positions.VTI, 7);
    assert.equal(result.chartData[2].positions.VTI, 7);
  });

  it("applies transactions in date order regardless of input order", () => {
    const trades = [
      { date: "2024-01-03", symbol: "VTI", price: "105", quantity: "5" }, // later first
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" },
    ];
    const result = processData(trades, MARKET);
    // day 1: 10 shares (only first txn applied)
    assert.equal(result.chartData[0].values.VTI, 1000);
    // day 2: 15 shares
    assert.equal(result.chartData[1].values.VTI, 15 * 105);
  });

  it("computes a valid yMax", () => {
    const trades = [{ date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" }];
    const result = processData(trades, MARKET);
    assert.ok(result.yMax >= 1100, "yMax should be >= highest total");
  });

  it("handles type:sell with positive quantity identically to legacy negative quantity", () => {
    const legacyTrades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" },
      { date: "2024-01-03", symbol: "VTI", price: "105", quantity: "-3" },
    ];
    const typedTrades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10", type: "buy" },
      { date: "2024-01-03", symbol: "VTI", price: "105", quantity: "3", type: "sell" },
    ];
    const legacy = processData(legacyTrades, MARKET);
    const typed = processData(typedTrades, MARKET);
    assert.equal(typed.chartData[1].positions.VTI, legacy.chartData[1].positions.VTI);
    assert.equal(typed.chartData[2].positions.VTI, legacy.chartData[2].positions.VTI);
  });

  it("handles type:buy with positive quantity the same as unsigned buy", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10", type: "buy" },
    ];
    const result = processData(trades, MARKET);
    assert.equal(result.chartData[0].values.VTI, 1000);
  });

  it("handles type:donation with positive quantity as a position reduction", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10", type: "buy" },
      { date: "2024-01-03", symbol: "VTI", price: "105", quantity: "3", type: "donate" },
    ];
    const result = processData(trades, MARKET);
    // After donation: 7 shares remain
    assert.equal(result.chartData[1].positions.VTI, 7);
    assert.equal(result.chartData[2].positions.VTI, 7);
  });

  it("type:drip increases share count like a buy", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10", type: "buy" },
      { date: "2024-01-03", symbol: "VTI", price: "105", quantity: "0.5", type: "drip" },
    ];
    const result = processData(trades, MARKET);
    // After drip: 10.5 shares
    assert.equal(result.chartData[1].positions.VTI, 10.5);
    assert.equal(result.chartData[2].positions.VTI, 10.5);
  });
});

// ---------------------------------------------------------------------------
// filterData
// ---------------------------------------------------------------------------

const FULL_DATA = {
  symbols: ["VTI"],
  chartData: [
    { date: "2024-01-02", total: 1000, values: { VTI: 1000 }, cumulative: [1000] },
    { date: "2024-03-15", total: 1100, values: { VTI: 1100 }, cumulative: [1100] },
    { date: "2024-06-01", total: 1200, values: { VTI: 1200 }, cumulative: [1200] },
    { date: "2024-12-31", total: 1300, values: { VTI: 1300 }, cumulative: [1300] },
  ],
  yMax: 1500,
};

describe("filterData", () => {
  it("returns full data for 'All' window", () => {
    const result = filterData(FULL_DATA, "All");
    assert.equal(result, FULL_DATA);
  });

  it("returns full data for empty chartData", () => {
    const empty = { symbols: [], chartData: [], yMax: 1 };
    assert.equal(filterData(empty, "1M"), empty);
  });

  it("filters for YTD (from start of last year in data)", () => {
    const result = filterData(FULL_DATA, "YTD");
    // Last date is 2024-12-31, YTD cutoff = 2024-01-01
    assert.ok(result.chartData.every(d => d.date >= "2024-01-01"));
  });

  it("filters for 1Y window", () => {
    const result = filterData(FULL_DATA, "1Y");
    // Last date 2024-12-31, cutoff ~= 2023-12-31
    assert.ok(result.chartData.length > 0);
    assert.ok(result.chartData.every(d => d.date >= "2023-12-31"));
  });

  it("PREV_YEAR returns only data from Jan 1 to Dec 31 of year before last data point", () => {
    const data = {
      symbols: ["VTI"],
      chartData: [
        { date: "2024-01-15", total: 1000, values: { VTI: 1000 }, cumulative: [1000] },
        { date: "2024-06-01", total: 1100, values: { VTI: 1100 }, cumulative: [1100] },
        { date: "2024-12-31", total: 1200, values: { VTI: 1200 }, cumulative: [1200] },
        { date: "2025-01-02", total: 1250, values: { VTI: 1250 }, cumulative: [1250] },
        { date: "2025-06-01", total: 1300, values: { VTI: 1300 }, cumulative: [1300] },
      ],
      yMax: 1500,
    };
    const result = filterData(data, "PREV_YEAR");
    assert.equal(result.chartData.length, 3);
    assert.equal(result.chartData[0].date, "2024-01-15");
    assert.equal(result.chartData[2].date, "2024-12-31");
  });

  it("PREV_YEAR year is relative to last data point, not today", () => {
    // Last data point in 2023 — previous year is 2022
    const data = {
      symbols: ["VTI"],
      chartData: [
        { date: "2022-03-01", total: 900, values: { VTI: 900 }, cumulative: [900] },
        { date: "2022-12-15", total: 950, values: { VTI: 950 }, cumulative: [950] },
        { date: "2023-03-01", total: 1000, values: { VTI: 1000 }, cumulative: [1000] },
      ],
      yMax: 1200,
    };
    const result = filterData(data, "PREV_YEAR");
    assert.equal(result.chartData.length, 2);
    assert.equal(result.chartData[0].date, "2022-03-01");
    assert.equal(result.chartData[1].date, "2022-12-15");
  });

  it("falls back to full data when filtered result has < 2 points", () => {
    const sparse = {
      symbols: ["VTI"],
      chartData: [
        { date: "2020-01-01", total: 1000, values: { VTI: 1000 }, cumulative: [1000] },
        { date: "2024-12-31", total: 1300, values: { VTI: 1300 }, cumulative: [1300] },
      ],
      yMax: 1500,
    };
    // 1M filter would include only 1 row — should fall back to full
    const result = filterData(sparse, "1M");
    assert.equal(result.chartData.length, 2);
  });
});

// ---------------------------------------------------------------------------
// rebuildCumulatives
// ---------------------------------------------------------------------------

describe("rebuildCumulatives", () => {
  it("rebuilds cumulative arrays and totals", () => {
    const data = {
      symbols: ["VTI", "VXUS"],
      chartData: [
        { values: { VTI: 1000, VXUS: 300 }, cumulative: [], total: 0 },
        { values: { VTI: 1100, VXUS: 320 }, cumulative: [], total: 0 },
      ],
      yMax: 0,
    };
    rebuildCumulatives(data);
    assert.deepEqual(data.chartData[0].cumulative, [1000, 1300]);
    assert.equal(data.chartData[0].total, 1300);
    assert.deepEqual(data.chartData[1].cumulative, [1100, 1420]);
    assert.equal(data.chartData[1].total, 1420);
  });

  it("updates yMax to a nice round number >= actual max", () => {
    const data = {
      symbols: ["VTI"],
      chartData: [
        { values: { VTI: 73000 }, cumulative: [], total: 0 },
      ],
      yMax: 0,
    };
    rebuildCumulatives(data);
    assert.ok(data.yMax >= 73000);
    assert.equal(data.yMax, 80000);
  });

  it("treats missing symbol values as 0", () => {
    const data = {
      symbols: ["VTI", "VXUS"],
      chartData: [
        { values: { VTI: 500 }, cumulative: [], total: 0 },
      ],
      yMax: 0,
    };
    rebuildCumulatives(data);
    assert.deepEqual(data.chartData[0].cumulative, [500, 500]);
    assert.equal(data.chartData[0].total, 500);
  });
});

// ---------------------------------------------------------------------------
// applySymbolOrder
// ---------------------------------------------------------------------------

describe("applySymbolOrder", () => {
  it("does nothing when symbolOrder is empty", () => {
    const data = {
      symbols: ["VTI", "VXUS", "BND"],
      chartData: [{ values: { VTI: 100, VXUS: 50, BND: 30 }, cumulative: [], total: 0 }],
      yMax: 200,
    };
    applySymbolOrder(data, []);
    assert.deepEqual(data.symbols, ["VTI", "VXUS", "BND"]);
  });

  it("moves ordered symbols to the end", () => {
    const data = {
      symbols: ["VTI", "VXUS", "BND"],
      chartData: [{ values: { VTI: 100, VXUS: 50, BND: 30 }, cumulative: [], total: 0 }],
      yMax: 200,
    };
    applySymbolOrder(data, ["VTI"]);
    // VTI pushed to end; rest keeps original order
    assert.deepEqual(data.symbols, ["VXUS", "BND", "VTI"]);
  });

  it("ignores symbols in order that are not in data", () => {
    const data = {
      symbols: ["VTI", "VXUS"],
      chartData: [{ values: { VTI: 100, VXUS: 50 }, cumulative: [], total: 0 }],
      yMax: 200,
    };
    applySymbolOrder(data, ["BND", "VTI"]);
    assert.deepEqual(data.symbols, ["VXUS", "VTI"]);
  });

  it("rebuilds cumulative arrays after reordering", () => {
    const data = {
      symbols: ["VTI", "VXUS"],
      chartData: [{ values: { VTI: 100, VXUS: 50 }, cumulative: [100, 150], total: 150 }],
      yMax: 200,
    };
    applySymbolOrder(data, ["VTI"]); // VTI moves to end: [VXUS, VTI]
    // cumulative should now be [50, 150]
    assert.deepEqual(data.chartData[0].cumulative, [50, 150]);
  });
});
