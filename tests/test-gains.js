const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeGains } = require("../app/js/gains.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function market(...prices) {
  // prices: [{date, sym, price}, ...]
  // Returns market rows grouped by date
  const byDate = {};
  for (const { date, sym, price } of prices) {
    if (!byDate[date]) byDate[date] = { timestamp: date + " 16:00" };
    byDate[date][sym] = String(price);
  }
  return Object.values(byDate).sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : 1
  );
}

function buy(date, symbol, price, quantity) {
  return { date, symbol, price: String(price), quantity: String(quantity) };
}

function sell(date, symbol, price, quantity, lotDate) {
  const tx = { date, symbol, price: String(price), quantity: String(-Math.abs(quantity)) };
  if (lotDate) tx.lotDate = lotDate;
  return tx;
}

function close(val) {
  return Math.abs(val) < 0.0001;
}

// ---------------------------------------------------------------------------
// FIFO — baseline (no lotDate)
// ---------------------------------------------------------------------------

describe("computeGains FIFO baseline", () => {
  it("produces no realized gains with only buys", () => {
    const trades = [buy("2024-01-01", "VTI", 100, 10)];
    const mkt = market({ date: "2024-01-02", sym: "VTI", price: 110 });
    const { realized, unrealized } = computeGains(trades, mkt);
    assert.equal(realized.length, 0);
    assert.equal(unrealized.length, 1);
    assert.ok(close(unrealized[0].gain - 100)); // 10*(110-100)
  });

  it("FIFO consumes the oldest lot first", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),  // lot A: cheap
      buy("2024-01-01", "VTI", 200, 10),  // lot B: expensive
      sell("2024-06-01", "VTI", 250, 5),  // should consume lot A @ 100
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 250 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(close(realized[0].costBasis - 500));   // 5 * 100
    assert.ok(close(realized[0].proceeds - 1250));   // 5 * 250
    assert.ok(close(realized[0].gain - 750));
  });

  it("FIFO spans multiple lots when sell exceeds first lot", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 3),
      buy("2024-01-01", "VTI", 200, 10),
      sell("2024-06-01", "VTI", 250, 8),  // 3 from lot A, 5 from lot B
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 250 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 2);
    // First realized entry: 3 shares from 2023 lot @ 100
    assert.ok(close(realized[0].costBasis - 300));
    assert.ok(close(realized[0].gain - 450));  // 3*(250-100)
    // Second realized entry: 5 shares from 2024 lot @ 200
    assert.ok(close(realized[1].costBasis - 1000));
    assert.ok(close(realized[1].gain - 250));  // 5*(250-200)
  });

  it("long-term flag: holdDays > 365 is LT", () => {
    const trades = [
      buy("2022-01-01", "VTI", 100, 5),
      sell("2023-06-01", "VTI", 150, 5), // 516 days
    ];
    const mkt = market({ date: "2023-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.equal(realized[0].isLongTerm, true);
    assert.ok(realized[0].holdDays > 365);
  });

  it("short-term flag: holdDays <= 365 is ST", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),
      sell("2024-06-01", "VTI", 120, 5), // 152 days
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 120 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.equal(realized[0].isLongTerm, false);
    assert.ok(realized[0].holdDays <= 365);
  });
});

// ---------------------------------------------------------------------------
// Specific-ID — basic cases
// ---------------------------------------------------------------------------

describe("computeGains specific-ID basic", () => {
  it("lotDate picks second lot instead of FIFO first lot", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),  // lot A (cheaper, older)
      buy("2024-01-01", "VTI", 200, 10),  // lot B (pricier, newer)
      sell("2024-06-01", "VTI", 250, 5, "2024-01-01"),  // specific-ID: use lot B
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 250 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(!realized[0].warning);
    assert.ok(close(realized[0].costBasis - 1000));  // 5 * 200 (lot B's price)
    assert.ok(close(realized[0].proceeds - 1250));   // 5 * 250
    assert.ok(close(realized[0].gain - 250));         // 5 * (250 - 200)
  });

  it("lotDate uses the older lot explicitly (skipping newer FIFO order)", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      buy("2024-01-01", "VTI", 200, 10),
      sell("2024-06-01", "VTI", 90, 5, "2024-01-01"),  // sell newer lot at a loss
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 90 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(close(realized[0].gain - (5 * (90 - 200))));  // -550
    assert.ok(realized[0].gain < 0);
  });

  it("lotDate correctly computes holdDays and isLongTerm", () => {
    const trades = [
      buy("2022-01-01", "VTI", 100, 10),  // lot A: would be LT by mid-2023
      buy("2024-01-01", "VTI", 200, 10),  // lot B: ST
      // Sell from lot A (LT)
      sell("2023-06-01", "VTI", 150, 5, "2022-01-01"),
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(!realized[0].warning);
    assert.equal(realized[0].isLongTerm, true);
    assert.ok(realized[0].holdDays > 365);
  });

  it("lotDate sell short-term even when an older lot exists", () => {
    const trades = [
      buy("2022-01-01", "VTI", 100, 10),  // lot A: would be LT
      buy("2024-01-01", "VTI", 200, 10),  // lot B: ST
      // Explicitly pick the newer (ST) lot
      sell("2024-06-01", "VTI", 250, 5, "2024-01-01"),
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 250 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(!realized[0].warning);
    assert.equal(realized[0].isLongTerm, false);
  });

  it("specific-ID sell leaves other lots untouched for subsequent FIFO", () => {
    // Lot A: 10 shares @ 100
    // Lot B: 10 shares @ 200
    // Sell 5 from lot B via specific-ID → lot A still has 10, lot B has 5
    // Then FIFO sell 5 → consumes lot A
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      buy("2024-01-01", "VTI", 200, 10),
      sell("2024-06-01", "VTI", 250, 5, "2024-01-01"),  // specific-ID: lot B
      sell("2024-07-01", "VTI", 260, 5),                 // FIFO: should hit lot A
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 260 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 2);
    // First sell: lot B @ 200
    assert.ok(close(realized[0].costBasis - 1000));
    // Second sell (FIFO): lot A @ 100
    assert.ok(close(realized[1].costBasis - 500));
  });
});

