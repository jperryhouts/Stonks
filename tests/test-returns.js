const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeReturns } = require("../app/js/returns.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function days(n) {
  const d = new Date("2024-01-01");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Build a synthetic chartData where portfolio grows linearly from start to end
// over N+1 daily entries (days 0..N), with no intra-day variation.
function linearChart(startVal, endVal, numDays) {
  const out = [];
  for (let i = 0; i <= numDays; i++) {
    const frac = numDays === 0 ? 1 : i / numDays;
    out.push({ date: days(i), total: startVal + (endVal - startVal) * frac });
  }
  return out;
}

function close(a, b, tol = 0.0001) {
  return Math.abs(a - b) < tol;
}

// ---------------------------------------------------------------------------
// TWR — no cash flows
// ---------------------------------------------------------------------------

describe("computeReturns TWR no cash flows", () => {
  it("returns 10% annualized for exactly 1-year 10% gain with no trades", () => {
    const cd = linearChart(10000, 11000, 365);
    const { twr } = computeReturns(cd, [], days(0), days(365));
    assert.ok(twr !== null, "twr should not be null");
    assert.ok(close(twr, 0.10, 0.001), `expected ~0.10, got ${twr}`);
  });

  it("returns null when window has fewer than 2 days of data", () => {
    const cd = [{ date: days(0), total: 10000 }];
    const { twr, xirr } = computeReturns(cd, [], days(0), days(0));
    assert.equal(twr, null);
    assert.equal(xirr, null);
  });
});

// ---------------------------------------------------------------------------
// TWR — with cash flows (must strip their effect)
// ---------------------------------------------------------------------------

describe("computeReturns TWR strips cash flows", () => {
  it("TWR is same as simple return when a buy occurs mid-window on a flat price day", () => {
    // Day 0: 100 shares at $100 = $10,000
    // Day 182: price stays $105, buy 50 shares @ $105 → portfolio = $15,750, CF = $5,250
    // Day 365: price rises to $110 → 150 shares = $16,500
    //
    // Sub-period 1: 10000 → 10500 (days 0-182, price $100→$105): 5% over ~182 days
    // Day 182 trade: HPR = (15750 - 5250)/10500 - 1 = 0 (price flat on trade day)
    // Sub-period 2: 15750 → 16500 (days 182-365, price $105→$110): ~4.76%
    // Chain: (1.05)(1.00)(1.0476) ≈ 1.10 → ~10% over 365 days → annualized ≈ 10%

    const cd = [];
    for (let i = 0; i <= 365; i++) {
      let price, shares;
      if (i < 182) {
        price = 100 + (5 / 182) * i;    // $100 → $105 over 182 days
        shares = 100;
      } else {
        price = 105 + (5 / 183) * (i - 182); // $105 → $110 over 183 days
        shares = 150;
      }
      cd.push({ date: days(i), total: shares * price });
    }

    const trades = [
      { date: days(182), symbol: "VTI", price: "105", quantity: "50" },
    ];

    const { twr } = computeReturns(cd, trades, days(0), days(365));
    assert.ok(twr !== null);
    // TWR should be ~10% (annualized over 365 days), regardless of the mid-window buy
    assert.ok(close(twr, 0.10, 0.01), `expected ~0.10, got ${twr}`);
  });
});

// Flat chartData with an optional one-time step up on stepDay (simulates a
// contribution landing in an account with no market movement on its own).
function flatChart(startVal, numDays, stepDay, stepAmount) {
  const out = [];
  for (let i = 0; i <= numDays; i++) {
    out.push({ date: days(i), total: i >= stepDay ? startVal + stepAmount : startVal });
  }
  return out;
}

// ---------------------------------------------------------------------------
// XIRR — simple cases
// ---------------------------------------------------------------------------

describe("computeReturns XIRR", () => {
  it("returns 10% for invest $10k today, receive $11k in exactly 1 year", () => {
    // chartData: starts at 10000, ends at 11000
    // No trades in window; initial portfolio treated as lump sum
    const cd = linearChart(10000, 11000, 365);
    const { xirr } = computeReturns(cd, [], days(0), days(365));
    assert.ok(xirr !== null, "xirr should not be null");
    assert.ok(close(xirr, 0.10, 0.001), `expected ~0.10, got ${xirr}`);
  });

  it("returns null for empty/flat zero-value portfolio", () => {
    const cd = linearChart(0, 0, 365);
    const { xirr } = computeReturns(cd, [], days(0), days(365));
    assert.equal(xirr, null);
  });
});

// ---------------------------------------------------------------------------
// Retirement account contributions
//
// renderMetrics converts retirement.contributions entries into synthetic buy
// trades of the form { date, quantity:"1", price:amount, type:"buy" } before
// calling computeReturns.  These tests exercise that path directly against
// computeReturns to verify both TWR stripping and XIRR accounting.
// ---------------------------------------------------------------------------

describe("computeReturns retirement account contributions", () => {
  it("XIRR is exactly 0% when total contributions equal the terminal gain", () => {
    // $10k start, $1k contribution at day 182, $11k end — no real market gain.
    // NPV at r=0: −10000 − 1000 + 11000 = 0  →  XIRR = 0% exactly.
    const cd = flatChart(10000, 365, 182, 1000);
    const trades = [{ date: days(182), quantity: "1", price: "1000", type: "buy" }];
    const { xirr } = computeReturns(cd, trades, days(0), days(365));
    assert.ok(xirr !== null, "xirr should not be null");
    assert.ok(close(xirr, 0, 0.0001), `expected XIRR = 0, got ${xirr}`);
  });

  it("XIRR is lower with a contribution than without for the same terminal value", () => {
    // Without contribution: $10k → $11k  →  XIRR ≈ 10%.
    const cdClean = linearChart(10000, 11000, 365);
    const { xirr: xirrClean } = computeReturns(cdClean, [], days(0), days(365));

    // With $1k contribution at day 182 and the same $11k terminal value  →  XIRR = 0%.
    // Investor put in $11k total and got $11k back, so real return is zero.
    const cdContrib = flatChart(10000, 365, 182, 1000);
    const trades = [{ date: days(182), quantity: "1", price: "1000", type: "buy" }];
    const { xirr: xirrContrib } = computeReturns(cdContrib, trades, days(0), days(365));

    assert.ok(xirrClean !== null && xirrContrib !== null);
    assert.ok(
      xirrContrib < xirrClean,
      `XIRR with contribution (${xirrContrib}) should be less than without (${xirrClean})`
    );
  });

  it("TWR strips contribution and matches the underlying market return", () => {
    // Two equal sub-periods of 91 days each, both with 5% market gain.
    // A: no contribution.
    const cdA = [];
    for (let i = 0; i <= 182; i++) {
      const total =
        i <= 91
          ? 10000 * (1 + 0.05 * (i / 91))
          : 10000 * 1.05 * (1 + 0.05 * ((i - 91) / 91));
      cdA.push({ date: days(i), total });
    }
    const { twr: twrA } = computeReturns(cdA, [], days(0), days(182));

    // B: same market rate, but a $5,000 contribution lands on day 91.
    // From day 91 onward the account holds $15,500 (market + contribution), growing
    // at the same 5% rate.  Day 91's total must INCLUDE the contribution because
    // computeReturns strips it from that day's HPR using the cfMap.
    const cdB = [];
    for (let i = 0; i <= 182; i++) {
      let total;
      if (i < 91) {
        total = 10000 * (1 + 0.05 * (i / 91));
      } else {
        const rate = 1 + 0.05 * ((i - 91) / 91);
        total = (10000 * 1.05 + 5000) * rate; // both original and contribution grow
      }
      cdB.push({ date: days(i), total });
    }
    const tradesB = [{ date: days(91), quantity: "1", price: "5000", type: "buy" }];
    const { twr: twrB } = computeReturns(cdB, tradesB, days(0), days(182));

    assert.ok(twrA !== null && twrB !== null);
    assert.ok(
      close(twrA, twrB, 0.002),
      `TWR with contribution (${twrB}) should match market-only TWR (${twrA})`
    );
  });

  it("contribution before window start is ignored", () => {
    const cd = linearChart(10000, 11000, 365);
    const trades = [{ date: days(-1), quantity: "1", price: "5000", type: "buy" }];
    const { twr, xirr } = computeReturns(cd, trades, days(0), days(365));
    const { twr: twrClean, xirr: xirrClean } = computeReturns(cd, [], days(0), days(365));
    assert.ok(close(twr, twrClean, 0.0001), "pre-window contribution should not affect TWR");
    assert.ok(close(xirr, xirrClean, 0.0001), "pre-window contribution should not affect XIRR");
  });

  it("contribution after window end is ignored", () => {
    const cd = linearChart(10000, 11000, 365);
    const trades = [{ date: days(366), quantity: "1", price: "5000", type: "buy" }];
    const { twr, xirr } = computeReturns(cd, trades, days(0), days(365));
    const { twr: twrClean, xirr: xirrClean } = computeReturns(cd, [], days(0), days(365));
    assert.ok(close(twr, twrClean, 0.0001), "post-window contribution should not affect TWR");
    assert.ok(close(xirr, xirrClean, 0.0001), "post-window contribution should not affect XIRR");
  });

  it("multiple contributions are each treated as investor outflows in XIRR", () => {
    // $10k start + $500 at day 121 + $500 at day 243 = $11k end.
    // NPV at r=0: −10000 − 500 − 500 + 11000 = 0  →  XIRR = 0% exactly.
    const cd = [];
    for (let i = 0; i <= 365; i++) {
      const total = i < 121 ? 10000 : i < 243 ? 10500 : 11000;
      cd.push({ date: days(i), total });
    }
    const trades = [
      { date: days(121), quantity: "1", price: "500", type: "buy" },
      { date: days(243), quantity: "1", price: "500", type: "buy" },
    ];
    const { xirr } = computeReturns(cd, trades, days(0), days(365));
    assert.ok(xirr !== null, "xirr should not be null");
    assert.ok(close(xirr, 0, 0.001), `expected XIRR = 0 for zero net return, got ${xirr}`);
  });

  it("drip trade does not affect TWR (treated as organic portfolio growth, not external cash)", () => {
    // Same chartData whether or not we record the drip — TWR should be identical
    const cd = linearChart(10000, 11000, 365);
    const drip = [{ date: days(182), symbol: "VTI", price: "100", quantity: "0.5", type: "drip" }];
    const { twr: twrWithDrip } = computeReturns(cd, drip, days(0), days(365));
    const { twr: twrNoDrip } = computeReturns(cd, [], days(0), days(365));
    assert.ok(twrWithDrip !== null && twrNoDrip !== null);
    assert.ok(
      close(twrWithDrip, twrNoDrip),
      `drip should not affect TWR: with=${twrWithDrip}, without=${twrNoDrip}`
    );
  });

  it("drip trade does not affect XIRR (not counted as investor outflow)", () => {
    // Same chartData — XIRR should be identical with or without the drip trade
    const cd = linearChart(10000, 11000, 365);
    const drip = [{ date: days(182), symbol: "VTI", price: "100", quantity: "0.5", type: "drip" }];
    const { xirr: xirrWithDrip } = computeReturns(cd, drip, days(0), days(365));
    const { xirr: xirrNoDrip } = computeReturns(cd, [], days(0), days(365));
    assert.ok(xirrWithDrip !== null && xirrNoDrip !== null);
    assert.ok(
      close(xirrWithDrip, xirrNoDrip),
      `drip should not affect XIRR: with=${xirrWithDrip}, without=${xirrNoDrip}`
    );
  });

  it("drip has higher XIRR than an equivalent buy for the same portfolio value", () => {
    // Buy of same amount is counted as investor outflow → lowers XIRR
    // Drip is not → XIRR equals the no-trade baseline
    const cd = linearChart(10000, 11000, 365);
    const drip = [{ date: days(182), symbol: "VTI", price: "100", quantity: "0.5", type: "drip" }];
    const buyTrade = [{ date: days(182), symbol: "VTI", price: "100", quantity: "0.5", type: "buy" }];
    const { xirr: xirrDrip } = computeReturns(cd, drip, days(0), days(365));
    const { xirr: xirrBuy } = computeReturns(cd, buyTrade, days(0), days(365));
    assert.ok(xirrDrip !== null && xirrBuy !== null);
    assert.ok(
      xirrDrip > xirrBuy,
      `drip XIRR (${xirrDrip}) should be higher than buy XIRR (${xirrBuy})`
    );
  });

  it("withdrawal (negative amount) is treated as an investor inflow and increases XIRR", () => {
    // Without withdrawal: $10k → $11k  →  XIRR ≈ 10%.
    const cd = linearChart(10000, 11000, 365);
    const { xirr: xirrClean } = computeReturns(cd, [], days(0), days(365));

    // With $1k withdrawal at day 182 on the same portfolio: investor receives $1k
    // mid-period AND the account still ends at $11k  →  XIRR > 10%.
    const trades = [{ date: days(182), quantity: "1", price: "-1000", type: "buy" }];
    const { xirr: xirrWithdrawal } = computeReturns(cd, trades, days(0), days(365));

    assert.ok(xirrClean !== null && xirrWithdrawal !== null);
    assert.ok(
      xirrWithdrawal > xirrClean,
      `XIRR with withdrawal (${xirrWithdrawal}) should exceed without (${xirrClean})`
    );
  });
});
