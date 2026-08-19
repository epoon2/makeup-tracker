# Makeup Hours Tracker — Mathnasium Temple City

Takes the two Radius exports and works out who owes makeup hours, who is behind pace,
who is on hold, and who is enrolled but has never attended.

No configuration workbook. No hand-maintained lists. Everything is derived from the two
exports, because a config sheet that has to be kept current by hand goes stale the week
after it is written.

## Inputs

1. **Student Attendance Report Export** — one row per visit.
   Used columns: `Attendance Date`, `First Name`, `Last Name`, `Duration (Minutes)`,
   `Sessions Per Month`, `Lead Id`, `Center`.
2. **Students Export** — one row per student record.
   Used columns: `Student Id`, `First Name`, `Last Name`, `Enrollment Status`,
   `Enrollment Start Date`, `Enrollment End Date`, `Last Attendance Date`, `Center`.

**Export the attendance report starting from the first day of the month two months before
the current month.** The grace window looks back two calendar months, so a shorter export
silently under-reports what students owe.

## Rules

**Monthly requirement** is the `Sessions Per Month` value on the student's attendance rows,
counted in **hours**: 4, 8, or 12. A 120-minute visit counts as 2 hours.

**Durations round to the nearest whole hour.** 56 minutes is 1 hour, 115 minutes is 2 hours.
Rows that round down to 0 hours are ignored entirely — they earn no credit and are not used
to infer a schedule.

**Months are calendar months.**

**Shortfalls carry a two-month grace** and are paid **FIFO** by later excess hours: the
oldest outstanding debt is settled first. Excess hours do not bank forward once all
outstanding debt inside the window is paid. After two calendar months an unpaid shortfall
expires and drops off the report.

**Behind pace** flags a student who is running short of even pace for the current month.

**Enrollment dates prorate.** A student who started mid-month only owes the part of the
month they were enrolled for.

**On Hold students are set aside** and their debt is frozen rather than growing.

**Enrolled but never attended** students are reported as a separate list, not mixed in
with students who owe hours.

### A full month with no attendance

If a student has no attendance at all in an elapsed month, enrollment decides the outcome:

| Enrollment during that month | Result |
|---|---|
| Enrolled | Owed their full plan for the month (4, 8, or 12 hours) as makeups |
| Not enrolled | No makeups owed |
| Cannot be determined | Owed the full plan, **flagged** with the month, so the number is never presented as verified |

The third row exists because `Enrollment Start Date` is blank on a large share of roster
records. The report says which month drove the number so it can be checked by hand.

### The current month

The current month is projected rather than judged. Remaining scheduled sessions are added
to hours already attended. If that projection still falls short of the requirement, the
gap is granted as makeups for the month, so it can be scheduled before the month ends
rather than discovered afterwards.

### Missed dates

Each student's regular weekly schedule is inferred from their attendance history, and every
scheduled date with no attendance is reported as a missed date. Today is never counted as
missed, because attendance is entered at end of day.

## Not in scope

Real exports are never committed. They carry personal data for roughly 400 minors, so
`testdata/` is git-ignored and the tool does all of its work in the browser, with no server
and no upload.
