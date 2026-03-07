# Fractional Exposure Tracking

Most portfolio trackers show you what you own — "10 shares of VTI." Stonks goes a step further and shows you what you're *exposed to*. If VTI is a total US market fund that's ~6.7% NVIDIA, and you also hold NVIDIA directly, your true NVIDIA exposure is higher than either position alone suggests.

This matters for concentration risk. If you're running a portfolio with a handful of ETFs plus some individual stocks, the ETFs almost certainly overlap with your individual positions. Fractional exposure tracking makes that overlap visible.

![Analysis — exposure breakdown with NVDA subcategory](screenshots/analysis.png)

## How it works

Every symbol in your portfolio maps to one or more **categories** via the `exposure.allocations` array in `config.json`. Each mapping has a `fraction` — the portion of that symbol's value attributed to the category. Fractions for a given symbol must sum to 1.0.

```json
{
  "exposure": {
    "allocations": [
      { "symbol": "NVDA", "category": "NVDA", "fraction": "1.0" },
      { "symbol": "VTI",  "category": "NVDA", "fraction": "0.067" },
      { "symbol": "VTI",  "category": "Domestic (ex-NVDA)", "fraction": "0.933" },
      { "symbol": "VXUS", "category": "International", "fraction": "1.0" },
      { "symbol": "BND",  "category": "Bonds", "fraction": "1.0" }
    ]
  }
}
```

Here VTI is split: 6.7% of its value counts toward the "NVDA" category, and the remaining 93.3% toward "Domestic (ex-NVDA)." Direct NVDA shares are 100% in the "NVDA" category.

## Worked example

Suppose on a given day your positions are worth:

| Symbol | Value |
|--------|------:|
| NVDA   | $540 |
| VTI    | $6,200 |
| VXUS   | $2,800 |
| BND    | $2,000 |

Applying the fractions:

**NVDA category:**
- Direct NVDA: $540 x 1.0 = $540
- VTI's NVDA slice: $6,200 x 0.067 = $415
- **Total NVDA exposure: $955**

**Domestic (ex-NVDA) category:**
- VTI's non-NVDA slice: $6,200 x 0.933 = $5,783
- **Total: $5,783**

**International:**
- VXUS: $2,800 x 1.0 = $2,800

**Bonds:**
- BND: $2,000 x 1.0 = $2,000

**Portfolio total (mapped): $11,538**

So your true NVDA exposure is $955 / $11,538 = **8.3%**, even though direct NVDA shares are only $540 / $11,538 = 4.7% of the portfolio.

## Retirement and asset accounts

The same allocation system applies to retirement accounts and deterministic assets. A 401k invested in a target-date fund with known allocations can be split across categories:

```json
{ "symbol": "401k", "category": "NVDA",              "fraction": "0.05025" },
{ "symbol": "401k", "category": "Domestic (ex-NVDA)", "fraction": "0.69975" },
{ "symbol": "401k", "category": "International",      "fraction": "0.25" }
```

This 401k is treated as 75% domestic (with the domestic portion split the same way as VTI: 6.7% NVDA, 93.3% non-NVDA) and 25% international. Its interpolated daily value (see [Retirement Accounts](retirement.md)) gets split across those categories, so the Analysis tab reflects your total exposure across all accounts.

An I-bond maps entirely to bonds:

```json
{ "symbol": "I-Bond", "category": "Bonds", "fraction": "1.0" }
```

## Display configuration

The `exposure.display` array controls what rows appear in the Analysis tab table:

```json
{
  "display": [
    { "name": "Domestic Stock", "color": "#3b82f6", "subcategories": "NVDA, Domestic (ex-NVDA)" },
    { "name": "NVDA",           "color": "#76b900", "indent": "true", "category": "NVDA" },
    { "name": "Non-NVDA",       "color": "#6366f1", "indent": "true", "category": "Domestic (ex-NVDA)" },
    { "name": "International Stock", "color": "#f59e0b", "category": "International" },
    { "name": "Bonds",          "color": "#14b8a6", "category": "Bonds" }
  ]
}
```

- **`category`**: maps to a single allocation category. The row's value is the sum of all symbol contributions to that category.
- **`subcategories`**: comma-separated list of categories to sum. Used for group rows that aggregate child rows.
- **`indent`**: renders the row as a sub-row under the preceding group.
- **`color`**: used in the donut chart.

This gives you a hierarchical view: "Domestic Stock" is the sum of NVDA + Non-NVDA, with the two subcategories shown indented beneath it.

## Rebalancing integration

The rebalancing tool (Tools tab) consumes the same category structure. Its `rebalancing.categories` array maps display categories to exposure categories, and `rebalancing.targets` sets the desired percentage for each:

```json
{
  "rebalancing": {
    "categories": [
      { "name": "NVDA", "subcategories": "NVDA" },
      { "name": "Domestic (Ex-NVDA)", "subcategories": "Domestic (ex-NVDA)" },
      { "name": "International Stock", "category": "International" },
      { "name": "Bonds", "category": "Bonds" }
    ],
    "targets": {
      "NVDA": "10",
      "Domestic (Ex-NVDA)": "45",
      "International Stock": "25",
      "Bonds": "20"
    },
    "tradeable": ["NVDA", "VTI", "VXUS", "BND"]
  }
}
```

When you ask "how should I rebalance?", the tool computes the difference between current exposure (using the fractional allocations) and the target percentages, then solves for which tradeable symbols to buy or sell. Because VTI contributes to both the NVDA and Domestic categories, selling VTI affects both — the solver accounts for this.

## Adding a new symbol

When you add a new ticker to your portfolio:

1. Add allocation entries in `config.json` — fractions for the new symbol must sum to 1.0
2. If it belongs to an existing category, you're done
3. If it's a new category, add a `display` entry and optionally a `rebalancing.categories` entry with a target
