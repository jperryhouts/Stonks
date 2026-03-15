const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, validateAssets } = require("../app/serve.js");

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
  it("returns null for empty object", () => {
    assert.equal(validateConfig({}), null);
  });

  it("returns null for full valid config", () => {
    assert.equal(
      validateConfig({
        symbolOrder: ["VTI", "VXUS"],
        chartColors: [{ fill: "#abc", stroke: "#def" }],
        exposure: {
          allocations: { VTI: { "US Stocks": 1.0 } },
          display: [{ name: "US Stocks", color: "#abc" }],
          tradeable: ["VTI"],
        },
      }),
      null,
    );
  });

  it("rejects string input", () => {
    assert.notEqual(validateConfig("hello"), null);
  });

  it("rejects array input", () => {
    assert.notEqual(validateConfig([]), null);
  });

  it("rejects null input", () => {
    assert.notEqual(validateConfig(null), null);
  });

  it("accepts chartColors as plain string values", () => {
    assert.equal(validateConfig({ chartColors: ["#abc", "#def"] }), null);
  });

  it("accepts chartColors as mixed string and object values", () => {
    assert.equal(validateConfig({ chartColors: ["#abc", { fill: "#def", stroke: "#ghi" }] }), null);
  });

  it("rejects chartColors with invalid string value", () => {
    assert.notEqual(validateConfig({ chartColors: ["notacolor"] }), null);
  });

  it("rejects chartColors entry missing fill", () => {
    assert.notEqual(validateConfig({ chartColors: [{ stroke: "#fff" }] }), null);
  });

  it("rejects chartColors entry missing stroke", () => {
    assert.notEqual(validateConfig({ chartColors: [{ fill: "#fff" }] }), null);
  });

  it("accepts colors as plain string values (legacy key)", () => {
    assert.equal(validateConfig({ colors: ["#abc", "#def"] }), null);
  });

  it("accepts colors as mixed string and object values (legacy key)", () => {
    assert.equal(validateConfig({ colors: ["#abc", { fill: "#def", stroke: "#ghi" }] }), null);
  });

  it("rejects colors with invalid string value (legacy key)", () => {
    assert.notEqual(validateConfig({ colors: ["notacolor"] }), null);
  });

  it("rejects colors entry missing fill (legacy key)", () => {
    assert.notEqual(validateConfig({ colors: [{ stroke: "#fff" }] }), null);
  });

  it("rejects colors entry missing stroke (legacy key)", () => {
    assert.notEqual(validateConfig({ colors: [{ fill: "#fff" }] }), null);
  });

  it("rejects symbolOrder with non-string entry", () => {
    assert.notEqual(validateConfig({ symbolOrder: ["VTI", 123] }), null);
  });

  it("rejects exposure.display entry missing name", () => {
    assert.notEqual(
      validateConfig({ exposure: { display: [{ color: "#abc" }] } }),
      null,
    );
  });

  it("rejects exposure.display entry missing color", () => {
    assert.notEqual(
      validateConfig({ exposure: { display: [{ name: "Bonds" }] } }),
      null,
    );
  });

  it("rejects exposure.tradeable with non-string entry", () => {
    assert.notEqual(
      validateConfig({ exposure: { tradeable: [42] } }),
      null,
    );
  });

  it("rejects allocations where fractions sum to 0.95", () => {
    assert.notEqual(
      validateConfig({
        exposure: { allocations: { VTI: { US: 0.5, Bonds: 0.45 } } },
      }),
      null,
    );
  });

  it("accepts allocations where fractions sum to 1.005 (within tolerance)", () => {
    assert.equal(
      validateConfig({
        exposure: { allocations: { VTI: { US: 1.005 } } },
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// validateAssets
// ---------------------------------------------------------------------------

describe("validateAssets", () => {
  it("returns null for empty array", () => {
    assert.equal(validateAssets([]), null);
  });

  it("returns null for valid mortgage", () => {
    assert.equal(
      validateAssets([
        {
          type: "mortgage",
          name: "Home",
          purchaseDate: "2020-01-01",
          homeValue: 500000,
          downPayment: 100000,
          loanTermYears: 30,
          annualRate: 0.035,
        },
      ]),
      null,
    );
  });

  it("returns null for valid ibond", () => {
    assert.equal(
      validateAssets([
        {
          type: "ibond",
          name: "iBond",
          purchaseDate: "2021-01-01",
          purchaseValue: 10000,
          fixedRate: 0.0,
          rates: [],
        },
      ]),
      null,
    );
  });

  it("returns null for valid margin_loan", () => {
    assert.equal(
      validateAssets([{ type: "margin_loan", name: "Margin", balances: [] }]),
      null,
    );
  });

  it("rejects non-array object", () => {
    assert.notEqual(validateAssets({}), null);
  });

  it("rejects null", () => {
    assert.notEqual(validateAssets(null), null);
  });

  it("rejects string", () => {
    assert.notEqual(validateAssets("[]"), null);
  });

  it("rejects entry missing type", () => {
    assert.notEqual(validateAssets([{ name: "Home" }]), null);
  });

  it("rejects entry missing name", () => {
    assert.notEqual(validateAssets([{ type: "mortgage" }]), null);
  });

  it("rejects mortgage missing homeValue", () => {
    assert.notEqual(
      validateAssets([
        {
          type: "mortgage",
          name: "Home",
          purchaseDate: "2020-01-01",
          downPayment: 100000,
          loanTermYears: 30,
          annualRate: 0.035,
        },
      ]),
      null,
    );
  });

  it("rejects ibond missing rates", () => {
    assert.notEqual(
      validateAssets([
        {
          type: "ibond",
          name: "B",
          purchaseDate: "2021-01-01",
          purchaseValue: 10000,
          fixedRate: 0.0,
        },
      ]),
      null,
    );
  });

  it("rejects margin_loan with balances as non-array", () => {
    assert.notEqual(
      validateAssets([{ type: "margin_loan", name: "M", balances: "oops" }]),
      null,
    );
  });

  it("rejects unknown type savings", () => {
    assert.notEqual(
      validateAssets([{ type: "savings", name: "Bank" }]),
      null,
    );
  });
});
