const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { MONTHS, fmtDollar, fmtShort, fmtDate, fmtDateLong, fmtShares } = require("../app/js/fmt.js");

describe("MONTHS", () => {
  it("has 12 entries", () => {
    assert.equal(MONTHS.length, 12);
  });

  it("starts with Jan and ends with Dec", () => {
    assert.equal(MONTHS[0], "Jan");
    assert.equal(MONTHS[11], "Dec");
  });
});

describe("fmtDollar", () => {
  it("formats whole numbers with 2 decimal places", () => {
    assert.equal(fmtDollar(1000), "$1,000.00");
  });

  it("formats fractional amounts", () => {
    assert.equal(fmtDollar(1234.5), "$1,234.50");
  });

  it("formats zero", () => {
    assert.equal(fmtDollar(0), "$0.00");
  });

  it("formats negative numbers", () => {
    // toLocaleString puts $ before the minus sign in Node
    assert.equal(fmtDollar(-500.25), "$-500.25");
  });

  it("uses thousands separators", () => {
    assert.equal(fmtDollar(1000000), "$1,000,000.00");
  });
});

describe("fmtShort", () => {
  it("formats millions with M suffix", () => {
    assert.equal(fmtShort(1500000), "$1.5M");
  });

  it("formats thousands with k suffix", () => {
    assert.equal(fmtShort(50000), "$50k");
  });

  it("formats small numbers without suffix", () => {
    assert.equal(fmtShort(500), "$500");
  });

  it("formats exactly 1M", () => {
    assert.equal(fmtShort(1000000), "$1.0M");
  });

  it("formats exactly 1k", () => {
    assert.equal(fmtShort(1000), "$1k");
  });
});

describe("fmtDate", () => {
  it("formats YYYY-MM-DD as Mon 'YY", () => {
    assert.equal(fmtDate("2024-01-15"), "Jan '24");
  });

  it("handles December", () => {
    assert.equal(fmtDate("2023-12-01"), "Dec '23");
  });

  it("handles single-digit months", () => {
    assert.equal(fmtDate("2024-03-05"), "Mar '24");
  });
});

describe("fmtDateLong", () => {
  it("formats YYYY-MM-DD as Mon DD, YYYY", () => {
    assert.equal(fmtDateLong("2024-01-15"), "Jan 15, 2024");
  });

  it("strips leading zeros from day", () => {
    assert.equal(fmtDateLong("2024-03-05"), "Mar 5, 2024");
  });

  it("handles last day of year", () => {
    assert.equal(fmtDateLong("2024-12-31"), "Dec 31, 2024");
  });
});

describe("fmtShares", () => {
  it("formats whole numbers without decimal places", () => {
    assert.equal(fmtShares(100), "100");
  });

  it("formats large whole numbers with separators", () => {
    assert.equal(fmtShares(10000), "10,000");
  });

  it("formats fractional shares with 2-4 decimal places", () => {
    const result = fmtShares(3.1415);
    assert.ok(result.includes("3.14"), `Expected "3.14" in "${result}"`);
  });

  it("formats shares with exactly 2 decimal places", () => {
    const result = fmtShares(10.50);
    assert.equal(result, "10.50");
  });
});
