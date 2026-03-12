# Deterministic Assets

Some assets don't need market prices — their value can be computed from a formula. Stonks supports two types: **mortgage equity** (amortization schedule) and **I-bonds** (Treasury composite rate formula). Each appears as a symbol in the chart, history, and exposure tabs, just like a stock or retirement account.

These are defined in `assets.json`:

```json
[
  {
    "type": "mortgage", "name": "Home Equity",
    "purchaseDate": "2024-06-15", "homeValue": 200000,
    "downPayment": 10000, "loanTermYears": 30, "annualRate": 0.0675
  },
  {
    "type": "ibond", "name": "I-Bond",
    "purchaseDate": "2024-01-01", "purchaseValue": 5000, "fixedRate": 0.013,
    "rates": [{ "setDate": "2024-01-01", "semiannualInflation": 0.0197 }]
  }
]
```

## Mortgage equity

Mortgage equity tracks how much of your home you actually own — the home's value minus the remaining loan balance. Each month, part of your mortgage payment goes to principal (building equity) and part goes to interest (not building equity). Early in the loan, most of the payment is interest; later, most is principal.

### The formula

For a fixed-rate mortgage without extra payments, the remaining balance after `m` monthly payments is computed in closed form:

```
r = annualRate / 12                                     (monthly rate)
P = loan × r(1+r)^n / ((1+r)^n - 1)                    (monthly payment)
B = loan × (1+r)^m - P × ((1+r)^m - 1) / r             (remaining balance)
equity = homeValue - max(B, 0)
```

Where `loan = homeValue - downPayment` and `n` is the total term in months.

### Worked example

Given the demo mortgage:
- Home value: $200,000
- Down payment: $10,000 (5%)
- Loan: $190,000
- Rate: 6.75% annual (0.5625% monthly)
- Term: 30 years (360 months)

Monthly payment:

```
r = 0.0675 / 12 = 0.005625
P = 190,000 × 0.005625 × (1.005625)^360 / ((1.005625)^360 - 1)
P = $1,232.34
```

After 12 months (June 2025):

```
factor = (1.005625)^12 = 1.06963
B = 190,000 × 1.06963 - 1,232.34 × (1.06963 - 1) / 0.005625
B = 203,230 - 15,255 = $187,975
equity = 200,000 - 187,975 = $12,025
```

So after one year, equity has grown from the initial $10,000 down payment to about $12,025 — a gain of $2,025 from principal paydown.

### Extra payments

If you make additional principal payments, the app switches to a month-by-month simulation instead of the closed-form formula. Add an `extraPayments` array:

```json
{
  "type": "mortgage", "name": "Home Equity",
  "purchaseDate": "2024-06-15", "homeValue": 200000,
  "downPayment": 10000, "loanTermYears": 30, "annualRate": 0.0675,
  "extraPayments": [
    { "date": "2025-01-15", "amount": 5000 }
  ]
}
```

Each extra payment is applied in the month it falls into, reducing the balance immediately and accelerating equity growth.

### Limitations

The model assumes a **constant home value**. It doesn't account for appreciation or depreciation — the equity growth shown is purely from mortgage paydown. If you want to track home value changes, you'd need to update `homeValue` periodically (which would require redefining the asset).

## I-bonds

Series I savings bonds earn interest based on a composite rate: a fixed rate (set at purchase, never changes) plus a variable inflation rate (updated by the Treasury every 6 months). The Treasury publishes new semiannual inflation rates each May and November.

### The composite rate formula

The Treasury's composite rate combines the fixed and inflation components:

```
compositeRate = fixedRate + (2 × semiannualInflation) + (fixedRate × semiannualInflation)
```

The composite rate is floored at 0 — your bond never loses value, even if inflation goes negative. Interest accrues every 6 months from the purchase date.

### How the Treasury computes value

The Treasury operates in $25 units. A $5,000 bond is 200 units of $25 each. Interest is computed per unit, rounded to the nearest penny at each 6-month period, and the rounded value becomes the basis for the next period:

```
semiannualGrowth = 1 + compositeRate / 2
unitValue = round(unitValue × semiannualGrowth, 2)    (penny rounding)
totalValue = numUnits × unitValue
```

This penny rounding is faithful to how TreasuryDirect actually computes values. A naive approach (continuous compounding on the full value) would drift from the Treasury's numbers over time.

### Worked example

Given the demo I-bond:
- Purchase: $5,000 on 2024-01-01 (200 units of $25)
- Fixed rate: 1.3%
- Semiannual inflation: 1.97% (Jan 2024 rate)

Composite rate:

```
composite = 0.013 + (2 × 0.0197) + (0.013 × 0.0197)
          = 0.013 + 0.0394 + 0.000256
          = 0.052656 (5.27%)
```

Semiannual growth factor:

```
semiannualGrowth = 1 + 0.052656 / 2 = 1.026328
```

After the first 6-month period (July 2024):

```
unitValue = round(25.00 × 1.026328, 2) = $25.66
totalValue = 200 × $25.66 = $5,132.00
```

After the second 6-month period (January 2025), using the same rate:

```
unitValue = round(25.66 × 1.026328, 2) = $26.34
totalValue = 200 × $26.34 = $5,268.00
```

### Updating inflation rates

When the Treasury announces new semiannual rates, add them to the `rates` array:

```json
{
  "rates": [
    { "setDate": "2024-01-01", "semiannualInflation": 0.0197 },
    { "setDate": "2024-07-01", "semiannualInflation": 0.0153 },
    { "setDate": "2025-01-01", "semiannualInflation": 0.0121 }
  ]
}
```

The app applies each rate to the 6-month periods starting from its `setDate`. If a period spans a rate change, the rate in effect at the start of the period is used for the entire period — matching the Treasury's behavior.

### Partial periods

Between 6-month boundaries, the app estimates value using pseudo-monthly compounding:

```
unitValue = round(unitValue × semiannualGrowth^(months/6), 2)
```

This gives a smooth daily value rather than a step function that only changes every 6 months.

## Exposure integration

Deterministic assets participate in the exposure system like any other symbol. Add allocation entries to `config.json`:

```json
"exposure": {
  "allocations": {
    "Home Equity": { "Real Estate": 1.0 },
    "I-Bond": { "Bonds": 1.0 }
  }
}
```

If you don't add an `exposure.allocations` entry for a deterministic asset, it will appear in the chart and Analysis tab but not in the rebalancing tool — which is usually the right behavior for illiquid assets like home equity that you can't trade to rebalance.
