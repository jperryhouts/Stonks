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

  it("bootstraps account value from contributions when no prior ground truth exists", () => {
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-03", prices: { VTI: "110" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-04", prices: { VTI: "120" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = makeData([], chartData);
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [{ date: "2024-01-04", account: "401k", value: "15000" }],
      contributions: [{ date: "2024-01-02", account: "401k", amount: "10000" }],
    };
    mergeRetirement(data, retirement, MARKET);
    // Day 1: contribution of $10000 at proxy=100 → value=10000
    assert.equal(data.chartData[0].values["401k"], 10000);
    // Day 2: interpolated — 10000 * (110/100) = 11000
    assert.ok(Math.abs(data.chartData[1].values["401k"] - 11000) < 0.01);
    // Day 3: GT=15000 takes over
    assert.equal(data.chartData[2].values["401k"], 15000);
  });

  it("accumulates multiple contributions before first ground truth", () => {
    const chartData = [
      { date: "2024-01-02", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-03", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
      { date: "2024-01-04", prices: { VTI: "100" }, values: {}, cumulative: [], total: 0 },
    ];
    const data = makeData([], chartData);
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [],
      contributions: [
        { date: "2024-01-02", account: "401k", amount: "5000" },
        { date: "2024-01-03", account: "401k", amount: "3000" },
      ],
    };
    mergeRetirement(data, retirement, MARKET);
    // Day 1: first contribution → 5000
    assert.equal(data.chartData[0].values["401k"], 5000);
    // Day 2: second contribution added (proxy flat) → 5000 + 3000 = 8000
    assert.equal(data.chartData[1].values["401k"], 8000);
    // Day 3: still 8000 (proxy flat, no more contributions)
    assert.equal(data.chartData[2].values["401k"], 8000);
  });

  it("builds skeleton chartData back to earliest contribution date when it precedes values", () => {
    const data = makeData([], []); // empty chartData, no trades
    const retirement = {
      accounts: [{ name: "401k", proxy: "VTI" }],
      values: [{ date: "2024-01-04", account: "401k", value: "5000" }],
      contributions: [{ date: "2024-01-02", account: "401k", amount: "4000" }],
    };
    mergeRetirement(data, retirement, MARKET);
    // Skeleton should start from 2024-01-02 (contribution date), not 2024-01-04 (GT date)
    assert.ok(data.chartData.length >= 3);
    assert.equal(data.chartData[0].date, "2024-01-02");
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