// ---------------------------------------------------------------------------
// Specific-ID — multiple buys on the same lotDate
// ---------------------------------------------------------------------------

describe("computeGains specific-ID same-date lots", () => {
  it("consumes multiple same-date lots in array order until quantity satisfied", () => {
    // Two buys on the same date → treated as separate lots
    const trades = [
      buy("2024-01-01", "VTI", 100, 3),  // lot A: 3 shares
      buy("2024-01-01", "VTI", 110, 4),  // lot B: 4 shares (same date)
      sell("2024-06-01", "VTI", 150, 5, "2024-01-01"),  // needs 5: takes all of A, 2 of B
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, mkt);
    // Should produce two realized entries (one per lot consumed), no warnings
    assert.equal(realized.filter(r => r.warning).length, 0);
    const totalShares = realized.reduce((s, r) => s + r.shares, 0);
    assert.ok(close(totalShares - 5));
    // First lot: 3 shares @ 100 → gain = 3*(150-100) = 150
    assert.ok(close(realized[0].costBasis - 300));
    // Second lot: 2 shares @ 110 → gain = 2*(150-110) = 80
    assert.ok(close(realized[1].costBasis - 220));
  });

  it("exact match on same-date lots leaves the rest intact", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),
      buy("2024-01-01", "VTI", 120, 5),
      sell("2024-06-01", "VTI", 150, 5, "2024-01-01"),  // exactly drains first lot
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized, unrealized } = computeGains(trades, mkt);
    assert.equal(realized.filter(r => r.warning).length, 0);
    const totalRealized = realized.reduce((s, r) => s + r.shares, 0);
    assert.ok(close(totalRealized - 5));
    // 5 shares remain in second lot
    assert.ok(unrealized.some(u => u.symbol === "VTI" && close(u.shares - 5)));
  });
});

// ---------------------------------------------------------------------------
// Specific-ID — warning: no lot found
// ---------------------------------------------------------------------------

describe("computeGains specific-ID warning: no lot found", () => {
  it("emits warning when lotDate does not match any buy", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),
      sell("2024-06-01", "VTI", 150, 5, "2023-01-01"),  // no buy on 2023-01-01
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(realized[0].warning);
    assert.ok(realized[0].warning.includes("No lot found"));
    assert.ok(realized[0].warning.includes("2023-01-01"));
  });

  it("warning row has gain: 0 so it doesn't affect summary totals", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),
      sell("2024-06-01", "VTI", 150, 5, "1999-01-01"),  // bad lotDate
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized, summary } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(realized[0].warning);
    assert.equal(realized[0].gain, 0);
    assert.equal(realized[0].costBasis, 0);
    // Summary should not count the bad row's proceeds as a gain
    assert.equal(summary.stRealizedThisYear, 0);
    assert.equal(summary.ltRealizedThisYear, 0);
  });

  it("warning row has holdDays: null and isLongTerm: null", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),
      sell("2024-06-01", "VTI", 150, 5, "1999-01-01"),
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized[0].holdDays, null);
    assert.equal(realized[0].isLongTerm, null);
  });

  it("correct symbol and date still present on warning row", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),
      sell("2024-06-01", "VTI", 150, 5, "1999-01-01"),
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized[0].date, "2024-06-01");
    assert.equal(realized[0].symbol, "VTI");
  });
});

// ---------------------------------------------------------------------------
// Specific-ID — warning: insufficient shares in lot
// ---------------------------------------------------------------------------

describe("computeGains specific-ID warning: insufficient shares", () => {
  it("emits warning when lot exists but doesn't have enough shares", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 3),   // only 3 shares in this lot
      sell("2024-06-01", "VTI", 150, 5, "2024-01-01"),  // wants 5
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, mkt);
    // One normal entry for the 3 shares consumed, one warning for the 2 short
    const normal = realized.filter(r => !r.warning);
    const warnings = realized.filter(r => r.warning);
    assert.equal(normal.length, 1);
    assert.equal(warnings.length, 1);
    assert.ok(close(normal[0].shares - 3));
    assert.ok(warnings[0].warning.includes("insufficient shares"));
    assert.ok(warnings[0].warning.includes("2.0000"));
  });

  it("insufficient-shares warning has gain: 0", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 2),
      sell("2024-06-01", "VTI", 150, 5, "2024-01-01"),
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized } = computeGains(trades, mkt);
    const warn = realized.find(r => r.warning);
    assert.ok(warn);
    assert.equal(warn.gain, 0);
    assert.equal(warn.costBasis, 0);
  });

  it("partial lot consumption then warning doesn't pollute summary", () => {
    const year = new Date().getFullYear();
    const trades = [
      buy(`${year}-01-01`, "VTI", 100, 2),
      sell(`${year}-06-01`, "VTI", 150, 5, `${year}-01-01`),
    ];
    const mkt = market({ date: `${year}-12-31`, sym: "VTI", price: 150 });
    const { realized, summary } = computeGains(trades, mkt);
    // Only the 2-share normal entry should contribute to summary
    const normalGain = 2 * (150 - 100);  // = 100
    assert.ok(close(summary.stRealizedThisYear - normalGain));
  });
});

// ---------------------------------------------------------------------------
// Specific-ID — lot state management
// ---------------------------------------------------------------------------

