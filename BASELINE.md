# Baseline numbers

Regression check. Run the tool against a known pair of exports and compare. If these move
and you did not intend them to, something broke.

## Inputs

- `Student Attendance Report Export  8_18_2026.xlsx` — 3,255 rows, 1 Jul to 17 Aug 2026
- `Students Export  8_18_2026 2.xlsx` — 1,202 rows

Both are Temple City only. They are not in the repo; keep them in `testdata/`, which is
git-ignored.

## Expected, evaluated as of 19 Aug 2026

The run date matters: it decides which month is "current", so the last two rows change if
you run on a different day. Everything above them is stable.

| Figure | Value |
|---|---|
| Students with attendance | 380 |
| Owe makeup hours | 159 students, 744 hrs |
| Behind pace this month | 118 students, 297 makeup hrs granted |
| On hold | 3 |
| Enrolled, never attended | 33 |
| Missed dates identified | 1757 |
| Hours needing a check | 432 |
| Schedules not confidently inferred | 149 of 380 |

The five cards on the page read **159 / 118 / 3 / 33 / 432**.

Header reads: `Calculating Jul 1, 2026 – Aug 17, 2026 · last attendance Aug 17, 2026 · run <today>`

Review queue: **204 questions** with no answers loaded.

## Checking it

1. Open `index.html`, click **Run self-check** at the bottom. Expect **53 checks passed**.
2. Drop both exports, click Run, compare the five cards above.
3. With Python: `python3 tests/parity_browser.py` must report **0 differing** across all
   380 students.

## Data facts worth knowing

- Durations present: 52-86 min (count as 1 hr) and 112-120 min (count as 2). No zero-hour rows.
- Plans: 341 students on 8 hrs, 34 on 4, 5 on 12.
- All 380 attending students match a roster record by name. 18 names appear on more than
  one roster record and are flagged rather than merged.
- `Enrollment Start Date` is blank on 760 of 1,184 roster records, which is why absence
  resolution leans on attendance evidence instead.
- 55 whole-month absences, all bracketed, all flagged, carrying 432 of the 744 owed hours.
