---
name: finance
description: Track finances, analyze spending, monitor subscriptions, calculate runway
triggers:
  - /finance
  - financial
  - spending
  - budget
  - runway
  - subscriptions
requirements:
  env:
    - SUPABASE_URL
    - SUPABASE_ANON_KEY
  tables:
    - financial_snapshots
    - subscriptions
    - budget_targets
agent: marcus
---

# Finance — Personal & Ellie OS Financial Tracking

Marcus uses this skill to track finances, analyze spending patterns, flag unused subscriptions, calculate runway, and generate monthly reports.

## Data Model

**Two separate financial pictures:**
- **Personal** — Dave's personal income/spending
- **Ellie OS** — Business costs (Anthropic, Supabase, domains, infrastructure)

**Tables:**
- `financial_snapshots` — Monthly income and spending by category
- `subscriptions` — Recurring costs (Netflix, Spotify, Anthropic, etc.)
- `budget_targets` — Spending goals by category

## Commands

### `/finance report [month] [type]`
**Purpose:** Monthly summary (income, spending by category, budget variance)

**Parameters:**
- `month` — Optional, defaults to current month (format: `2026-03` or `March`)
- `type` — Optional, `personal` or `ellie_os`, defaults to both

**Query:**
```sql
SELECT * FROM financial_snapshots
WHERE month = '2026-03-01' AND type = 'personal'
ORDER BY month DESC LIMIT 1;

SELECT * FROM budget_targets WHERE type = 'personal';
```

**Output format:**
```
**[Month] [Year] — [Type] Finance**
Income: $X,XXX
Spent: $X,XXX

**By Category:**
- Housing: $X,XXX (Target: $X,XXX) [status icon]
- Food: $XXX (Target: $XXX) [status icon] [variance note]
- Transport: $XXX (Target: $XXX) [status icon] [variance note]
- Subscriptions: $XXX (Target: $XXX) [status icon]
- Other: $X,XXX (Target: $X,XXX) [status icon] [variance note]

**Overall:** [Under/Over/On] budget by $XXX. [Context note].
```

**Status icons:**
- ✅ — On target or under budget
- ⚠️ — Over budget

---

### `/finance subscriptions [type]`
**Purpose:** List active subscriptions, flag unused services

**Parameters:**
- `type` — Optional, `personal` or `ellie_os`, defaults to both

**Query:**
```sql
SELECT * FROM subscriptions
WHERE type = 'personal'
ORDER BY cost DESC;
```

**Output format:**
```
**Active Subscriptions — [Type]**

| Service | Cost | Frequency | Last Used | Status |
|---------|------|-----------|-----------|--------|
| [Service] | $XX.XX | [Monthly/Yearly] | [Date] | [Icon] |

**⚠️ Unused:** [Service] ($XX/mo) — last used [Date]. Cancel, downgrade, or keep?

**Total:** $XXX.XX/month
```

**Status logic:**
- ✅ — Used within 30 days
- ⚠️ — Unused 30-60 days
- 🚨 — Unused 60+ days

---

### `/finance runway [type]`
**Purpose:** Calculate months left at current burn rate

**Parameters:**
- `type` — `personal` or `ellie_os`, required

**Query:**
```sql
SELECT * FROM financial_snapshots
WHERE type = 'ellie_os'
ORDER BY month DESC
LIMIT 3;
```

**Calculation:**
1. Fetch last 3 months of snapshots
2. Calculate average burn rate: `avg(spent - income)`
3. Fetch cash on hand from most recent snapshot metadata
4. Runway = `cash_on_hand / avg_burn_rate`

**Output format:**
```
**[Type] — Runway Calculation**

Cash on Hand: $XXX (as of [date])
Monthly Burn Rate: $XXX (avg of last 3 months)
Months of Runway: X.X months

**Recent Burn:**
- [Month]: $XXX
- [Month]: $XXX
- [Month]: $XXX

[Runway status]: [stable/declining/critical]. [Context note].
```

**Runway status:**
- **Stable** — 6+ months
- **Declining** — 3-6 months
- **Critical** — < 3 months

---

### `/finance budget [type]`
**Purpose:** Show budget targets vs actual spending

**Parameters:**
- `type` — Optional, `personal` or `ellie_os`, defaults to personal

**Query:**
```sql
SELECT * FROM budget_targets WHERE type = 'personal';
SELECT * FROM financial_snapshots
WHERE month = '2026-03-01' AND type = 'personal';
```

**Output format:**
```
**Budget — [Type] ([Month] [Year])**

| Category | Target | Actual | Variance | Status |
|----------|--------|--------|----------|--------|
| [Category] | $X,XXX | $X,XXX | [±$XXX] | [Icon] |
| **TOTAL** | **$X,XXX** | **$X,XXX** | **[±$XXX]** | [Icon] |

[Overall summary]: You're [$XXX over/under] budget this month. [Main culprit if over].
```

---

### `/finance trend [months] [type]`
**Purpose:** Multi-month spending trend (up/down/flat)

**Parameters:**
- `months` — Optional, defaults to 3
- `type` — Optional, `personal` or `ellie_os`, defaults to personal

**Query:**
```sql
SELECT * FROM financial_snapshots
WHERE type = 'personal'
ORDER BY month DESC
LIMIT 3;
```

**Calculation:**
1. Fetch last N months
2. Calculate variance between first and last month
3. Classify trend: < -5% = declining, > +5% = rising, else flat

**Output format:**
```
**Spending Trend — [Type] (last [N] months)**

- [Month]: $X,XXX
- [Month]: $X,XXX
- [Month]: $X,XXX

**Trend:** [Rising/Declining/Flat] ([±X%] variance)
[Context note about trend].
```

---

## Data Entry

**UI Location:** `/finance` page in ellie-home

**Sections:**
1. **Monthly Snapshots** — Enter income and category spending
2. **Subscriptions Manager** — Track recurring costs
3. **Budget Targets** — Set spending goals

Users enter data via the UI, Marcus reads from Supabase.

---

## Rules

- **Currency:** Always format with `$` and commas (e.g., `$1,234.56`)
- **Dates:** Use YYYY-MM-DD for storage, display as "March 2026" in output
- **Default to current month** — If no month specified, use current month
- **Show both types when relevant** — If user doesn't specify personal vs ellie_os, show both
- **Flag stale data** — If most recent snapshot is > 45 days old, warn user
- **Cache calculations** — Store runway and trend calculations in working memory for fast re-access
- **Link to UI** — When user mentions entering data, remind them about the `/finance` page

---

## Error Handling

**No data for requested month:**
> "No financial data for [month] yet. Want to enter it at /finance?"

**Missing budget targets:**
> "No budget targets set. You can add them at /finance to track variance."

**Subscription without last_used date:**
> Assume "never used" and flag as 🚨

**Runway calculation with negative income:**
> Cash on hand is declining. Runway assumes zero income — actual runway may be longer if income resumes.

---

## Integration Points

- **Supabase:** Direct queries to `financial_snapshots`, `subscriptions`, `budget_targets`
- **UI:** ellie-home `/finance` page for data entry
- **Forest:** Write significant findings (e.g., "runway is critical", "subscription waste detected")
- **Proactive:** Marcus can flag unused subscriptions or declining runway in morning briefings
