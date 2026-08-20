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

Attendance was only recorded reliably from **1 July 2026**, so that is the earliest month
the tool can see and the grace window has less to work with than it will once more months
accumulate. The export does not need to run up to today; the page shows the last attendance
date it found so it is clear how current the numbers are.

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

**A 12:00 AM entry is a makeup-redemption marker, never a real session** (real sessions run
1:30–7:30 pm). Its hours credit the month it is dated in, exactly like any other hours, but
it is not treated as evidence of the student's weekly schedule. The report says how many of
a month's hours arrived this way. Hours already attended in the current month that exceed
the month's requirement pay old debt immediately, so a makeup redeemed today clears the
old month today.

**A plan number can mean hours or sessions.** For students whose sessions run 2 hours, a
plan of 4 sometimes means 4 sessions × 2 hours = 8 hours a month, and the plan cannot
always be changed in Radius because it is tied to billing. The tool infers which reading
fits from what full months actually delivered, flags the students it reinterpreted, and
asks in the review queue when the history is too thin to tell. The answer is remembered.

### How to log makeups so the numbers stay exact

One logged hour must equal one delivered hour. Concretely:

- **Never fold a makeup hour into a longer entry.** A student sitting 3–5 pm where one hour
  is their regular session and one is a makeup gets **two** entries: the regular hour at its
  real time, and a separate 1-hour entry at **12:00–1:00 AM** dated to the month being
  credited (same month or a past month). This also makes the Radius session counts come out
  right without inventing filler entries.
- **Date the 12 AM marker on the exact missed date** where possible. The hours land the same
  either way, but the marker then also clears that date from the missed list.
- **When Radius refuses to backdate** (the enrollment plan rolled over at the month
  boundary), log the marker in the current month instead; the two-month grace ledger
  credits it against the oldest debt automatically, and now does so the same day.
- **Genuine 2-hour students keep their honest 2-hour entries.** The rule is only about
  makeup hours hiding inside longer entries.
- **Makeups are not honored beyond the two-month grace.**

**Enrollment dates prorate.** A student who started mid-month only owes the part of the
month they were enrolled for.

**On Hold students are set aside** and their debt is frozen rather than growing.

**Enrolled but never attended** students are reported as a separate list, not mixed in
with students who owe hours.

### A full month with no attendance

If a student has no attendance at all in an elapsed month, enrollment decides the outcome.

**`Enrollment Status` is not used to decide it.** That column describes today. A student who
reads Enrolled now may have been unenrolled, or on hold, during the month in question, so it
cannot testify about a past month.

What decides it is attendance, because **attendance can only be recorded for an enrolled
student**, so a visit on a date proves enrollment on that date. The question becomes whether
the gap is bracketed by evidence of enrollment on both sides. `Enrollment Start Date` and
`Last Attendance Date` extend those brackets past the export window, which matters because
the attendance export begins 1 July 2026 and nothing earlier exists.

| Evidence | Result |
|---|---|
| Enrollment started after the month, or ended before it | Not enrolled, no makeups |
| Nothing after the gap | They stopped coming, no makeups |
| Nothing before the gap | Had not started yet, no makeups |
| Bracketed on both sides | Full plan owed, **flagged** with the month and the evidence |

The last row is granted rather than asserted because an undated hold looks identical to
enrolled-and-absent from outside, and neither export dates holds. The report names the month
so it can be checked by hand.

### The current month

The current month is projected rather than judged. Remaining scheduled sessions are added
to hours already attended. If that projection still falls short of the requirement, the
gap is granted as makeups for the month, so it can be scheduled before the month ends
rather than discovered afterwards.

### Missed dates

Each student's regular weekly schedule is inferred from their attendance history, and every
scheduled date with no attendance is reported as a missed date. Today is never counted as
missed, because attendance is entered at end of day.

## Remembering the exports

Dropped exports are kept in the browser's IndexedDB on that machine, so opening the page
reloads the last pair and re-runs automatically. Raw `.xlsx` bytes are stored rather than
parsed rows, so a later change to the parser cannot leave a stale cache behind.

This is a deliberate trade and the page says so out loud: it moves student names and
enrollment details from "in memory until the tab closes" to "on this machine until
cleared". **Forget stored data** erases it. Nothing is uploaded either way. Works when the
file is opened directly from disk, not only when served.

## Finding a student

The search box above the tabs covers every student in the run, not just the tab on screen,
which is the thing ctrl+F cannot do: a student who owes nothing does not appear on the
Owes tab at all, so there is no text on the page to find. Each result says which list the
student is in, picking one opens their record with the working already expanded, and the
review queue narrows to that student's questions. Press `/` to jump to the box, arrow keys
and Enter to choose, Escape to clear.

## The review queue

The queue is grouped by kind of question, so the answers can be batched: suspected
holds first (with the Radius hold screen open beside it), then unexplained absent
months, students who stopped partway, plan readings, and guessed schedules last.
A hold can be answered with its exact months — "On hold — enter the months" takes a
start and end month straight off the Radius hold screen — or left open-ended for a
student still on hold, which closes itself when a later export shows them enrolled.

## Attendance worth checking

A separate panel lists entries that look odd, for a person to verify in Radius.
Nothing in it changes any number; it only points. It flags entries starting outside
the 1:30–7:30 pm window that are not 12 AM markers (a makeup or a typo), identical
duplicate entries on the same date and time, 2-hour entries for students whose
sessions run 1 hour (the folded-makeup pattern the 12 AM convention replaces),
entries dated in the future, and months running well past their requirement with no
12 AM markers to explain it.


The tool asks rather than waiting to be told. Everything it had to guess becomes a
question with the likely answer marked:

- **A whole month with no attendance.** On hold, enrolled and absent, or not enrolled?
  The hold option is marked likely when the gap lines up with month boundaries, since a
  hold usually does and a holiday usually does not.
  **Not enrolled is only offered when it would actually differ from on hold.** Both owe
  nothing for the month picked; the only difference is that a hold also covers every later
  month until an export shows the student enrolled again. Since a hold closes the moment
  such an export arrives, the two are identical for anyone the roster already reads as
  Enrolled, so that option is hidden there rather than presented as a real choice.
- **Stopped partway through a month.** Away and still owing, or on hold from then?
- **A guessed schedule.** Confirm the inferred days, take the days seen this month, or
  pick them by hand. This is the highest-leverage answer, since the schedule drives both
  missed dates and the current-month projection.

Answers save automatically and an answered question does not come back. **Save answers to
a file** writes a small JSON file; **Load answers** merges one back in rather than
replacing, so loading a colleague's copy cannot silently drop answers given here.

## Hosting it

`index.html` is the whole tool, so any static host works and there is no build step.
`netlify.toml` sets the publish directory to the repo root and adds security headers.

**The page cannot send anything anywhere, and that is enforced rather than promised.** A
Content Security Policy with `connect-src 'none'` blocks fetch, XHR, WebSocket and beacon
outright, so a future change that tried to POST a roster somewhere would be stopped by the
browser. The policy sits in both `netlify.toml` and a `<meta>` tag inside the page itself,
because a server can add headers and a file on a USB stick cannot — the guarantee has to
survive being emailed.

Verified with the deployed headers in force and every outbound request blocked: the report
runs, the exports are remembered across a reload, the Excel download works, and an attempt
to `fetch()` an external URL is refused. Same result opening the file directly from disk.

## Not in scope

Real exports are never committed. They carry personal data for roughly 400 minors, so
`testdata/` is git-ignored and the tool does all of its work in the browser, with no server
and no upload.
