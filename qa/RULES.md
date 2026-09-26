# CA Meal / Rest / Overtime Rules — validated 2026-09-26

How Expoline's time-clock rules engine maps to current California DIR/DLSE
guidance. Every rule below was re-validated against the cited authoritative
source on 2026-09-26 (Phase 5 audit); the engine encodes them as **config
data** (`CLOCK_CA_DEFAULTS` + `site_config clock_*` overrides), not as legal
conclusions.

> **This document and the configuration it describes are not legal advice.
> Consult employment counsel before relying on these rules for payroll.**

## 1. Meal periods

Source: **DIR — "Meal periods"** (Labor Code § 512; IWC Orders),
https://www.dir.ca.gov/dlse/FAQ_MealPeriods.html

| Rule (DIR) | Implementation |
|---|---|
| > 5 h/day requires a 30-min unpaid meal period | `need1 = h > meal_due_by_hour` (5); `clockCompute` |
| Meal must be **provided no later than the end of the 5th hour** — i.e. must START by the 5th-hour mark (Brinker) | `firstTaken` requires `start_at <= clock_in + 5h`; a meal started at 5.05 h is a violation |
| Meal must be ≥ 30 minutes and duty-free (fully relieved of duty) | `mealBreakOk`: `minsBetween >= meal_break_min (30)` **and** `duty_free === 1`; the API requires the duty-free attestation to end a meal (`POST /api/clock/break/end`) |
| Waivable by mutual consent if total work period ≤ 6 h | `waive1 && h <= meal_waivable_max_shift_h` (6); recorded via `POST /api/clock/break/waive`, eligibility re-checked at clock-out against the *actual* shift length |
| Second 30-min meal required when working > 10 h/day, before end of 10th hour | `need2 = h > second_meal_due_by_hour` (10); `secondTaken` requires start ≤ clock_in + 10 h |
| Second meal waivable (mutual consent) if total ≤ 12 h **and the first meal was not waived** | `waive2 && h <= 12 && firstTaken` |
| On-duty (paid) meals only when the nature of work prevents relief + written agreement (revocable) | Not offered: a meal the employee cannot attest as duty-free stays non-compliant and triggers the premium — the conservative, compliant default |

## 2. Rest periods

Source: **DIR — "Rest periods"** (IWC Wage Orders § 12; *Brinker Restaurant
Corp. v. Superior Court* (2012) 53 Cal.4th 1004),
http://www.dir.ca.gov/dlse/FAQ_RestPeriods.htm

| Rule (DIR/Brinker) | Implementation |
|---|---|
| 10-min **net paid** rest per 4 h **or major fraction thereof** | `restsRequiredFor(h, cfg)` in `server.js` |
| **Major fraction = MORE than 2 h** (strictly greater — DLSE) | `(h % 4) > rest_major_fraction_h` — a 6.0 h shift owes **1** rest, a 10.0 h shift owes **2** (fixed 2026-09-26; the old `>=` over-counted) |
| No rest required when total daily work < 3.5 h | `h < rest_min_shift_h (3.5) → 0` |
| Brinker table: 3.5–6 h → 1; >6–10 h → 2; >10–14 h → 3; and so on | verified by `qa/test25_ca_breaks.py` sweep |
| "Insofar as practicable in the middle of each work period" | `/api/clock/status` reports `due_at` for the next rest at the middle of the next 4-hour block |
| Rest breaks are paid and count as hours worked | rests add no deduction; prompt/attestation flow treats them as paid time |

## 3. Missed-break premiums ("premium pay")