describe("computeGains specific-ID lot state", () => {
  it("specific-ID depletes a lot so subsequent sells cannot use it", () => {
    // Lot: 5 shares
    // Sell 5 via specific-ID → lot fully consumed
    // Another specific-ID sell targeting the same date → no-lot warning
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),
      sell("2024-06-01", "VTI", 150, 5, "2024-01-01"),  // fully consumes lot
      sell("2024-07-01", "VTI", 160, 2, "2024-01-01"),  // lot is gone → warning
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 160 });
    const { realized } = computeGains(trades, mkt);
    const normal = realized.filter(r => !r.warning);
    const warnings = realized.filter(r => r.warning);
    assert.equal(normal.length, 1);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].warning.includes("No lot found"));
  });

  it("specific-ID partial depletion leaves remainder for FIFO", () => {
    // Lot A: 10 shares. Sell 3 via specific-ID. FIFO sell 5 should see 7 remaining in lot A.
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),
      sell("2024-06-01", "VTI", 150, 3, "2024-01-01"),  // specific-ID: 3 consumed
      sell("2024-07-01", "VTI", 160, 5),                  // FIFO: 5 from remaining 7
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 160 });
    const { realized, unrealized } = computeGains(trades, mkt);
    assert.equal(realized.filter(r => r.warning).length, 0);
    // 3 remaining shares (10 - 3 - 5 = 2... wait: 10 - 3 - 5 = 2)
    assert.ok(unrealized.some(u => u.symbol === "VTI" && close(u.shares - 2)));
  });

  it("specific-ID on one symbol doesn't affect other symbol lots", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),
      buy("2024-01-01", "BND", 50, 20),
      sell("2024-06-01", "VTI", 150, 5, "2024-01-01"),
    ];
    const mkt = market(
      { date: "2024-12-31", sym: "VTI", price: 150 },
      { date: "2024-12-31", sym: "BND", price: 55 }
    );
    const { realized, unrealized } = computeGains(trades, mkt);
    assert.equal(realized.filter(r => r.warning).length, 0);
    // BND untouched: 20 shares
    const bnd = unrealized.find(u => u.symbol === "BND");
    assert.ok(bnd && close(bnd.shares - 20));
  });
});

// ---------------------------------------------------------------------------
// Specific-ID — mixed with FIFO in same transaction log
// ---------------------------------------------------------------------------

describe("computeGains specific-ID mixed with FIFO", () => {
  it("FIFO and specific-ID sells on same symbol coexist correctly", () => {
    // Lot A: 10 shares @ 100 (2023-01-01)
    // Lot B: 10 shares @ 200 (2024-01-01)
    // Specific-ID sell 5 from lot B → lot B has 5 left
    // FIFO sell 5 → takes from lot A (oldest)
    // FIFO sell 5 → takes remaining 5 from lot A
    // Specific-ID sell 5 from lot B → takes remaining 5 from lot B
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      buy("2024-01-01", "VTI", 200, 10),
      sell("2024-06-01", "VTI", 250, 5, "2024-01-01"),  // specific-ID: lot B
      sell("2024-07-01", "VTI", 260, 5),                  // FIFO: lot A (5 of 10)
      sell("2024-08-01", "VTI", 270, 5),                  // FIFO: lot A (remaining 5)
      sell("2024-09-01", "VTI", 280, 5, "2024-01-01"),  // specific-ID: lot B (remaining 5)
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 280 });
    const { realized, unrealized } = computeGains(trades, mkt);
    assert.equal(realized.filter(r => r.warning).length, 0);
    assert.equal(realized.length, 4);
    // All 20 shares sold; nothing left
    const vti = unrealized.find(u => u.symbol === "VTI");
    assert.ok(!vti || vti.shares < 1e-6);
    // Check cost bases
    // Sell 1: 5 shares @ 200 = $1000 cost
    assert.ok(close(realized[0].costBasis - 1000));
    // Sell 2: 5 shares @ 100 = $500 cost
    assert.ok(close(realized[1].costBasis - 500));
    // Sell 3: 5 shares @ 100 = $500 cost
    assert.ok(close(realized[2].costBasis - 500));
    // Sell 4: 5 shares @ 200 = $1000 cost
    assert.ok(close(realized[3].costBasis - 1000));
  });

  it("no lotDate sell is unaffected by preceding specific-ID sell on different date", () => {
    const trades = [
      buy("2023-06-01", "VTI", 80, 5),
      buy("2024-01-01", "VTI", 100, 5),
      sell("2024-06-01", "VTI", 120, 3, "2024-01-01"),  // specific-ID: newer lot
      sell("2024-07-01", "VTI", 130, 3),                  // FIFO: older lot
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 130 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.filter(r => r.warning).length, 0);
    // FIFO sell should hit the 2023-06-01 lot @ 80
    const fifo = realized[1];
    assert.ok(close(fifo.costBasis - 3 * 80));
  });
});

// ---------------------------------------------------------------------------
// Summary totals
// ---------------------------------------------------------------------------

describe("computeGains summary totals", () => {
  it("warning rows do not inflate summary totals", () => {
    const year = new Date().getFullYear();
    const trades = [
      buy(`${year}-01-01`, "VTI", 100, 5),
      buy(`${year}-02-01`, "VTI", 120, 5),
      sell(`${year}-06-01`, "VTI", 150, 3, `${year}-02-01`),  // valid: gain = 3*(150-120) = 90
      sell(`${year}-07-01`, "VTI", 160, 3, "1990-01-01"),      // invalid lotDate → warning row
    ];
    const mkt = market({ date: `${year}-12-31`, sym: "VTI", price: 160 });
    const { summary } = computeGains(trades, mkt);
    // Only the valid sell (ST gain = 90) should be in summary
    assert.ok(close(summary.stRealizedThisYear - 90));
    assert.equal(summary.ltRealizedThisYear, 0);
  });

  it("LT specific-ID gains land in ltRealizedThisYear", () => {
    const year = new Date().getFullYear();
    const buyYear = year - 2;
    const trades = [
      buy(`${buyYear}-01-01`, "VTI", 100, 10),
      sell(`${year}-06-01`, "VTI", 150, 5, `${buyYear}-01-01`),  // LT: > 365 days
    ];
    const mkt = market({ date: `${year}-12-31`, sym: "VTI", price: 150 });
    const { realized, summary } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.equal(realized[0].isLongTerm, true);
    assert.ok(close(summary.ltRealizedThisYear - 250));  // 5*(150-100)
    assert.equal(summary.stRealizedThisYear, 0);
  });
});

