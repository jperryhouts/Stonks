const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mergeRetirement } = require("../app/js/retirement.js");

// Helpers
function makeData(symbols, chartData) {
  return { symbols: symbols.slice(), chartData, yMax: 1 };
}

const MARKET = [
  { timestamp: "2024-01-02 16:00", VTI: "100", VXUS: "50" },
  { timestamp: "2024-01-03 16:00", VTI: "110", VXUS: "55" },
  { timestamp: "2024-01-04 16:00", VTI: "120", VXUS: "60" },
];

// ---------------------------------------------------------------------------
// mergeRetirement — no-op cases
// ---------------------------------------------------------------------------

describe("mergeRetirement — no-op cases", () => {
  it("does nothing when retirement is null", () => {
    const data = makeData(["VTI"], []);
    mergeRetirement(data, null, MARKET);
    assert.deepEqual(data.symbols, ["VTI"]);
  });

  it("does nothing when accounts array is empty", () => {
    const data = makeData(["VTI"], []);
    mergeRetirement(data, { accounts: [], values: [] }, MARKET);
    assert.deepEqual(data.symbols, ["VTI"]);
  });

  it("does nothing when values is not an array", () => {
    const data = makeData(["VTI"], []);
    mergeRetirement(data, { accounts: [{ name: "401k" }], values: null }, MARKET);
    assert.deepEqual(data.symbols, ["VTI"]);
  });
});

// ---------------------------------------------------------------------------
// mergeRetirement — interpolation
// ---------------------------------------------------------------------------

describe("mergeRetirement — interpolation", () => {
  it("adds account as a new symbol", () => {
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-03", prices: { VTI: "110" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = makeData([], chartData);
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [{ date: "2024-01-02", account: "401k", value: "10000" }],
    };
    mergeRetirement(data, retirement, MARKET);
    assert.ok(data.symbols.includes("401k"));
  });

  it("interpolates value using proxy ticker ratio", () => {
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-03", prices: { VTI: "110" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = makeData([], chartData);
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [{ date: "2024-01-02", account: "401k", value: "10000" }],
    };
    mergeRetirement(data, retirement, MARKET);
    // Day 1: gt=$10000, proxy=100 → value=10000
    assert.equal(data.chartData[0].values["401k"], 10000);
    // Day 2: proxy=110, ratio=1.1 → value=11000
    assert.equal(data.chartData[1].values["401k"], 11000);
  });

  it("updates to a later ground truth when one becomes available", () => {
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-03", prices: { VTI: "110" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-04", prices: { VTI: "120" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = makeData([], chartData);
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [
        { date: "2024-01-02", account: "401k", value: "10000" },
        { date: "2024-01-03", account: "401k", value: "12000" }, // new GT on day 2
      ],
    };
    mergeRetirement(data, retirement, MARKET);
    // Day 1: from first GT — 10000 * (100/100) = 10000
    assert.equal(data.chartData[0].values["401k"], 10000);
    // Day 2: second GT kicks in — 12000 * (110/110) = 12000
    assert.equal(data.chartData[1].values["401k"], 12000);
    // Day 3: interpolated from second GT — 12000 * (120/110)
    assert.ok(Math.abs(data.chartData[2].values["401k"] - 12000 * (120 / 110)) < 0.01);
  });

  it("builds skeleton chartData when none exists and retirement has values", () => {
    const data = makeData([], []); // empty chartData
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [{ date: "2024-01-03", account: "401k", value: "5000" }],
    };
    mergeRetirement(data, retirement, MARKET);
    // Should have built skeleton from market starting on/after 2024-01-03
    assert.ok(data.chartData.length >= 2);
    assert.ok(data.chartData[0].date >= "2024-01-03");
  });

  it("uses VTI as default proxy when proxy is not specified", () => {
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-03", prices: { VTI: "110" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = makeData([], chartData);
    const retirement = {
      accounts: [{ name: "401k" }], // no proxy field
      values: [{ date: "2024-01-02", account: "401k", value: "10000" }],
    };
    mergeRetirement(data, retirement, MARKET);
    assert.equal(data.chartData[1].values["401k"], 11000); // 10000 * (110/100)
  });

  it("applies contributions with comma-formatted amounts", () => {
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-03", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-04", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = makeData([], chartData);
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [{ date: "2024-01-02", account: "401k", value: "10000" }],
      contributions: [{ date: "2024-01-03", account: "401k", amount: "1,500.00" }],
    };
    mergeRetirement(data, retirement, MARKET);
    // Day 1: GT = 10000
    assert.equal(data.chartData[0].values["401k"], 10000);
    // Day 2: contribution of $1,500 applied (proxy flat) → 10000 + 1500 = 11500
    assert.equal(data.chartData[1].values["401k"], 11500);
    // Day 3: same proxy price, so stays 11500
    assert.equal(data.chartData[2].values["401k"], 11500);
  });

  it("rebuilds cumulative totals after merging", () => {
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: { VTI: 5000 }, cumulative: [5000], total: 5000 },
    ];
    const data = makeData(["VTI"], chartData);
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [{ date: "2024-01-02", account: "401k", value: "10000" }],
    };
    mergeRetirement(data, retirement, MARKET);
    assert.equal(data.chartData[0].total, 15000);
    assert.deepEqual(data.chartData[0].cumulative, [5000, 15000]);
  });
});
