const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseConfig } = require("../app/js/config.js");

// ---------------------------------------------------------------------------
// Backwards compatibility: current (old) config format
// ---------------------------------------------------------------------------

describe("parseConfig - old format: array allocations with string fractions", () => {
  it("parses array allocations with string fractions into exposureMap", () => {
    var cfg = {
      exposure: {
        allocations: [
          { symbol: "VTI", category: "Domestic", fraction: "0.933" },
          { symbol: "VTI", category: "NVDA", fraction: "0.067" },
          { symbol: "NVDA", category: "NVDA", fraction: "1.0" },
        ],
      },
    };
    var result = parseConfig(cfg);
    assert.deepStrictEqual(result.exposureMap, {
      VTI: { Domestic: 0.933, NVDA: 0.067 },
      NVDA: { NVDA: 1.0 },
    });
  });
});

describe("parseConfig - old format: string indent", () => {
  it("preserves string indent value in exposureDisplay", () => {
    var cfg = {
      exposure: {
        display: [
          { name: "Domestic Stock", color: "#3b82f6", subcategories: "NVDA, Domestic (ex-NVDA)" },
          { name: "NVDA", color: "#76b900", indent: "true", category: "NVDA" },
        ],
      },
    };
    var result = parseConfig(cfg);
    assert.equal(result.exposureDisplay.length, 2);
    assert.equal(result.exposureDisplay[1].indent, "true");
  });
});

describe("parseConfig - old format: rebalancing section", () => {
  it("parses rebalancing categories, targets, and tradeable", () => {
    var cfg = {
      rebalancing: {
        categories: [
          { name: "NVDA", subcategories: "NVDA" },
          { name: "Domestic (Ex-NVDA)", subcategories: "Domestic (ex-NVDA)" },
          { name: "International Stock", category: "International" },
          { name: "Bonds", category: "Bonds" },
        ],
        targets: {
          NVDA: "10",
          "Domestic (Ex-NVDA)": "45",
          "International Stock": "25",
          Bonds: "20",
        },
        tradeable: ["NVDA", "VTI", "VXUS", "BND"],
      },
    };
    var result = parseConfig(cfg);
    var rc = result.rebalancingConfig;
    assert.equal(rc.categories.length, 4);
    assert.equal(rc.categories[0].name, "NVDA");
    assert.equal(rc.categories[0].subcategories, "NVDA");
    assert.equal(rc.targets.NVDA, 10);
    assert.equal(rc.targets["Domestic (Ex-NVDA)"], 45);
    assert.equal(rc.targets["International Stock"], 25);
    assert.equal(rc.targets.Bonds, 20);
    assert.deepStrictEqual(rc.tradeable, ["NVDA", "VTI", "VXUS", "BND"]);
  });

  it("parses string target values to numbers", () => {
    var cfg = {
      rebalancing: {
        categories: [{ name: "Stocks", category: "Stocks" }],
        targets: { Stocks: "60" },
      },
    };
    var result = parseConfig(cfg);
    assert.equal(typeof result.rebalancingConfig.targets.Stocks, "number");
    assert.equal(result.rebalancingConfig.targets.Stocks, 60);
  });
});

describe("parseConfig - old format: other fields", () => {
  it("parses symbolOrder", () => {
    var result = parseConfig({ symbolOrder: ["I-Bond", "401k"] });
    assert.deepStrictEqual(result.symbolOrder, ["I-Bond", "401k"]);
  });

  it("parses capitalGains.method", () => {
    var result = parseConfig({ capitalGains: { method: "FIFO" } });
    assert.equal(result.gainsMethod, "FIFO");
  });

  it("parses colors", () => {
    var colors = [{ fill: "rgba(0,0,0,0.5)", stroke: "#000" }];
    var result = parseConfig({ colors: colors });
    assert.deepStrictEqual(result.colors, colors);
  });

  it("parses marginLoan.chartDisplay", () => {
    var result = parseConfig({ marginLoan: { chartDisplay: "proportional" } });
    assert.equal(result.marginLoanDisplay, "proportional");
  });

  it("returns all nulls for empty config", () => {
    var result = parseConfig({});
    assert.equal(result.colors, null);
    assert.equal(result.exposureMap, null);
    assert.equal(result.exposureDisplay, null);
    assert.equal(result.symbolOrder, null);
    assert.equal(result.gainsMethod, null);
    assert.equal(result.rebalancingConfig, null);
    assert.equal(result.marginLoanDisplay, null);
  });

  it("returns all nulls for null config", () => {
    var result = parseConfig(null);
    assert.equal(result.colors, null);
    assert.equal(result.exposureMap, null);
  });
});