// ---------------------------------------------------------------------------
// Donations — FIFO
// ---------------------------------------------------------------------------

function donate(date, symbol, price, quantity, lotDate) {
  // New format: positive quantity, direction conveyed by type
  const tx = { date, symbol, price: String(price), quantity: String(Math.abs(quantity)), type: "donate" };
  if (lotDate) tx.lotDate = lotDate;
  return tx;
}

function typedSell(date, symbol, price, quantity, lotDate) {
  // New format: positive quantity with type: "sell"
  const tx = { date, symbol, price: String(price), quantity: String(Math.abs(quantity)), type: "sell" };
  if (lotDate) tx.lotDate = lotDate;
  return tx;
}

describe("computeGains donations FIFO", () => {
  it("donation does not appear in realized", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      donate("2025-06-01", "VTI", 245, 5),
    ];
    const mkt = market({ date: "2025-12-31", sym: "VTI", price: 245 });
    const { realized, donated } = computeGains(trades, mkt);
    assert.equal(realized.length, 0);
    assert.equal(donated.length, 1);
  });

  it("donation appears in donated with correct FMV and cost basis (FIFO)", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      donate("2025-06-01", "VTI", 245, 5),
    ];
    const mkt = market({ date: "2025-12-31", sym: "VTI", price: 245 });
    const { donated } = computeGains(trades, mkt);
    assert.equal(donated.length, 1);
    assert.ok(close(donated[0].costBasis - 500));   // 5 * 100
    assert.ok(close(donated[0].fmv - 245));
    assert.ok(close(donated[0].fmvTotal - 1225));   // 5 * 245
    assert.ok(close(donated[0].gain - 725));         // 1225 - 500
    assert.equal(donated[0].symbol, "VTI");
    assert.equal(donated[0].date, "2025-06-01");
    assert.equal(donated[0].shares, 5);
  });

  it("donation consumes correct lot (FIFO — oldest first)", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),  // lot A
      buy("2024-01-01", "VTI", 200, 10),  // lot B
      donate("2025-06-01", "VTI", 245, 5),
    ];
    const mkt = market({ date: "2025-12-31", sym: "VTI", price: 245 });
    const { donated, unrealized } = computeGains(trades, mkt);
    assert.equal(donated.length, 1);
    assert.ok(close(donated[0].costBasis - 500));  // 5 shares from lot A @ 100
    // 15 shares remain (5 from lot A + 10 from lot B)
    const vti = unrealized.find(u => u.symbol === "VTI");
    assert.ok(vti && close(vti.shares - 15));
  });

  it("donation does not contribute to realized summary totals", () => {
    const year = new Date().getFullYear();
    const trades = [
      buy(`${year - 2}-01-01`, "VTI", 100, 10),
      donate(`${year}-06-01`, "VTI", 245, 5),
    ];
    const mkt = market({ date: `${year}-12-31`, sym: "VTI", price: 245 });
    const { summary } = computeGains(trades, mkt);
    assert.equal(summary.stRealizedThisYear, 0);
    assert.equal(summary.ltRealizedThisYear, 0);
  });

  it("donation sets isLongTerm based on hold days", () => {
    const trades = [
      buy("2022-01-01", "VTI", 100, 10),
      donate("2025-06-01", "VTI", 245, 5),
    ];
    const mkt = market({ date: "2025-12-31", sym: "VTI", price: 245 });
    const { donated } = computeGains(trades, mkt);
    assert.equal(donated[0].isLongTerm, true);
    assert.ok(donated[0].holdDays > 365);
  });

  it("remaining unrealized reflects consumed donation lot", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      donate("2025-06-01", "VTI", 245, 4),
    ];
    const mkt = market({ date: "2025-12-31", sym: "VTI", price: 245 });
    const { unrealized } = computeGains(trades, mkt);
    const vti = unrealized.find(u => u.symbol === "VTI");
    assert.ok(vti && close(vti.shares - 6));
  });
});

// ---------------------------------------------------------------------------
// Donations — specific-ID
// ---------------------------------------------------------------------------

describe("computeGains donations specific-ID", () => {
  it("donation with lotDate consumes the specified lot", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),  // lot A (cheap)
      buy("2024-01-01", "VTI", 200, 10),  // lot B (expensive)
      donate("2025-06-01", "VTI", 245, 5, "2024-01-01"),  // donate lot B
    ];
    const mkt = market({ date: "2025-12-31", sym: "VTI", price: 245 });
    const { donated, unrealized } = computeGains(trades, mkt);
    assert.equal(donated.length, 1);
    assert.ok(close(donated[0].costBasis - 1000));  // 5 * 200 (lot B)
    // 15 shares remain (10 from lot A + 5 from lot B)
    const vti = unrealized.find(u => u.symbol === "VTI");
    assert.ok(vti && close(vti.shares - 15));
  });

  it("specific-ID donation does not appear in realized", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      donate("2025-06-01", "VTI", 245, 5, "2023-01-01"),
    ];
    const mkt = market({ date: "2025-12-31", sym: "VTI", price: 245 });
    const { realized, donated } = computeGains(trades, mkt);
    assert.equal(realized.length, 0);
    assert.equal(donated.length, 1);
  });

  it("donation and sell on same symbol coexist independently", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      buy("2024-01-01", "VTI", 200, 10),
      sell("2025-01-01", "VTI", 220, 3),               // FIFO sell from lot A
      donate("2025-06-01", "VTI", 245, 5, "2024-01-01"),  // donate from lot B
    ];
    const mkt = market({ date: "2025-12-31", sym: "VTI", price: 245 });
    const { realized, donated, unrealized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.equal(donated.length, 1);
    assert.ok(close(realized[0].costBasis - 300));   // 3 * 100 (lot A)
    assert.ok(close(donated[0].costBasis - 1000));  // 5 * 200 (lot B)
    // Remaining: 7 from lot A + 5 from lot B = 12
    const vti = unrealized.find(u => u.symbol === "VTI");
    assert.ok(vti && close(vti.shares - 12));
  });
});

