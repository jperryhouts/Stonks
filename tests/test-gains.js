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
  const tx = { date, symbol, price: String(price), quantity: String(quantity), type: "sell" };
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

});

// ---------------------------------------------------------------------------
// computeGains — FIFO lot exhaustion (overselling)
// ---------------------------------------------------------------------------

describe("computeGains - FIFO lot exhaustion", () => {
  // Market data for the test
  const MARKET = [
    { timestamp: "2024-06-01 16:00", VTI: "250" },
  ];

  it("produces a warning entry when selling more shares than owned", () => {
    // Buy 5 shares, then attempt to sell 8 (3 more than exist in FIFO).
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "200", quantity: "5", type: "buy" },
      { date: "2024-06-01", symbol: "VTI", price: "250", quantity: "8", type: "sell" },
    ];
    const { realized } = computeGains(trades, MARKET);

    // Should have two realized entries: the 5-share FIFO match + a 3-share warning
    const warning = realized.find((r) => r.warning);
    assert.ok(warning, "Expected a warning entry for oversold shares");
    assert.ok(warning.warning.includes("Insufficient shares"),
      `Unexpected warning text: ${warning.warning}`);
  });

  it("warning entry has zero gain and zero cost basis", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "200", quantity: "5", type: "buy" },
      { date: "2024-06-01", symbol: "VTI", price: "250", quantity: "8", type: "sell" },
    ];
    const { realized } = computeGains(trades, MARKET);
    const warning = realized.find((r) => r.warning);

    assert.equal(warning.gain, 0);
    assert.equal(warning.costBasis, 0);
    assert.equal(warning.holdDays, null);
    assert.equal(warning.isLongTerm, null);
  });

  it("warning entry proceeds equal oversold shares times sale price", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "200", quantity: "5", type: "buy" },
      { date: "2024-06-01", symbol: "VTI", price: "250", quantity: "8", type: "sell" },
    ];
    const { realized } = computeGains(trades, MARKET);
    const warning = realized.find((r) => r.warning);

    // 3 oversold shares × $250 = $750
    assert.ok(Math.abs(warning.proceeds - 750) < 0.01,
      `Expected proceeds ~750, got ${warning.proceeds}`);
    assert.ok(Math.abs(warning.shares - 3) < 0.01,
      `Expected shares ~3, got ${warning.shares}`);
  });

  it("non-warning realized entries are correct despite oversell", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "200", quantity: "5", type: "buy" },
      { date: "2024-06-01", symbol: "VTI", price: "250", quantity: "8", type: "sell" },
    ];
    const { realized } = computeGains(trades, MARKET);
    const normal = realized.filter((r) => !r.warning);

    // The 5 legitimately-owned shares should produce a normal realized-gain entry
    assert.ok(normal.length >= 1, "Expected at least one non-warning realized entry");
    const total = normal.reduce((s, r) => s + r.shares, 0);
    assert.ok(Math.abs(total - 5) < 0.01,
      `Expected 5 shares in normal entries, got ${total}`);
  });
});

// ---------------------------------------------------------------------------
// Wash sale detection
// ---------------------------------------------------------------------------