describe("parseConfig - old format: full demo config round-trip", () => {
  it("parses the complete demo-data config correctly", () => {
    var cfg = {
      symbolOrder: ["I-Bond", "401k", "Home Equity"],
      colors: [
        { fill: "rgba(239, 68, 68, 0.55)", stroke: "rgb(239, 68, 68)" },
        { fill: "rgba(59, 130, 246, 0.55)", stroke: "rgb(59, 130, 246)" },
      ],
      capitalGains: { method: "FIFO" },
      marginLoan: { chartDisplay: "proportional" },
      rebalancing: {
        categories: [
          { name: "NVDA", subcategories: "NVDA" },
          { name: "Domestic (Ex-NVDA)", subcategories: "Domestic (ex-NVDA)" },
          { name: "International Stock", category: "International" },
          { name: "Bonds", category: "Bonds" },
        ],
        targets: { NVDA: "10", "Domestic (Ex-NVDA)": "45", "International Stock": "25", Bonds: "20" },
        tradeable: ["NVDA", "VTI", "VXUS", "BND"],
      },
      exposure: {
        allocations: [
          { symbol: "NVDA", category: "NVDA", fraction: "1.0" },
          { symbol: "VTI", category: "NVDA", fraction: "0.067" },
          { symbol: "VTI", category: "Domestic (ex-NVDA)", fraction: "0.933" },
          { symbol: "VXUS", category: "International", fraction: "1.0" },
          { symbol: "BND", category: "Bonds", fraction: "1.0" },
        ],
        display: [
          { name: "Domestic Stock", color: "#3b82f6", subcategories: "NVDA, Domestic (ex-NVDA)" },
          { name: "NVDA", color: "#76b900", indent: "true", category: "NVDA" },
          { name: "Non-NVDA", color: "#6366f1", indent: "true", category: "Domestic (ex-NVDA)" },
          { name: "International Stock", color: "#f59e0b", category: "International" },
          { name: "Bonds", color: "#14b8a6", category: "Bonds" },
        ],
      },
    };

    var result = parseConfig(cfg);

    assert.deepStrictEqual(result.symbolOrder, ["I-Bond", "401k", "Home Equity"]);
    assert.equal(result.colors.length, 2);
    assert.equal(result.gainsMethod, "FIFO");
    assert.equal(result.marginLoanDisplay, "proportional");

    // Exposure map
    assert.ok(Math.abs(result.exposureMap.NVDA.NVDA - 1.0) < 0.001);
    assert.ok(Math.abs(result.exposureMap.VTI.NVDA - 0.067) < 0.001);
    assert.ok(Math.abs(result.exposureMap.VTI["Domestic (ex-NVDA)"] - 0.933) < 0.001);

    // Rebalancing
    assert.equal(result.rebalancingConfig.categories.length, 4);
    assert.equal(result.rebalancingConfig.targets.NVDA, 10);
    assert.deepStrictEqual(result.rebalancingConfig.tradeable, ["NVDA", "VTI", "VXUS", "BND"]);
  });
});

// ---------------------------------------------------------------------------
// New config format
// ---------------------------------------------------------------------------

describe("parseConfig - new format: object allocations", () => {
  it("parses object allocations with numeric fractions", () => {
    var cfg = {
      exposure: {
        allocations: {
          VTI: { NVDA: 0.067, "Domestic (ex-NVDA)": 0.933 },
          NVDA: { NVDA: 1.0 },
        },
      },
    };
    var result = parseConfig(cfg);
    assert.deepStrictEqual(result.exposureMap, {
      VTI: { NVDA: 0.067, "Domestic (ex-NVDA)": 0.933 },
      NVDA: { NVDA: 1.0 },
    });
  });

  it("parses object allocations with string fractions", () => {
    var cfg = {
      exposure: {
        allocations: {
          VTI: { Domestic: "0.933" },
        },
      },
    };
    var result = parseConfig(cfg);
    assert.ok(Math.abs(result.exposureMap.VTI.Domestic - 0.933) < 0.001);
  });
});

describe("parseConfig - new format: inline display targets", () => {
  it("derives rebalancing config from display rows with target fields", () => {
    var cfg = {
      exposure: {
        display: [
          { name: "Domestic Stock", color: "#3b82f6", subcategories: "NVDA, Domestic (ex-NVDA)" },
          { name: "NVDA", color: "#76b900", indent: true, category: "NVDA", target: 10 },
          { name: "Non-NVDA", color: "#6366f1", indent: true, category: "Domestic (ex-NVDA)" },
          { name: "International Stock", color: "#f59e0b", category: "International", target: 25 },
          { name: "Bonds", color: "#14b8a6", category: "Bonds", target: 20 },
        ],
        tradeable: ["NVDA", "VTI", "VXUS", "BND"],
      },
    };
    var result = parseConfig(cfg);
    var rc = result.rebalancingConfig;

    assert.equal(rc.categories.length, 3);
    assert.equal(rc.categories[0].name, "NVDA");
    assert.equal(rc.categories[0].category, "NVDA");
    assert.equal(rc.categories[1].name, "International Stock");
    assert.equal(rc.categories[1].category, "International");
    assert.equal(rc.categories[2].name, "Bonds");

    assert.equal(rc.targets.NVDA, 10);
    assert.equal(rc.targets["International Stock"], 25);
    assert.equal(rc.targets.Bonds, 20);

    assert.deepStrictEqual(rc.tradeable, ["NVDA", "VTI", "VXUS", "BND"]);
  });

  it("does not derive rebalancing when no display rows have target", () => {
    var cfg = {
      exposure: {
        display: [
          { name: "Stocks", color: "#3b82f6", category: "Stocks" },
        ],
      },
    };
    var result = parseConfig(cfg);
    assert.equal(result.rebalancingConfig, null);
  });

  it("derives rebalancing with subcategories from display rows", () => {
    var cfg = {
      exposure: {
        display: [
          { name: "Domestic", color: "#3b82f6", subcategories: "NVDA, Other", target: 60 },
          { name: "Bonds", color: "#14b8a6", category: "Bonds", target: 40 },
        ],
      },
    };
    var result = parseConfig(cfg);
    var rc = result.rebalancingConfig;
    assert.equal(rc.categories[0].subcategories, "NVDA, Other");
    assert.equal(rc.categories[1].category, "Bonds");
  });
});