// ---------------------------------------------------------------------------
// Typed trades — type: "sell" and type: "buy" with positive quantities
// ---------------------------------------------------------------------------

describe("computeGains typed sells (type:sell, positive qty)", () => {
  it("type:sell with positive qty is treated identically to legacy negative qty sell", () => {
    const legacyTrades = [
      buy("2023-01-01", "VTI", 100, 10),
      sell("2024-06-01", "VTI", 250, 5),
    ];
    const typedTrades = [
      buy("2023-01-01", "VTI", 100, 10),
      typedSell("2024-06-01", "VTI", 250, 5),
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 250 });
    const legacy = computeGains(legacyTrades, mkt);
    const typed = computeGains(typedTrades, mkt);
    assert.equal(typed.realized.length, legacy.realized.length);
    assert.ok(Math.abs(typed.realized[0].gain - legacy.realized[0].gain) < 0.001);
    assert.ok(Math.abs(typed.realized[0].costBasis - legacy.realized[0].costBasis) < 0.001);
  });

  it("type:sell with lotDate uses specific-ID correctly", () => {
    const trades = [
      buy("2023-01-01", "VTI", 100, 10),
      buy("2024-01-01", "VTI", 200, 10),
      typedSell("2024-06-01", "VTI", 250, 5, "2024-01-01"),
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 250 });
    const { realized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(Math.abs(realized[0].costBasis - 1000) < 0.001);  // lot B @ 200
  });

  it("type:buy with positive qty adds to position correctly", () => {
    const trades = [
      { date: "2023-01-01", symbol: "VTI", price: "100", quantity: "10", type: "buy" },
      typedSell("2024-06-01", "VTI", 150, 5),
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 150 });
    const { realized, unrealized } = computeGains(trades, mkt);
    assert.equal(realized.length, 1);
    assert.ok(Math.abs(realized[0].gain - 250) < 0.001);  // 5*(150-100)
    const vti = unrealized.find(u => u.symbol === "VTI");
    assert.ok(vti && Math.abs(vti.shares - 5) < 0.001);  // 5 shares remain
  });
});

// ---------------------------------------------------------------------------
// validateTrades — lotDate field
// ---------------------------------------------------------------------------

const { validateTrades, normalizeTrades } = require("../app/serve.js");

describe("validateTrades lotDate field", () => {
  const base = { date: "2024-06-01", symbol: "VTI", price: "150", quantity: "-5" };

  it("accepts a valid lotDate in YYYY-MM-DD format", () => {
    assert.equal(validateTrades([{ ...base, lotDate: "2024-01-01" }]), null);
  });

  it("accepts missing lotDate (undefined)", () => {
    assert.equal(validateTrades([{ ...base }]), null);
  });

  it("accepts empty string lotDate (treated as absent)", () => {
    assert.equal(validateTrades([{ ...base, lotDate: "" }]), null);
  });

  it("rejects lotDate with wrong separator", () => {
    const err = validateTrades([{ ...base, lotDate: "2024/01/01" }]);
    assert.ok(err);
    assert.match(err, /Row 1.*lotDate/);
  });

  it("rejects lotDate with wrong order (MM-DD-YYYY)", () => {
    const err = validateTrades([{ ...base, lotDate: "01-01-2024" }]);
    assert.ok(err);
    assert.match(err, /lotDate/);
  });

  it("rejects lotDate that is not a date at all", () => {
    const err = validateTrades([{ ...base, lotDate: "not-a-date" }]);
    assert.ok(err);
    assert.match(err, /lotDate/);
  });

  it("rejects lotDate with extra characters", () => {
    const err = validateTrades([{ ...base, lotDate: "2024-01-01T00:00:00" }]);
    assert.ok(err);
    assert.match(err, /lotDate/);
  });

  it("reports correct row number for lotDate error in second row", () => {
    const row1 = { date: "2024-01-01", symbol: "VTI", price: "100", quantity: "10" };
    const row2 = { ...base, lotDate: "bad" };
    const err = validateTrades([row1, row2]);
    assert.match(err, /Row 2/);
  });

  it("accepts lotDate on a buy row (field is ignored semantically but valid)", () => {
    const buyRow = { date: "2024-01-01", symbol: "VTI", price: "100", quantity: "10", lotDate: "2023-01-01" };
    assert.equal(validateTrades([buyRow]), null);
  });
});

// ---------------------------------------------------------------------------
// validateTrades — type field
// ---------------------------------------------------------------------------

describe("validateTrades type field", () => {
  const base = { date: "2024-06-01", symbol: "VTI", price: "245", quantity: "-5" };

  it("accepts type: donation", () => {
    assert.equal(validateTrades([{ ...base, type: "donate" }]), null);
  });

  it("accepts type: sell", () => {
    assert.equal(validateTrades([{ ...base, type: "sell" }]), null);
  });

  it("accepts type: buy", () => {
    assert.equal(validateTrades([{ ...base, type: "buy" }]), null);
  });

  it("accepts missing type (undefined)", () => {
    assert.equal(validateTrades([{ ...base }]), null);
  });

  it("accepts empty string type (treated as absent)", () => {
    assert.equal(validateTrades([{ ...base, type: "" }]), null);
  });

  it("rejects unknown type value", () => {
    const err = validateTrades([{ ...base, type: "transfer-out" }]);
    assert.ok(err);
    assert.match(err, /Row 1.*type/);
  });

  it("rejects type with wrong casing", () => {
    const err = validateTrades([{ ...base, type: "Donate" }]);
    assert.ok(err);
    assert.match(err, /type/);
  });

  it("reports correct row number for type error in second row", () => {
    const row1 = { date: "2024-01-01", symbol: "VTI", price: "100", quantity: "10" };
    const row2 = { ...base, type: "bad" };
    const err = validateTrades([row1, row2]);
    assert.match(err, /Row 2/);
  });
});