describe("computeGains wash sales", () => {
  const NO_MKT = [];

  // Helper: assert two numbers are close enough
  function near(a, b, msg) {
    assert.ok(Math.abs(a - b) < 0.001, msg || `Expected ${a} ≈ ${b}`);
  }

  it("look-forward basic: sell at loss then buy within 30 days → wash sale", () => {
    // Sell 5 VTI at $90 (loss of $50), then buy 5 VTI 11 days later
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),   // cost basis $500
      sell("2024-01-25", "VTI", 90, 5),    // proceeds $450 → raw gain −$50
      buy("2024-02-05", "VTI", 92, 5),    // replacement buy (11 days later)
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    // Realized entry should be flagged as wash sale
    assert.equal(realized.length, 1);
    const r = realized[0];
    assert.ok(r.washSaleDisallowed > 0, "washSaleDisallowed should be set");
    near(r.washSaleRawGain, -50, "raw gain should be −50");
    near(r.washSaleDisallowed, 50, "full loss disallowed (all 5 shares replaced)");
    near(r.gain, 0, "adjusted gain should be 0");

    // Replacement lot should have adjusted cost basis
    assert.equal(unrealized.length, 1);
    // avgCostBasis = (92 + 50/5) = 92 + 10 = $102/share
    near(unrealized[0].avgCostBasis, 102, "replacement lot basis adjusted upward");
  });

  it("look-back basic: buy then FIFO-sell older lot at loss → recent lot basis adjusted", () => {
    // Buy 5 shares Jan 1, buy 5 more Jan 20, then sell the Jan 1 lot (FIFO) at a loss Jan 25
    // The Jan 20 lot is within 30 days before the sale → wash sale look-back
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),   // lot A: cost $100
      buy("2024-01-20", "VTI", 95, 5),    // lot B: cost $95, within 30-day look-back
      sell("2024-01-25", "VTI", 90, 5),   // FIFO consumes lot A → raw gain −$50
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    // Only 1 realized entry (5 shares from lot A)
    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 1);
    const r = nonWarn[0];
    assert.ok(r.washSaleDisallowed > 0, "washSaleDisallowed should be set");
    near(r.washSaleRawGain, -50, "raw gain should be −50");
    near(r.washSaleDisallowed, 50, "full loss disallowed");
    near(r.gain, 0, "adjusted gain should be 0");

    // The remaining lot (Jan 20) should have its price adjusted up by $10/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 105, "look-back lot basis: 95 + 50/5 = 105");
  });

  it("partial replacement: sell 10 shares at loss, only 4 replacement shares bought", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),   // cost $1000
      sell("2024-01-25", "VTI", 90, 10),   // raw gain −$100
      buy("2024-02-05", "VTI", 92, 4),     // only 4 replacement shares
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    assert.equal(realized.length, 1);
    const r = realized[0];
    // 4 shares disallowed: 4 * ($100/10) = $40
    near(r.washSaleDisallowed, 40, "4 shares disallowed");
    near(r.washSaleRawGain, -100, "raw gain −100");
    near(r.gain, -60, "adjusted gain: −100 + 40 = −60");

    // Replacement lot: 92 + 40/4 = 102/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 102, "replacement lot basis adjusted");
  });

  it("no wash sale when replacement buy is 31 days after sale", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),
      sell("2024-01-25", "VTI", 90, 5),    // loss −$50
      buy("2024-02-25", "VTI", 92, 5),     // 31 days later — outside window
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    assert.equal(realized.length, 1);
    const r = realized[0];
    assert.equal(r.washSaleDisallowed, undefined, "no wash sale disallowed");
    near(r.gain, -50, "loss should be −50 with no adjustment");
  });

  it("no wash sale when sell is at a gain", () => {
    // Wash sale rule only applies to losses
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),
      sell("2024-01-25", "VTI", 120, 5),   // gain +$100
      buy("2024-02-05", "VTI", 118, 5),    // within 30 days, but no loss
    ];
    const { realized } = computeGains(trades, NO_MKT);

    assert.equal(realized.length, 1);
    const r = realized[0];
    assert.equal(r.washSaleDisallowed, undefined, "no wash sale on a gain");
    near(r.gain, 100, "gain should be +100");
  });

  it("adjusted basis carries forward: replacement lot sold later uses adjusted basis", () => {
    // Sell at loss Jan 25, replacement buy Feb 5 (basis adjusted to $102),
    // then sell the replacement lot Mar 20 (more than 30 days later)
    const trades = [
      buy("2024-01-01", "VTI", 100, 5),   // cost $100
      sell("2024-01-25", "VTI", 90, 5),   // loss −$50 → wash sale, basis transferred
      buy("2024-02-05", "VTI", 92, 5),    // replacement: adjusted basis $102
      sell("2024-03-20", "VTI", 110, 5),  // sell replacement lot (not a wash sale)
    ];
    const { realized } = computeGains(trades, NO_MKT);

    // First sell: wash sale
    const washEntry = realized.find((r) => r.date === "2024-01-25");
    assert.ok(washEntry && washEntry.washSaleDisallowed > 0, "first sell is a wash sale");

    // Second sell: uses adjusted basis $102, gain = 5*(110-102) = $40
    const secondEntry = realized.find((r) => r.date === "2024-03-20" && !r.warning);
    assert.ok(secondEntry, "second sell entry exists");
    assert.equal(secondEntry.washSaleDisallowed, undefined, "second sell is not a wash sale");
    near(secondEntry.gain, 40, "second sell gain uses adjusted basis: 5*(110-102)=40");
  });

  it("look-back + look-forward combined: partial coverage by each", () => {
    // Sell 10 shares at a loss.
    // 4 shares covered by a look-back buy (Jan 20).
    // Remaining 6 shares need a look-forward buy — 6 shares bought Feb 5.
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),  // lot A: cost $100/share
      buy("2024-01-20", "VTI", 95, 4),    // lot B: 4 shares, within look-back window
      sell("2024-01-25", "VTI", 90, 10),  // FIFO: 10 from lot A → raw gain −$100
      buy("2024-02-05", "VTI", 92, 6),    // look-forward: 6 replacement shares
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 1);
    const r = nonWarn[0];

    // Total disallowed: 4 * $10 (look-back) + 6 * $10 (look-forward) = $100
    near(r.washSaleDisallowed, 100, "full loss disallowed via look-back + look-forward");
    near(r.washSaleRawGain, -100, "raw gain −100");
    near(r.gain, 0, "adjusted gain 0");

    // Both remaining lots are VTI → 1 unrealized entry with 2 lotDetails
    // Look-back lot (Jan 20, 4 shares): 95 + 40/4 = 105
    // Look-forward lot (Feb 5, 6 shares): 92 + 60/6 = 102
    assert.equal(unrealized.length, 1);
    const u = unrealized[0];
    assert.ok(u.lotDetails && u.lotDetails.length === 2, "two lot detail entries");

    const lbDetail = u.lotDetails.find((l) => l.date === "2024-01-20");
    assert.ok(lbDetail, "look-back lot (Jan 20) in lotDetails");
    near(lbDetail.price, 105, "look-back lot basis: 95 + 40/4 = 105");

    const lfDetail = u.lotDetails.find((l) => l.date === "2024-02-05");
    assert.ok(lfDetail, "look-forward lot (Feb 5) in lotDetails");
    near(lfDetail.price, 102, "look-forward lot basis: 92 + 60/6 = 102");
  });

  it("look-back lot splitting: only replacement shares get adjusted basis", () => {
    // Jan 1: buy 100 shares @ $100 (large lot)
    // Jan 5: buy 100 shares @ $102 (within 30-day window, untouched by sell)
    // Jan 15: sell 50 shares specifying lotDate Jan 5 @ $90 → loss $12/share
    //
    // Look-back finds the Jan 1 lot (100 shares). Only 50 are needed as
    // replacement shares. The lot must be split:
    //   50 shares @ $100 + $12 = $112 (replacement, basis adjusted)
    //   50 shares @ $100        (clean, basis unchanged)
    const trades = [
      buy("2025-01-01", "VTI", 100, 100),
      buy("2025-01-05", "VTI", 102, 100),
      sell("2025-01-15", "VTI", 90, 50, "2025-01-05"),
    ];
    const mkt = market({ date: "2025-01-20", sym: "VTI", price: 95 });
    const { realized, unrealized } = computeGains(trades, mkt);

    const r = realized.find((e) => !e.warning);
    assert.ok(r, "realized entry exists");
    // Loss = 50 * (90-102) = -600; all 50 covered by look-back Jan 1 lot
    near(r.washSaleRawGain, -600, "raw loss -600");
    near(r.washSaleDisallowed, 600, "full loss disallowed");
    near(r.gain, 0, "adjusted gain 0");

    // Unrealized: Jan 1 lot split into 50@112 + 50@100, plus 50 Jan 5 remaining = 150 total
    // → still grouped as one VTI unrealized entry (3 lot details)
    assert.equal(unrealized.length, 1, "one unrealized symbol");
    const u = unrealized[0];
    near(u.shares, 150, "150 shares remain (50 Jan1-adjusted + 50 Jan1-clean + 50 Jan5)");

    // Verify the lot split: there should be a Jan 1 lot at adjusted basis $112
    // and another Jan 1 lot at original basis $100
    const adjustedLot = u.lotDetails.find((l) => l.date === "2025-01-01" && Math.abs(l.price - 112) < 0.01);
    assert.ok(adjustedLot, "split lot at adjusted basis $112 exists");
    near(adjustedLot.quantity, 50, "adjusted lot has 50 shares");

    const cleanLot = u.lotDetails.find((l) => l.date === "2025-01-01" && Math.abs(l.price - 100) < 0.01);
    assert.ok(cleanLot, "clean lot at original basis $100 exists");
    near(cleanLot.quantity, 50, "clean lot has 50 shares");
  });
});