Sources: **DIR meal-period FAQ** ("one additional hour of pay at the
employee's regular rate of pay for each workday that the meal period is not
provided", Labor Code § 226.7; IWC Orders) and **DIR rest-period FAQ**
("one (1) hour of pay at the employee's regular rate of compensation for
each work day that the rest period is not provided"; one hour per workday
even if several rest periods were missed).

| Rule | Implementation |
|---|---|
| 1 extra hour at the **regular rate**, **per violation TYPE per workday** | `premiumCents = (#distinct types) × 1h × rate`; missed meal + missed rest stack (up to 2 h/day); two missed meals in one day do **not** stack |
| Premiums are per **workday**, not per shift | the day summary dedups violation types across all of an employee's shifts on the same site-tz date; any delta vs the per-shift line items is itemized in `adjustments` (`workday_aggregation`) |
| The premium hour is **not** hours worked for overtime | premiums add to `total_cents` only; OT buckets and the weekly-OT pool ignore them |

## 4. Overtime

Source: **DIR — IWC Article 17** (daily-overtime general provisions),
http://www.dir.ca.gov/IWC/IWCArticle17.pdf, and Labor Code § 510 (40 h week).

| Rule (DIR) | Implementation |
|---|---|
| 1.5× regular rate: hours **> 8 up to and including 12** in a workday | `ot15H = min(max(H−8,0), 4)` per workday |
| 1.5×: hours **> 40** in a workweek | weekly extra at +0.5× (1× already paid in the daily rollup), valued at the hours-weighted average 1× rate |
| 1.5×: **first 8 hours on the 7th consecutive day** of work in a workweek | 7th-day uplift: +0.5× on the day's reg hours (see below) |
| 2×: hours **> 12** in a workday | `ot2H = max(H−12, 0)` |
| 2×: hours **> 8 on the 7th consecutive day** | 7th-day uplift: +0.5× on the day's 1.5× hours (hours already at 2× get no uplift) |
| Daily thresholds apply per **workday** (site-tz date), not per shift | the day summary re-buckets multi-shift days (a 5 h + 5 h split shift earns 2 h at 1.5×); per-shift line items keep shift-level truth and the delta is itemized in `adjustments` |
| No pyramiding: an hour already premium-paid is not premium-paid again | weekly-OT extra hours exclude daily-OT hours **and** 7th-day hours; the 7th-day uplift excludes hours already at 2× |

### 7th-consecutive-day interpretation (documented choice)

A workday counts as a 7th consecutive workday when the employee worked each
of the 6 preceding calendar days (any hours > 0). The 6-day lookback may
reach into the prior workweek — consecutive days do not reset on Sunday;
the 7th day itself is always inside the workweek being computed. The uplift
is valued at the **day's hours-weighted average 1× rate** when rates vary
mid-week (same convention as the weekly-OT premium). This is a reasonable
reading of IWC Article 17 § 4(A)–(B); confirm with counsel for edge cases
(e.g. alternative workweeks, split shifts crossing midnight).

## 5. Waivers — handling and logging

- Waivers are **statutory meal waivers only** (`POST /api/clock/break/waive`,
  `meal_seq` 1|2); rest breaks cannot be waived.
- A waiver records a `clock_breaks` row (`waived = 1`) on the shift **and**
  an audit entry (`clock_audit.action = 'meal_waived'`, with employee and
  meal sequence) — added 2026-09-26.
- Eligibility is **re-checked at clock-out against actual shift length**; an
  ineligible waiver (e.g. waived at hour 2, worked 10 h) is ignored and the
  premium applies. Waiving an already-taken meal, or double-waiving, is
  rejected (400).

## 6. Prompts

- `GET /api/clock/status` reports per-break states: `upcoming` → `due`
  (within 30 min of the deadline) → `overdue` (past the deadline).
- Meal 1 prompt: due from 4.5 h elapsed, overdue past 5 h. Meal 2 prompt
  appears once the shift passes 8 h: due from 9.5 h, overdue past 10 h.
- Rest prompt: `due` while required > taken, with `due_at` at the middle of
  the next 4-hour block.
- The prompt "taken" test uses the **same** criteria as the compliance
  engine (≥ 30 min, duty-free, started on time) — a 20-minute meal does not
  clear the prompt.

## 7. Where the rules surface (consult-counsel notes)

- Manager time-clock view (`public/app.js`): footer note names the validated
  defaults and says *"not legal advice — consult employment counsel"*.
- `GET /api/admin/clock/config` and `GET /api/admin/clock/shifts` return
  `notice` / `legal_notice` with the same counsel note.
- `server.js` header comment cites these sources per rule.

## Verification

`qa/test25_ca_breaks.py` encodes the table above as executable assertions
(rest-count sweep incl. the 6.0/10.0/14.0 h boundaries, meal start-timing,
waiver eligibility + audit logging, premium stacking and per-workday caps,
OT buckets, multi-shift workday aggregation, 7th-day uplift, prompt timing,
config/response notices). Run against a scratch server + scratch DB; see
the file header.