// ---------------------------------------------------------------------------
// normalizeTrades — type field
// ---------------------------------------------------------------------------

describe("normalizeTrades type field", () => {
  const base = { date: "2024-06-01", symbol: "VTI", price: "245", quantity: "-5" };
  const basePosQty = { date: "2024-06-01", symbol: "VTI", price: "245", quantity: "5" };

  it("preserves type: donation and stores positive quantity", () => {
    const [h] = normalizeTrades([{ ...base, type: "donate" }]);
    assert.equal(h.type, "donate");
    assert.equal(h.quantity, "5");  // abs of -5
  });

  it("preserves type: sell and stores positive quantity", () => {
    const [h] = normalizeTrades([{ ...base, type: "sell" }]);
    assert.equal(h.type, "sell");
    assert.equal(h.quantity, "5");  // abs of -5
  });

  it("preserves type: buy and stores positive quantity", () => {
    const [h] = normalizeTrades([{ ...basePosQty, type: "buy" }]);
    assert.equal(h.type, "buy");
    assert.equal(h.quantity, "5");
  });

  it("type:buy with negative input quantity stores positive quantity", () => {
    const [h] = normalizeTrades([{ ...base, type: "buy" }]);
    assert.equal(h.type, "buy");
    assert.equal(h.quantity, "5");  // abs of -5
  });

  it("omits type key and preserves signed quantity when type is absent", () => {
    const [h] = normalizeTrades([base]);
    assert.ok(!Object.hasOwn(h, "type"), "type key should not be present");
    assert.equal(h.quantity, "-5");  // signed preserved
  });

  it("omits type key and preserves signed quantity when type is empty string", () => {
    const [h] = normalizeTrades([{ ...base, type: "" }]);
    assert.ok(!Object.hasOwn(h, "type"), "type key should not be present");
    assert.equal(h.quantity, "-5");  // signed preserved
  });
});

// ---------------------------------------------------------------------------
// Unrealized gains ST/LT breakdown fields
// ---------------------------------------------------------------------------