describe("parseConfig - new format: explicit rebalancing overrides display targets", () => {
  it("uses explicit rebalancing section when present, ignoring display targets", () => {
    var cfg = {
      exposure: {
        display: [
          { name: "Stocks", color: "#3b82f6", category: "Stocks", target: 50 },
          { name: "Bonds", color: "#14b8a6", category: "Bonds", target: 50 },
        ],
      },
      rebalancing: {
        categories: [{ name: "All", category: "Stocks" }],
        targets: { All: "100" },
      },
    };
    var result = parseConfig(cfg);
    assert.equal(result.rebalancingConfig.categories.length, 1);
    assert.equal(result.rebalancingConfig.categories[0].name, "All");
    assert.equal(result.rebalancingConfig.targets.All, 100);
  });
});

describe("parseConfig - new format: native JSON types", () => {
  it("accepts boolean indent", () => {
    var cfg = {
      exposure: {
        display: [
          { name: "NVDA", color: "#76b900", indent: true, category: "NVDA" },
        ],
      },
    };
    var result = parseConfig(cfg);
    assert.equal(result.exposureDisplay[0].indent, true);
  });

  it("accepts numeric fractions in array allocations", () => {
    var cfg = {
      exposure: {
        allocations: [
          { symbol: "VTI", category: "Domestic", fraction: 0.933 },
        ],
      },
    };
    var result = parseConfig(cfg);
    assert.ok(Math.abs(result.exposureMap.VTI.Domestic - 0.933) < 0.001);
  });

  it("accepts numeric target values in rebalancing.targets", () => {
    var cfg = {
      rebalancing: {
        categories: [{ name: "Stocks", category: "Stocks" }],
        targets: { Stocks: 60 },
      },
    };
    var result = parseConfig(cfg);
    assert.equal(result.rebalancingConfig.targets.Stocks, 60);
  });

  it("accepts string target in display row", () => {
    var cfg = {
      exposure: {
        display: [
          { name: "Stocks", color: "#3b82f6", category: "Stocks", target: "60" },
        ],
      },
    };
    var result = parseConfig(cfg);
    assert.equal(result.rebalancingConfig.targets.Stocks, 60);
  });
});

describe("parseConfig - new format: full new-format config round-trip", () => {
  it("parses a complete new-format config correctly", () => {
    var cfg = {
      symbolOrder: ["I-Bond", "401k"],
      colors: [{ fill: "rgba(0,0,0,0.5)", stroke: "#000" }],
      capitalGains: { method: "average_cost" },
      exposure: {
        allocations: {
          VTI: { NVDA: 0.067, "Domestic (ex-NVDA)": 0.933 },
          NVDA: { NVDA: 1.0 },
          VXUS: { International: 1.0 },
          BND: { Bonds: 1.0 },
        },
        display: [
          { name: "Domestic Stock", color: "#3b82f6", subcategories: "NVDA, Domestic (ex-NVDA)" },
          { name: "NVDA", color: "#76b900", indent: true, category: "NVDA", target: 10 },
          { name: "Non-NVDA", color: "#6366f1", indent: true, category: "Domestic (ex-NVDA)", target: 45 },
          { name: "International Stock", color: "#f59e0b", category: "International", target: 25 },
          { name: "Bonds", color: "#14b8a6", category: "Bonds", target: 20 },
        ],
        tradeable: ["NVDA", "VTI", "VXUS", "BND"],
      },
    };

    var result = parseConfig(cfg);

    // Basic fields
    assert.deepStrictEqual(result.symbolOrder, ["I-Bond", "401k"]);
    assert.equal(result.gainsMethod, "average_cost");

    // Object allocations
    assert.ok(Math.abs(result.exposureMap.VTI.NVDA - 0.067) < 0.001);
    assert.ok(Math.abs(result.exposureMap.VTI["Domestic (ex-NVDA)"] - 0.933) < 0.001);
    assert.equal(Object.keys(result.exposureMap).length, 4);

    // Derived rebalancing from display targets
    var rc = result.rebalancingConfig;
    assert.equal(rc.categories.length, 4);
    assert.equal(rc.targets.NVDA, 10);
    assert.equal(rc.targets["Non-NVDA"], 45);
    assert.equal(rc.targets["International Stock"], 25);
    assert.equal(rc.targets.Bonds, 20);
    assert.deepStrictEqual(rc.tradeable, ["NVDA", "VTI", "VXUS", "BND"]);
  });
});