// ---------------------------------------------------------------------------
// Wash sale edge cases
// ---------------------------------------------------------------------------

describe("computeGains wash sales — edge cases", () => {
  const NO_MKT = [];

  function near(a, b, msg) {
    assert.ok(Math.abs(a - b) < 0.001, msg || `Expected ${a} ≈ ${b}`);
  }

  // Scenario 3: look-forward lot splitting when repurchase exceeds shares sold
  //
  // Sell 50 shares at a $3/share loss ($150 total).
  // Buy back 100 shares — more than the 50 sold.
  // Only 50 of the 100 replacement shares absorb the disallowed loss;
  // the remaining 50 keep their original basis.
  it("scenario 3: rebuy more than sold — replacement shares split, only sold-count adjusted", () => {
    const trades = [
      buy("2024-01-01", "VTI", 12, 50),    // cost $600; $12/share basis
      sell("2024-02-01", "VTI", 9, 50),    // proceeds $450; loss = −$150
      buy("2024-02-15", "VTI", 9, 100),    // 100 shares bought; only 50 are replacements
    ];
    const mkt = market({ date: "2024-12-31", sym: "VTI", price: 10 });
    const { realized, unrealized } = computeGains(trades, mkt);

    assert.equal(realized.length, 1);
    const r = realized[0];
    near(r.washSaleRawGain, -150, "raw gain −$150");
    near(r.washSaleDisallowed, 150, "entire $150 loss disallowed (50 sold shares all replaced)");
    near(r.gain, 0, "adjusted gain = 0");

    // 100 shares remain
    assert.equal(unrealized.length, 1);
    const u = unrealized[0];
    near(u.shares, 100, "100 shares remain");

    // Lot split: 50 replacement shares at $9 + $3 = $12; 50 clean shares at $9
    assert.ok(u.lotDetails && u.lotDetails.length === 2, "lot split into two detail entries");
    const replacementLot = u.lotDetails.find((l) => Math.abs(l.price - 12) < 0.01);
    const cleanLot       = u.lotDetails.find((l) => Math.abs(l.price - 9)  < 0.01);
    assert.ok(replacementLot, "replacement lot at $12/share exists");
    near(replacementLot.quantity, 50, "50 replacement shares at $12");
    assert.ok(cleanLot, "clean lot at $9/share exists");
    near(cleanLot.quantity, 50, "50 clean shares at $9");
  });

  // Scenario 5: chained wash sales
  //
  // First sale triggers a wash; the replacement lot inherits an inflated basis.
  // When that replacement lot is later sold at a loss and re-washed, the loss is
  // computed against the ADJUSTED basis, not the original purchase price.
  it("scenario 5: chained wash — second wash loss uses the adjusted basis from first wash", () => {
    const trades = [
      buy("2024-01-01",  "VTI", 10, 100),  // Lot A: $10/share
      sell("2024-02-01", "VTI",  8, 100),  // loss = 100*(8−10) = −$200 → washed by Feb 15 buy
      buy("2024-02-15",  "VTI",  8, 100),  // Lot B: adjusted basis $8 + $2 = $10/share
      sell("2024-03-05", "VTI",  6, 100),  // Lot B sold; loss = 100*(6−10) = −$400 → washed by Mar 20 buy
      buy("2024-03-20",  "VTI",  6, 100),  // Lot C: replacement for the Mar 05 sale
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 2, "two realized entries");

    // Feb 01 sale: $200 disallowed
    const r1 = nonWarn.find((r) => r.date === "2024-02-01");
    assert.ok(r1, "Feb 01 realized entry exists");
    near(r1.washSaleDisallowed, 200, "Feb 01: $200 disallowed");
    near(r1.gain, 0, "Feb 01: adjusted gain = 0");

    // Mar 05 sale: loss computed against ADJUSTED basis ($10), not purchase price ($8)
    const r2 = nonWarn.find((r) => r.date === "2024-03-05");
    assert.ok(r2, "Mar 05 realized entry exists");
    near(r2.washSaleRawGain, -400, "Mar 05: raw loss = 100*(6−10) = −$400");
    near(r2.washSaleDisallowed, 400, "Mar 05: $400 disallowed");
    near(r2.gain, 0, "Mar 05: adjusted gain = 0");

    // Lot C (Mar 20): adjusted basis = $6 + $4 = $10/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 10, "Lot C: $6 + $400/100 = $10/share");
  });

  // Scenario 6: two lots sold in one FIFO transaction — only the loss lot is washed
  //
  // Lot A (cheap) yields a gain; Lot B (expensive) yields a loss.
  // Both are consumed in the same sell. A subsequent buy within 30 days should
  // wash only the loss lot; the gain lot's proceeds are recognized normally.
  it("scenario 6: two lots sold same day — gain lot recognized, loss lot washed", () => {
    const trades = [
      buy("2024-01-01", "VTI",  8, 100),  // Lot A: $8/share — gain lot at $10
      buy("2024-01-20", "VTI", 12, 100),  // Lot B: $12/share — loss lot at $10
      sell("2024-02-05", "VTI", 10, 200), // FIFO: 100 from Lot A (+$200), 100 from Lot B (−$200)
      buy("2024-02-25", "VTI", 10, 100),  // replacement for Lot B loss
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 2, "two realized entries (one per FIFO lot)");

    // Lot A slice: gain, no wash
    const lotA = nonWarn.find((r) => Math.abs(r.costBasis - 800) < 0.01);  // 100 * $8
    assert.ok(lotA, "Lot A realized entry (costBasis = $800)");
    near(lotA.gain, 200, "Lot A gain: 100*(10−8) = $200");
    assert.equal(lotA.washSaleDisallowed, undefined, "Lot A: no wash sale (gain, not a loss)");

    // Lot B slice: loss, washed
    const lotB = nonWarn.find((r) => Math.abs(r.costBasis - 1200) < 0.01);  // 100 * $12
    assert.ok(lotB, "Lot B realized entry (costBasis = $1200)");
    near(lotB.washSaleRawGain, -200, "Lot B raw loss: 100*(10−12) = −$200");
    near(lotB.washSaleDisallowed, 200, "Lot B: $200 fully disallowed");
    near(lotB.gain, 0, "Lot B: adjusted gain = 0");

    // Replacement lot: $10 + $2 = $12/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 12, "replacement basis: $10 + $2 = $12");
  });

  // Scenario 7: two separate loss sales washed by a single repurchase
  //
  // The repurchase pool is allocated chronologically: it covers the earlier sale
  // first, then the remainder covers as much of the later sale as possible.
  it("scenario 7: two loss sales share one repurchase — earlier sale fully covered, later partially", () => {
    const trades = [
      buy("2024-01-01",  "VTI", 10, 200),  // one lot, 200 shares @ $10
      sell("2024-02-01", "VTI",  8, 100),  // loss = 100*(8−10) = −$200 ($2/share)
      sell("2024-02-06", "VTI",  7, 100),  // loss = 100*(7−10) = −$300 ($3/share)
      buy("2024-02-20",  "VTI",  7.50, 150), // 150 replacement shares within 30 days of both sales
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 2, "two realized entries");

    // Feb 01 sale: 100 of 150 replacement shares → $200 fully disallowed
    const r1 = nonWarn.find((r) => r.date === "2024-02-01");
    assert.ok(r1, "Feb 01 entry exists");
    near(r1.washSaleDisallowed, 200, "Feb 01: $200 fully disallowed");
    near(r1.gain, 0, "Feb 01: adjusted gain = 0");

    // Feb 06 sale: 50 remaining replacement shares cover half → $150 disallowed, $150 allowed
    const r2 = nonWarn.find((r) => r.date === "2024-02-06");
    assert.ok(r2, "Feb 06 entry exists");
    near(r2.washSaleRawGain, -300, "Feb 06: raw loss = −$300");
    near(r2.washSaleDisallowed, 150, "Feb 06: $150 disallowed (50/100 shares replaced)");
    near(r2.gain, -150, "Feb 06: adjusted gain = −$150 (remaining loss allowed)");

    // Feb 20 purchase (150 shares) split by per-sale adjustment rate:
    //   100 shares covering Feb 01: $7.50 + $2.00 = $9.50/share
    //    50 shares covering Feb 06: $7.50 + $3.00 = $10.50/share
    assert.equal(unrealized.length, 1);
    const u = unrealized[0];
    near(u.shares, 150, "150 shares remain");
    assert.ok(u.lotDetails && u.lotDetails.length === 2, "lot split into two detail entries");

    const lot950  = u.lotDetails.find((l) => Math.abs(l.price -  9.50) < 0.01);
    const lot1050 = u.lotDetails.find((l) => Math.abs(l.price - 10.50) < 0.01);
    assert.ok(lot950,  "100-share tranche at $9.50 exists");
    near(lot950.quantity, 100, "100 shares at $9.50");
    assert.ok(lot1050, "50-share tranche at $10.50 exists");
    near(lot1050.quantity, 50, "50 shares at $10.50");
  });

  // Scenario 8: same-day sale and repurchase
  //
  // The 30-day window includes day 0; a buy on the exact same date as the loss
  // sale counts as a replacement purchase.
  it("scenario 8: same-day sale and repurchase triggers wash sale", () => {
    const trades = [
      buy("2024-01-01",  "VTI", 10, 100),  // cost $1000
      sell("2024-03-01", "VTI",  7, 100),  // loss = −$300
      buy("2024-03-01",  "VTI",  7, 100),  // same-day repurchase
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const r = realized.find((e) => !e.warning);
    assert.ok(r, "realized entry exists");
    near(r.washSaleDisallowed, 300, "same-day repurchase: $300 loss fully disallowed");
    near(r.gain, 0, "adjusted gain = 0");

    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 10, "replacement basis: $7 + $3 = $10");
  });

  // Scenario 9a: exactly 30 days after sale is still within the wash-sale window
  //
  // The window is inclusive: day 30 triggers a wash sale; day 31 does not
  // (day 31 is already tested in the base suite above).
  it("scenario 9a: repurchase exactly 30 days after loss sale triggers wash sale", () => {
    // Jan 25 + 30 calendar days = Feb 24 (Jan has 31 days: 31−25=6 days left; +24 in Feb = 30)
    const trades = [
      buy("2024-01-01",  "VTI", 100, 5),
      sell("2024-01-25", "VTI",  90, 5),  // loss = −$50
      buy("2024-02-24",  "VTI",  90, 5),  // exactly 30 days after Jan 25 → inside window
    ];
    const { realized } = computeGains(trades, NO_MKT);

    const r = realized.find((e) => !e.warning);
    assert.ok(r, "realized entry exists");
    near(r.washSaleDisallowed, 50, "day-30 repurchase: $50 loss disallowed");
    near(r.gain, 0, "adjusted gain = 0");
  });

  // Scenario 10: cross-year wash sale
  //
  // A December loss sale is matched by a January repurchase in the next calendar
  // year. The loss is disallowed in Year 1; the deferred amount lifts the
  // replacement lot's basis in Year 2.
  it("scenario 10: cross-year wash — December loss deferred into January basis", () => {
    const trades = [
      buy("2023-11-01",  "VTI", 20, 100),  // cost $2000
      sell("2023-12-20", "VTI", 15, 100),  // Year-1 loss = −$500
      buy("2024-01-05",  "VTI", 15, 100),  // 16 days after Dec 20 → wash sale in Year 2
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    // Dec 20 sale: $500 loss fully disallowed (not deductible in Year 1)
    const r = realized.find((e) => !e.warning);
    assert.ok(r, "Dec 20 realized entry exists");
    assert.equal(r.date, "2023-12-20");
    near(r.washSaleDisallowed, 500, "$500 loss disallowed");
    near(r.gain, 0, "adjusted gain = 0 in Year 1");

    // Jan 05 replacement lot: basis = $15 + $5 = $20/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 20, "Year-2 basis: $15 + $5 = $20");
  });

  // Scenario 11: DRIP purchase within 30 days triggers a partial wash sale
  //
  // A dividend reinvestment (type: "drip") within the 30-day window counts as a
  // replacement purchase, disallowing a proportional fraction of the loss.
  it("scenario 11: DRIP within 30 days creates replacement shares — partial wash sale", () => {
    const trades = [
      buy("2024-01-01", "VTI", 10, 100),  // cost $1000
      sell("2024-02-01", "VTI", 8, 100),  // loss = −$200
      // 5 DRIP shares on Feb 08 (7 days after loss sale — within 30-day window)
      { date: "2024-02-08", symbol: "VTI", price: "8", quantity: "5", type: "drip" },
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    // 5 of 100 shares replaced → 5% disallowed
    const r = realized.find((e) => !e.warning);
    assert.ok(r, "realized entry exists");
    near(r.washSaleRawGain, -200, "raw loss = −$200");
    near(r.washSaleDisallowed, 10, "5/100 replaced → $10 disallowed");
    near(r.gain, -190, "adjusted gain = −$190 (95% of loss allowed)");

    // DRIP lot: basis = $8 + ($10/5) = $8 + $2 = $10/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 10, "DRIP lot basis: $8 + $2 = $10");
  });

  // Scenario 11b: DRIP look-forward where DRIP quantity exceeds shares sold.
  //
  // Only the sold-share count (10) of the DRIP lot's 25 shares is used as
  // replacement. The remaining 15 DRIP shares stay as a clean lot at the
  // original DRIP price.
  it("scenario 11b: DRIP larger than sale — only sold-share portion is replacement, rest is clean", () => {
    const trades = [
      buy("2024-01-01", "VTI", 10, 10),   // cost $100
      sell("2024-02-01", "VTI", 8, 10),   // loss = −$20
      // DRIP of 25 shares — more than the 10 sold
      { date: "2024-02-08", symbol: "VTI", price: "8", quantity: "25", type: "drip" },
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    // 10 of 10 sold shares replaced → 100% disallowed
    const r = realized.find((e) => !e.warning);
    assert.ok(r, "realized entry exists");
    near(r.washSaleRawGain, -20, "raw loss = −$20");
    near(r.washSaleDisallowed, 20, "10/10 replaced → full $20 disallowed");
    near(r.gain, 0, "adjusted gain = 0");

    // DRIP lot is split: 10 replacement shares at $8+$2=$10, 15 clean shares at $8.
    // Both belong to VTI so they appear as one unrealized entry with two lotDetails.
    assert.equal(unrealized.length, 1, "one unrealized VTI entry");
    near(unrealized[0].shares, 25, "25 total DRIP shares remaining");
    // blended avgCostBasis = (10*10 + 15*8) / 25 = (100+120)/25 = 8.8
    near(unrealized[0].avgCostBasis, 8.8, "blended basis: (10*$10 + 15*$8)/25 = $8.80");
    assert.equal(unrealized[0].lotDetails.length, 2, "two lot-detail rows (replacement + clean)");
    const repLot = unrealized[0].lotDetails.find((l) => Math.abs(l.price - 10) < 0.01);
    assert.ok(repLot, "replacement sub-lot at $10/share");
    near(repLot.quantity, 10, "replacement sub-lot: 10 shares");
    const cleanLot = unrealized[0].lotDetails.find((l) => Math.abs(l.price - 8) < 0.01);
    assert.ok(cleanLot, "clean DRIP sub-lot at $8/share");
    near(cleanLot.quantity, 15, "clean sub-lot: 15 shares");
  });

  // Scenario 11c: DRIP look-back (DRIP purchased before the loss sale).
  //
  // DRIP shares acquired within 30 days before a loss sale count as replacement
  // purchases under the look-back rule, just like regular buys.
  it("scenario 11c: DRIP look-back — DRIP purchased before loss sale triggers wash sale", () => {
    const trades = [
      buy("2024-01-01", "VTI", 10, 100),  // lot A: cost $1000
      // DRIP of 5 fractional shares, 10 days before the loss sale
      { date: "2024-01-21", symbol: "VTI", price: "9", quantity: "5", type: "drip" },
      sell("2024-01-31", "VTI", 8, 100, "2024-01-01"),  // sell lot A; loss = −$200
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    // 5 of 100 loss shares covered by look-back DRIP lot → 5% disallowed
    const r = realized.find((e) => !e.warning);
    assert.ok(r, "realized entry exists");
    near(r.washSaleRawGain, -200, "raw loss = −$200");
    near(r.washSaleDisallowed, 10, "5/100 look-back DRIP shares → $10 disallowed");
    near(r.gain, -190, "adjusted gain = −$190");

    // DRIP lot basis adjusted: $9 + ($10/5) = $11/share
    assert.equal(unrealized.length, 1, "only DRIP lot remains");
    near(unrealized[0].avgCostBasis, 11, "DRIP lot basis: $9 + $2 = $11");
  });

  // Scenario 11d: DRIP look-back where the DRIP exceeds shares sold.
  //
  // DRIP of 20 fractional shares acquired before a loss sale of only 5 shares.
  // Only 5 of the 20 DRIP shares are needed as replacement; the remaining 15
  // keep their original cost basis.
  it("scenario 11d: DRIP look-back larger than sale — only sold portion used as replacement", () => {
    const trades = [
      buy("2024-01-01", "VTI", 10, 5),    // lot A: cost $50
      // DRIP of 20 shares, 10 days before the loss sale (look-back window)
      { date: "2024-01-21", symbol: "VTI", price: "9", quantity: "20", type: "drip" },
      sell("2024-01-31", "VTI", 8, 5, "2024-01-01"),  // sell lot A; loss = −$10
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    // 5 of 5 loss shares replaced → 100% disallowed
    const r = realized.find((e) => !e.warning);
    assert.ok(r, "realized entry exists");
    near(r.washSaleRawGain, -10, "raw loss = −$10");
    near(r.washSaleDisallowed, 10, "5/5 replaced → full $10 disallowed");
    near(r.gain, 0, "adjusted gain = 0");

    // DRIP lot split: 5 replacement shares at $9+$2=$11, 15 clean shares at $9.
    // Both are VTI → one unrealized entry with two lotDetails.
    assert.equal(unrealized.length, 1, "one unrealized VTI entry");
    near(unrealized[0].shares, 20, "20 total DRIP shares remaining");
    // blended avgCostBasis = (5*11 + 15*9) / 20 = (55+135)/20 = 9.5
    near(unrealized[0].avgCostBasis, 9.5, "blended basis: (5*$11 + 15*$9)/20 = $9.50");
    assert.equal(unrealized[0].lotDetails.length, 2, "two lot-detail rows (replacement + clean)");
    const repLot = unrealized[0].lotDetails.find((l) => Math.abs(l.price - 11) < 0.01);
    assert.ok(repLot, "replacement sub-lot at $11/share");
    near(repLot.quantity, 5, "replacement sub-lot: 5 shares");
    const cleanLot = unrealized[0].lotDetails.find((l) => Math.abs(l.price - 9) < 0.01);
    assert.ok(cleanLot, "clean DRIP sub-lot at $9/share");
    near(cleanLot.quantity, 15, "clean sub-lot: 15 shares");
  });

  // Scenario 12: large loss with a tiny repurchase
  //
  // Only a proportional sliver of the loss is disallowed (1%), leaving 99%
  // of the loss recognized. The 10 replacement shares carry the full per-share
  // adjustment even though the total disallowed amount is small.
  it("scenario 12: large loss, tiny repurchase — only proportional fraction disallowed", () => {
    const trades = [
      buy("2024-01-01",  "VTI", 10, 1000),  // cost $10000
      sell("2024-02-01", "VTI",  7, 1000),  // loss = −$3000
      buy("2024-02-20",  "VTI",  7,   10),  // 10 replacement shares (1% of 1000 sold)
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const r = realized.find((e) => !e.warning);
    assert.ok(r, "realized entry exists");
    near(r.washSaleRawGain, -3000, "raw loss = −$3000");
    // 10/1000 = 1% → $30 disallowed
    near(r.washSaleDisallowed, 30, "1% replaced → $30 disallowed");
    near(r.gain, -2970, "adjusted gain = −$2970 (99% of loss allowed)");

    // 10 replacement shares: $7 + ($30/10) = $7 + $3 = $10/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 10, "replacement basis: $7 + $3 = $10");
  });

  // Scenario 6b: loss lot is FIRST in FIFO order, gain lot is second
  //
  // Mirrors scenario 6 but with the lots in the opposite purchase order so the
  // loss lot is consumed first by FIFO. If the bug is order-dependent (only
  // triggers when the loss lot follows a gain lot), this will pass; if the bug
  // is structural (any mixed gain+loss sell), this will also fail.
  it("scenario 6b: loss lot first in FIFO order, gain lot second — loss lot still washed", () => {
    const trades = [
      buy("2024-01-01", "VTI", 12, 100),  // Lot A: $12/share — loss lot at $10 (purchased first)
      buy("2024-01-20", "VTI",  8, 100),  // Lot B: $8/share  — gain lot at $10 (purchased second)
      sell("2024-02-05", "VTI", 10, 200), // FIFO: 100 from Lot A (−$200), then 100 from Lot B (+$200)
      buy("2024-02-25", "VTI", 10, 100),  // replacement for Lot A loss
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 2, "two realized entries (one per FIFO lot)");

    // Lot A (basis $12): loss, washed
    const lotA = nonWarn.find((r) => Math.abs(r.costBasis - 1200) < 0.01);  // 100 * $12
    assert.ok(lotA, "Lot A realized entry (costBasis = $1200)");
    near(lotA.washSaleRawGain, -200, "Lot A raw loss: 100*(10−12) = −$200");
    near(lotA.washSaleDisallowed, 200, "Lot A: $200 fully disallowed");
    near(lotA.gain, 0, "Lot A: adjusted gain = 0");

    // Lot B (basis $8): gain, no wash
    const lotB = nonWarn.find((r) => Math.abs(r.costBasis - 800) < 0.01);   // 100 * $8
    assert.ok(lotB, "Lot B realized entry (costBasis = $800)");
    near(lotB.gain, 200, "Lot B gain: 100*(10−8) = $200");
    assert.equal(lotB.washSaleDisallowed, undefined, "Lot B: no wash sale (it's a gain)");

    // Replacement lot: $10 + $2 = $12/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 12, "replacement basis: $10 + $2 = $12");
  });

  // Scenario 6c: mixed gain+loss multi-lot sell with only partial replacement
  //
  // Same gain-then-loss FIFO structure as scenario 6, but only 60 replacement
  // shares are purchased. 60% of the loss lot's loss should be disallowed and
  // the remaining 40% allowed. Verifies that both the detection AND the
  // proportional calculation are broken for mixed-lot sells.
  it("scenario 6c: mixed lots, partial replacement — 60% of loss lot disallowed", () => {
    const trades = [
      buy("2024-01-01", "VTI",  8, 100),  // Lot A: $8/share  — gain lot at $10
      buy("2024-01-20", "VTI", 13, 100),  // Lot B: $13/share — loss lot at $10 (loss = −$300)
      sell("2024-02-05", "VTI", 10, 200), // FIFO: Lot A (+$200 gain), Lot B (−$300 loss)
      buy("2024-02-25", "VTI", 10,  60),  // only 60 replacement shares
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 2, "two realized entries");

    // Lot A: gain recognized
    const lotA = nonWarn.find((r) => Math.abs(r.costBasis - 800) < 0.01);
    assert.ok(lotA, "Lot A entry (costBasis = $800)");
    near(lotA.gain, 200, "Lot A gain: 100*(10−8) = $200");
    assert.equal(lotA.washSaleDisallowed, undefined, "Lot A: no wash (gain)");

    // Lot B: 60 of 100 shares replaced → 60% of $300 = $180 disallowed
    const lotB = nonWarn.find((r) => Math.abs(r.costBasis - 1300) < 0.01);  // 100 * $13
    assert.ok(lotB, "Lot B entry (costBasis = $1300)");
    near(lotB.washSaleRawGain, -300, "Lot B raw loss: 100*(10−13) = −$300");
    near(lotB.washSaleDisallowed, 180, "Lot B: 60% replaced → $180 disallowed");
    near(lotB.gain, -120, "Lot B: adjusted gain = −$120 (40% of loss allowed)");

    // Replacement lot: $10 + $180/60 = $10 + $3 = $13/share
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 13, "replacement basis: $10 + $3 = $13");
  });

  // Scenario 14: full liquidation — buy multiple lots on one day, sell all lots
  // on a later day at a loss. No wash sale should be triggered because no
  // replacement shares are retained. The look-back must not treat lots that are
  // themselves being sold today as "replacement purchases".
  it("scenario 14: sell all lots on same day — no wash sale even when lots are in 30-day look-back", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),   // Lot A: $100/share, 10 shares
      buy("2024-01-01", "VTI", 110, 10),   // Lot B: $110/share, 10 shares
      buy("2024-01-01", "VTI", 120, 10),   // Lot C: $120/share, 10 shares
      sell("2024-01-10", "VTI", 90, 10, "2024-01-01"),  // sell lot A at loss
      sell("2024-01-10", "VTI", 90, 10, "2024-01-01"),  // sell lot B at loss
      sell("2024-01-10", "VTI", 90, 10, "2024-01-01"),  // sell lot C at loss
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 3, "three realized entries (one per lot)");

    // No wash sales — position fully liquidated, no replacement lots retained
    for (const r of nonWarn) {
      assert.equal(r.washSaleDisallowed, undefined, `no wash sale on entry with costBasis=${r.costBasis}`);
    }
    near(nonWarn.find((r) => Math.abs(r.costBasis - 1000) < 0.01).gain, -100, "lot A loss: 10*(90-100) = -$100");
    near(nonWarn.find((r) => Math.abs(r.costBasis - 1100) < 0.01).gain, -200, "lot B loss: 10*(90-110) = -$200");
    near(nonWarn.find((r) => Math.abs(r.costBasis - 1200) < 0.01).gain, -300, "lot C loss: 10*(90-120) = -$300");

    assert.equal(unrealized.length, 0, "no remaining lots");
  });

  // Scenario 14b: partial liquidation — 2 of 3 lots sold at loss on same day,
  // lot C retained. Lot C has 10 shares; those 10 shares can only serve as
  // replacement for 10 total loss shares — the first sell uses them all up and
  // the second sell's loss must be fully recognized.
  it("scenario 14b: retained lot covers first loss sell only — replacement capacity is not double-counted", () => {
    const trades = [
      buy("2024-01-01", "VTI", 100, 10),   // Lot A: $100/share, 10 shares
      buy("2024-01-01", "VTI", 110, 10),   // Lot B: $110/share, 10 shares
      buy("2024-01-01", "VTI", 120, 10),   // Lot C: $120/share, 10 shares — RETAINED
      sell("2024-01-10", "VTI", 90, 10, "2024-01-01"),  // sell lot A at loss: −$100
      sell("2024-01-10", "VTI", 90, 10, "2024-01-01"),  // sell lot B at loss: −$200
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 2, "two realized entries");

    // Sell A: lot C (10 shares, in 30-day look-back) covers all 10 loss shares → fully disallowed
    const lotA = nonWarn.find((r) => Math.abs(r.costBasis - 1000) < 0.01);
    assert.ok(lotA, "lot A entry (costBasis = $1000)");
    near(lotA.washSaleRawGain, -100, "lot A raw loss: 10*(90−100) = −$100");
    near(lotA.washSaleDisallowed, 100, "lot A: fully disallowed (lot C is replacement)");
    near(lotA.gain, 0, "lot A adjusted gain = 0");

    // Sell B: lot C's replacement capacity is exhausted — loss must be recognized
    const lotB = nonWarn.find((r) => Math.abs(r.costBasis - 1100) < 0.01);
    assert.ok(lotB, "lot B entry (costBasis = $1100)");
    assert.equal(lotB.washSaleDisallowed, undefined, "lot B: no remaining replacement shares — loss recognized");
    near(lotB.gain, -200, "lot B loss: 10*(90−110) = −$200");

    // Lot C basis adjusted up by $10 (the $100 disallowed / 10 shares)
    assert.equal(unrealized.length, 1, "lot C still held");
    near(unrealized[0].avgCostBasis, 130, "lot C basis: $120 + $10 = $130");
  });

  // Scenario 13: rapid trading with overlapping 61-day windows
  //
  // Three buys and two sells interleaved quickly. The Feb 01 buy serves as the
  // replacement for the Jan 20 loss sale, giving it an inflated basis of $10.
  // When that inflated lot is sold on Feb 15 at $6, the loss is $400 (not $200),
  // and the Mar 10 buy becomes its replacement — deferring the entire $600 of
  // economic losses into Lot C's basis.
  it("scenario 13: overlapping windows — each loss individually deferred, basis chains correctly", () => {
    const trades = [
      buy("2024-01-01",  "VTI", 10, 100),  // Lot A: $10/share
      sell("2024-01-20", "VTI",  8, 100),  // loss = −$200; look-forward replacement: Feb 01
      buy("2024-02-01",  "VTI",  8, 100),  // Lot B: adjusted basis = $8 + $2 = $10/share
      sell("2024-02-15", "VTI",  6, 100),  // Lot B sold; loss = 100*(6−10) = −$400; look-forward: Mar 10
      buy("2024-03-10",  "VTI",  6, 100),  // Lot C: replacement for the Feb 15 sale
    ];
    const { realized, unrealized } = computeGains(trades, NO_MKT);

    const nonWarn = realized.filter((r) => !r.warning);
    assert.equal(nonWarn.length, 2, "two realized entries");

    // Jan 20 sale: $200 disallowed
    const r1 = nonWarn.find((r) => r.date === "2024-01-20");
    assert.ok(r1, "Jan 20 entry exists");
    near(r1.washSaleDisallowed, 200, "Jan 20: $200 disallowed");
    near(r1.gain, 0, "Jan 20: adjusted gain = 0");

    // Feb 15 sale: raw loss uses ADJUSTED basis ($10, not $8) → −$400
    const r2 = nonWarn.find((r) => r.date === "2024-02-15");
    assert.ok(r2, "Feb 15 entry exists");
    near(r2.washSaleRawGain, -400, "Feb 15: raw loss = 100*(6−10) = −$400");
    near(r2.washSaleDisallowed, 400, "Feb 15: $400 disallowed");
    near(r2.gain, 0, "Feb 15: adjusted gain = 0");

    // Lot C (Mar 10): adjusted basis = $6 + $4 = $10/share
    // All $600 of economic losses are now deferred in Lot C's basis
    assert.equal(unrealized.length, 1);
    near(unrealized[0].avgCostBasis, 10, "Lot C: $6 + $400/100 = $10/share");
  });
});