describe("computeGains unrealized ST/LT breakdown (FIFO)", () => {
  // ── Pure short-term ──────────────────────────────────────────────────────

  it("all-ST symbol: stShares equals totalShares, ltShares is 0", () => {
    const trades = [buy("2025-12-01", "VTI", 100, 10)];
    const mkt = market({ date: "2026-01-01", sym: "VTI", price: 120 });
    const { unrealized } = computeGains(trades, mkt);
    const u = unrealized.find(x => x.symbol === "VTI");
    assert.ok(u, "unrealized entry exists");
    assert.equal(u.isLongTerm, false);
    assert.ok(close(u.stShares - 10));
    assert.ok(close(u.ltShares - 0));
    assert.ok(close(u.stCost - 1000));   // 10 * 100
    assert.ok(close(u.ltCost - 0));
    assert.ok(close(u.stGain - 200));    // 10 * (120 - 100)
    assert.ok(close(u.ltGain - 0));
  });

  // ── Pure long-term ───────────────────────────────────────────────────────

  it("all-LT symbol: ltShares equals totalShares, stShares is 0", () => {
    const trades = [buy("2020-01-01", "VTI", 100, 10)];
    const mkt = market({ date: "2026-01-01", sym: "VTI", price: 200 });
    const { unrealized } = computeGains(trades, mkt);
    const u = unrealized.find(x => x.symbol === "VTI");
    assert.ok(u);
    assert.equal(u.isLongTerm, true);
    assert.ok(close(u.ltShares - 10));
    assert.ok(close(u.stShares - 0));
    assert.ok(close(u.ltCost - 1000));   // 10 * 100
    assert.ok(close(u.stCost - 0));
    assert.ok(close(u.ltGain - 1000));   // 10 * (200 - 100)
    assert.ok(close(u.stGain - 0));
  });

  // ── Mixed: basic two-lot split ───────────────────────────────────────────

  it("mixed symbol: correctly splits stShares/ltShares between two lots", () => {
    // Lot A: 10 @ $100, bought 2020-01-01 (LT as of 2026-01-01: ~2192 days)
    // Lot B: 5  @ $150, bought 2025-12-01 (ST as of 2026-01-01: ~31 days)
    const trades = [
      buy("2020-01-01", "VTI", 100, 10),
      buy("2025-12-01", "VTI", 150, 5),
    ];
    const mkt = market({ date: "2026-01-01", sym: "VTI", price: 200 });
    const { unrealized } = computeGains(trades, mkt);
    const u = unrealized.find(x => x.symbol === "VTI");
    assert.ok(u);
    assert.equal(u.isLongTerm, null, "isLongTerm should be null (mixed)");
    assert.ok(close(u.shares - 15));
    assert.ok(close(u.ltShares - 10));
    assert.ok(close(u.stShares - 5));
    assert.ok(close(u.ltCost - 1000));  // 10 * 100
    assert.ok(close(u.stCost - 750));   // 5 * 150
    assert.ok(close(u.ltGain - 1000));  // 10 * (200 - 100)
    assert.ok(close(u.stGain - 250));   // 5 * (200 - 150)
    assert.ok(close(u.gain - 1250));    // sanity: ltGain + stGain
  });

  // ── stGain/ltGain sum to total gain ─────────────────────────────────────

  it("stGain + ltGain equals total gain for mixed symbol", () => {
    const trades = [
      buy("2018-06-01", "VTI", 80,  8),   // LT
      buy("2025-11-01", "VTI", 160, 4),   // ST
    ];
    const mkt = market({ date: "2026-01-01", sym: "VTI", price: 180 });
    const { unrealized } = computeGains(trades, mkt);
    const u = unrealized.find(x => x.symbol === "VTI");
    assert.ok(u);
    assert.equal(u.isLongTerm, null);
    const totalGainCheck = u.stGain + u.ltGain;
    assert.ok(close(totalGainCheck - u.gain),
      `stGain(${u.stGain}) + ltGain(${u.ltGain}) should equal gain(${u.gain})`);
  });

  // ── Mixed after partial FIFO sell ────────────────────────────────────────

  it("partial FIFO sell leaves correct ST/LT split in remaining unrealized", () => {
    // Lot A: 10 @ $100, 2020-01-01 (LT)
    // Lot B:  8 @ $120, 2021-01-01 (LT)
    // Lot C:  5 @ $150, 2025-12-01 (ST)
    // Sell 6 FIFO on 2022-06-01 → consumes 6 from Lot A (Lot A has 4 remaining)
    // Remaining: 4 (LT @ 100) + 8 (LT @ 120) + 5 (ST @ 150)
    const trades = [
      buy("2020-01-01", "VTI", 100, 10),
      buy("2021-01-01", "VTI", 120, 8),
      sell("2022-06-01", "VTI", 130, 6),  // FIFO: 6 from Lot A
      buy("2025-12-01", "VTI", 150, 5),
    ];
    const mkt = market({ date: "2026-01-01", sym: "VTI", price: 200 });
    const { unrealized } = computeGains(trades, mkt);
    const u = unrealized.find(x => x.symbol === "VTI");
    assert.ok(u);
    assert.equal(u.isLongTerm, null, "mixed");
    assert.ok(close(u.shares - 17));  // 4 + 8 + 5
    // LT: 4 shares @ 100 + 8 shares @ 120
    assert.ok(close(u.ltShares - 12));
    assert.ok(close(u.ltCost - (4 * 100 + 8 * 120)));   // 400 + 960 = 1360
    assert.ok(close(u.ltGain - (4 * (200 - 100) + 8 * (200 - 120))));  // 400 + 640 = 1040
    // ST: 5 shares @ 150
    assert.ok(close(u.stShares - 5));
    assert.ok(close(u.stCost - 750));
    assert.ok(close(u.stGain - 250));
  });

  // ── Complex: multiple buys, multiple partial sells ───────────────────────

  it("complex history: symbol bought and partially sold multiple times", () => {
    // Lot A: 20 @ $50,  2019-03-01 (LT by 2026-01-01)
    // Lot B: 10 @ $80,  2020-06-01 (LT)
    // Lot C: 15 @ $110, 2021-09-01 (LT)
    // Lot D: 12 @ $140, 2025-10-01 (ST: ~92 days to 2026-01-01)
    // Lot E:  6 @ $160, 2025-12-15 (ST: ~17 days)
    //
    // Sell 1: 8 FIFO on 2020-01-01 → 8 from Lot A (Lot A: 12 remaining)
    // Sell 2: specific-ID lotDate 2020-06-01, 4 shares on 2021-07-01 → 4 from Lot B (Lot B: 6 remaining)
    // Sell 3: 14 FIFO on 2022-04-01 → 12 from Lot A (exhausted), 2 from Lot B (Lot B: 4 remaining)
    //
    // Remaining lots as of 2026-01-01:
    //   Lot B: 4  @ $80  (LT)
    //   Lot C: 15 @ $110 (LT)
    //   Lot D: 12 @ $140 (ST)
    //   Lot E:  6 @ $160 (ST)
    const trades = [
      buy("2019-03-01", "VTI", 50,  20),
      buy("2020-06-01", "VTI", 80,  10),
      buy("2021-09-01", "VTI", 110, 15),
      sell("2020-01-01", "VTI", 60,  8),                  // FIFO: Lot A
      sell("2021-07-01", "VTI", 90,  4, "2020-06-01"),    // specific-ID: Lot B
      sell("2022-04-01", "VTI", 100, 14),                 // FIFO: 12 from Lot A, 2 from Lot B
      buy("2025-10-01", "VTI", 140, 12),
      buy("2025-12-15", "VTI", 160, 6),
    ];
    const mkt = market({ date: "2026-01-01", sym: "VTI", price: 200 });
    const { unrealized } = computeGains(trades, mkt);
    const u = unrealized.find(x => x.symbol === "VTI");
    assert.ok(u);
    assert.equal(u.isLongTerm, null, "mixed lots");

    const expectedLtShares = 4 + 15;   // 19
    const expectedStShares = 12 + 6;   // 18
    const expectedLtCost   = 4 * 80 + 15 * 110;   // 320 + 1650 = 1970
    const expectedStCost   = 12 * 140 + 6 * 160;  // 1680 + 960 = 2640
    const expectedLtGain   = 4 * (200 - 80) + 15 * (200 - 110);  // 480 + 1350 = 1830
    const expectedStGain   = 12 * (200 - 140) + 6 * (200 - 160); // 720 + 240 = 960

    assert.ok(close(u.shares - (expectedLtShares + expectedStShares)), `total shares: expected ${expectedLtShares + expectedStShares}`);
    assert.ok(close(u.ltShares - expectedLtShares), `ltShares: expected ${expectedLtShares}`);
    assert.ok(close(u.stShares - expectedStShares), `stShares: expected ${expectedStShares}`);
    assert.ok(close(u.ltCost - expectedLtCost),     `ltCost: expected ${expectedLtCost}`);
    assert.ok(close(u.stCost - expectedStCost),     `stCost: expected ${expectedStCost}`);
    assert.ok(close(u.ltGain - expectedLtGain),     `ltGain: expected ${expectedLtGain}`);
    assert.ok(close(u.stGain - expectedStGain),     `stGain: expected ${expectedStGain}`);
  });

  // ── Multiple symbols, independent ST/LT state ────────────────────────────

  it("multiple symbols each have independent ST/LT breakdown", () => {
    const trades = [
      buy("2020-01-01", "VTI", 100, 5),   // LT
      buy("2025-12-01", "VTI", 150, 3),   // ST  → VTI is mixed
      buy("2020-01-01", "BND", 50,  10),   // LT only → pure LT
      buy("2025-12-01", "VXUS", 80, 4),   // ST only → pure ST
    ];
    const mkt = market(
      { date: "2026-01-01", sym: "VTI",  price: 200 },
      { date: "2026-01-01", sym: "BND",  price: 60  },
      { date: "2026-01-01", sym: "VXUS", price: 90  }
    );
    const { unrealized } = computeGains(trades, mkt);

    const vti  = unrealized.find(x => x.symbol === "VTI");
    const bnd  = unrealized.find(x => x.symbol === "BND");
    const vxus = unrealized.find(x => x.symbol === "VXUS");

    // VTI: mixed
    assert.equal(vti.isLongTerm, null);
    assert.ok(close(vti.ltShares - 5));
    assert.ok(close(vti.stShares - 3));

    // BND: pure LT
    assert.equal(bnd.isLongTerm, true);
    assert.ok(close(bnd.ltShares - 10));
    assert.ok(close(bnd.stShares - 0));

    // VXUS: pure ST
    assert.equal(vxus.isLongTerm, false);
    assert.ok(close(vxus.stShares - 4));
    assert.ok(close(vxus.ltShares - 0));
  });

  // ── Summary totals still correct after data model change ─────────────────

  it("summary stUnrealized and ltUnrealized are unaffected by new fields", () => {
    const trades = [
      buy("2020-01-01", "VTI", 100, 10),  // LT
      buy("2025-12-01", "VTI", 150, 5),   // ST
    ];
    const mkt = market({ date: "2026-01-01", sym: "VTI", price: 200 });
    const { summary } = computeGains(trades, mkt);
    assert.ok(close(summary.ltUnrealized - 1000));  // 10*(200-100)
    assert.ok(close(summary.stUnrealized - 250));   // 5*(200-150)
  });

  // ── No market price: fields are 0 when currentDate is null ──────────────

  it("fields are 0 when no market price exists for the symbol", () => {
    const trades = [buy("2020-01-01", "VTI", 100, 10)];
    const mkt = [];  // no market data
    const { unrealized } = computeGains(trades, mkt);
    const u = unrealized.find(x => x.symbol === "VTI");
    assert.ok(u);
    assert.ok(close(u.stShares - 0));
    assert.ok(close(u.ltShares - 0));
    assert.ok(close(u.stCost - 0));
    assert.ok(close(u.ltCost - 0));
    assert.ok(close(u.stGain - 0));
    assert.ok(close(u.ltGain - 0));
  });

  // ── Exact 365-day boundary ───────────────────────────────────────────────

  it("lot held exactly 365 days is ST; lot held 366 days is LT", () => {
    // "2025-01-01" to "2026-01-01" = 365 days → ST (holdDays > 365 required for LT)
    // "2024-12-31" to "2026-01-01" = 366 days → LT
    const trades = [
      buy("2025-01-01", "VTI", 100, 10),  // 365 days → ST
      buy("2024-12-31", "VTI", 120, 5),   // 366 days → LT
    ];
    const mkt = market({ date: "2026-01-01", sym: "VTI", price: 150 });
    const { unrealized } = computeGains(trades, mkt);
    const u = unrealized.find(x => x.symbol === "VTI");
    assert.ok(u);
    assert.equal(u.isLongTerm, null, "mixed: one ST lot (365d) and one LT lot (366d)");
    assert.ok(close(u.stShares - 10), "365-day lot is ST");
    assert.ok(close(u.ltShares - 5),  "366-day lot is LT");
    assert.ok(close(u.stCost - 1000));  // 10 * 100
    assert.ok(close(u.ltCost - 600));   // 5 * 120
    assert.ok(close(u.stGain - 500));   // 10 * (150 - 100)
    assert.ok(close(u.ltGain - 150));   // 5 * (150 - 120)
  });
});

