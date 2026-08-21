# Baseline numbers

Regression check. Run the tool against a known pair of exports and compare. If these move
and you did not intend them to, something broke.

## Inputs

- `Student Attendance Report Export  8_20_2026.xlsx` — 3,502 rows, 1 Jul to 19 Aug 2026
- `Students Export  8_20_2026.xlsx` — 1,204 rows

Both are Temple City only. They are not in the repo; keep them in `testdata/`, which is
git-ignored.

## Expected, evaluated as of 20 Aug 2026

The run date matters: it decides which month is "current", so the current-month rows
change if you run on a different day. Everything else is stable for these inputs.

| Figure | Value |
|---|---|
| Students with attendance | 389 |
| Owed makeup hours (past months) | 100 students, 301 hrs |
| To book this month | 141 students, 390 hrs |
| On hold | 3 |
| Enrolled, never attended | 26 |
| Missed dates identified (week-netted) | 1657 |
| Months assumed on hold | 62 |
| Schedules not confidently inferred | 131 of 389 |
| 12 AM makeup-redemption markers recognised | 10 |
| Plan-reading questions in the queue | 24 |
| Attendance audit entries | 142 (110 folded, 18 off-hours, 11 heavy months, 3 duplicates) |

The five cards on the page read **100 / 141 / 3 / 26 / 62**.

Header reads: `Calculating Jul 1, 2026 – Aug 19, 2026 · last attendance Aug 19, 2026 · run <today>`

Review queue: **223 questions** with no answers loaded, grouped by kind.

## Why these differ from the earlier 8/20 baseline

Three rule changes on 20 Aug 2026, all at Jorge's direction: an empty month is now
assumed to be a hold rather than charged (owed drops 780 -> 301 hrs, 62 months assumed
held), missed sessions are netted per week so a moved session is not a missed one
(1859 -> 1657), and the two hour columns were renamed. The audit total is unchanged
at 142.

## Why these differ from the 8/18 baseline

Two things moved at once, deliberately, on 20 Aug 2026: the exports are two days newer,
and the rules changed — 12 AM markers recognised (and kept out of schedule inference),
plan-reading inference added, current-month hours now pay old debt immediately, and the
audit list appeared. The audit's 110 "folded" entries are 2-hour entries for students
whose sessions run 1 hour: the pre-convention attached-makeup pattern, listed for a
person to reconcile, not auto-corrected.

## Checking it

1. Open `index.html`, click **Run self-check** at the bottom. Expect **96 checks passed**.
2. Drop both exports, click Run, compare the five cards above.
3. With Python: `python3 tests/parity_browser.py` must report **0 differing** across all
   students (`TODAY` in that script is pinned to 2026-08-20 for these inputs).