// ---------------------------------------------------------------------------
// drip trade type
// ---------------------------------------------------------------------------

describe("computeGains drip trade type", () => {
  it("drip creates a lot with the reinvestment price as cost basis (FIFO)", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),
      { date: "2024-06-01", symbol: "VTI", price: "110", quantity: "0.5", type: "drip" },
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 120 });
    const { unrealized } = computeGains(trades, mkt);
    assert.equal(unrealized.length, 1);
    // 10 + 0.5 = 10.5 shares total
    assert.ok(close(unrealized[0].shares - 10.5));
    // avg cost: (10*100 + 0.5*110) / 10.5
    const expectedAvg = (10 * 100 + 0.5 * 110) / 10.5;
    assert.ok(Math.abs(unrealized[0].avgCostBasis - expectedAvg) < 0.001);
  });

  it("drip creates a lot with the reinvestment price as cost basis (average_cost)", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),
      { date: "2024-06-01", symbol: "VTI", price: "110", quantity: "0.5", type: "drip" },
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 120 });
    const { unrealized } = computeGains(trades, mkt, "average_cost");
    assert.equal(unrealized.length, 1);
    assert.ok(close(unrealized[0].shares - 10.5));
    const expectedAvg = (10 * 100 + 0.5 * 110) / 10.5;
    assert.ok(Math.abs(unrealized[0].avgCostBasis - expectedAvg) < 0.001);
  });
});
