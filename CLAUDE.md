# Working on this repo

Written for whoever picks this up next, including a Claude session starting cold. Read
this before changing anything; it exists so you do not have to re-derive the rules or
re-ask Ethan questions he has already answered.

---

## What this is

A makeup-hours tracker for the Mathnasium centre in Temple City, CA. It takes two Radius
exports and works out who owes makeup hours, who is behind pace this month, who is on
hold, and who is enrolled but has never attended.

`index.html` is the entire calculator: one file, no build step, no dependencies. Open it in a
browser and it works. On the Netlify site it can also sign in to a **shared copy** (one set of
exports and answers for everyone), served by one Netlify Function. Everything else in the
repo supports those two.

| Path | What it is |
|---|---|
| `index.html` | The tool. This is what ships. |
| `reference/` | A second implementation of the same rules in Python, used to check the browser engine's numbers. Not shipped, not required to run anything. |
| `tests/` | Unit tests for the Python side, plus Playwright scripts driving the real page. |
| `netlify.toml` | Build (runs the server tests, publishes only `index.html`), functions, security headers. |
| `netlify/functions/api.mjs` | The shared copy's server at `/api/*`. Thin: connects the logic to Netlify Blobs and env vars. |
| `netlify/lib/core.mjs` | The server's logic: sign-in, accounts, shared answers, shared exports, the column filter. |
| `package.json` | One dependency, `@netlify/blobs`, pinned. Netlify installs it at build; no computer here needs npm. |
| `tests/api.test.mjs` | Server tests (`npm test`). Netlify runs them on every build; a failure stops the deploy. |
| `tests/shared_server.mjs`, `tests/shared_browser.mjs` | A stand-in of the site, and two real browsers driving shared mode end to end. |
| `BASELINE.md` | Expected output on a known pair of exports. Your regression check. |
| `testdata/` | Git-ignored. Where real exports go locally. |

---

## Four things you must not get wrong

**1. Never commit a Radius export.** They carry names, addresses, dates of birth and
medical notes for roughly 400 minors. `.gitignore` covers `testdata/`, `*.xlsx`, `*.xls`
and `*.csv` from the first commit. Before any push:

```bash
git log --all --pretty=format: --name-only | sort -u | grep -Ei 'testdata|\.xlsx|\.xls|\.csv'
```

Empty output is the pass. A file deleted in a later commit is still in the history and
still public the moment you push.

**2. Commits are authored and committed as `epoon2 <ethanp0811@gmail.com>`.** One name in
the history, both fields, every commit. This is deliberate and settled.

```bash
git config user.name epoon2
git config user.email ethanp0811@gmail.com
```

Verify with `git log --pretty="%h A:%an <%ae> C:%cn <%ce>"`.

**3. The page can talk to its own site and nothing else.** A Content Security Policy with
`connect-src 'self'` sits in both `netlify.toml` and a `<meta>` tag in `index.html`, so
fetch, XHR, WebSocket and beacon can reach only the site's own `/api` (opened from disk,
nothing at all). It was `'none'` until the shared copy (25 Oct 2026); `'self'` is as far
as it goes. Do not add any other origin, an external script or font, or analytics. The
meta tag is in the file rather than only in the config because the page gets emailed
around and a file on a USB stick cannot set headers.

**4. The shared copy keeps only the columns the calculator reads.** `sharedCopy()` in the
page cuts each export down before upload, and `EXPORT_COLUMNS` in `netlify/lib/core.mjs`
refuses any upload carrying another column. If the page starts reading a new column, add it
to both lists, or sharing that export will be refused (which is the system working). Never
widen them to anything the calculation does not use: addresses, birth dates, contacts and
medical notes must never reach the site.

The same goes for answer records: `cleanRecord()` exists in both `index.html` and
`netlify/lib/core.mjs` and must stay identical. A new field in an answer record goes into
both, and into `mergeRecords()` in core.mjs, or it will be dropped on the way to the site.

---

## Verifying a change

**Always run the in-page self-check first.** Open `index.html`, scroll to the bottom, click
**Run self-check**. It runs 126 assertions against fixed inputs — rounding, date handling,
the judged window and standalone months, hold coverage, absence resolution, schedule inference, the data horizon,
session windows, plan reading and per-month plans, a small end-to-end report, and how
shared answers are sent and merged — and needs no exports and no tooling. It takes
milliseconds.

It is not decoration. Six deliberate rule breakages were introduced to test it, and it
caught all six: rounding changed to floor, grace widened to three months, hold end made
inclusive, weekday off by one, schedule days uncapped, data horizon ignored.

**Then check the numbers against `BASELINE.md`** using the 8/18 exports. Note: the
20 Aug 2026 changes (markers, plan reading, current-month settlement) can legitimately
shift baseline numbers; regenerate `BASELINE.md` on the next run against real exports
and record what moved and why.

**If you have Python available**, the deeper checks are:

```bash
python3 -m pytest tests -q                      # 42 unit tests on the Python rules
node tests/synthetic_exports.mjs                # made-up exports into testdata/, when the real ones are not at hand
PARITY_TODAY=2026-10-20 python3 tests/parity_browser.py   # parity on those
python3 -m reference.run testdata/attendance.xlsx testdata/students.xlsx 2026-08-19
python3 tests/parity_browser.py                 # every field, both engines, all students
python3 tests/e2e_browser.py                    # drop, run, filter, download
python3 tests/csp_browser.py                    # runs with all network blocked
```

**For the shared copy** (needs node 22; Netlify runs the first one on every build):

```bash
npm install
npm test                                        # 39 server tests
node tests/shared_browser.mjs                   # two browsers, setup to sign-out (45 checks)
SITE_URL=http://localhost:8888 node tests/shared_browser.mjs   # same, against `netlify dev`
```

The parity script is the strongest check available: it compares the browser engine and the
Python reference field by field across all 380 students. It must report **0 differing**.
Playwright needs a browser; `PLAYWRIGHT_BROWSERS_PATH` is already set in the Cowork sandbox.

**The Windows machine this deploys from has git but no node and no npm.** No test runner,
no linter, no dev server. That is why the self-check is in the page. Never hand over a
workflow that needs npm on that machine: the shared copy's dependency is installed and its
tests are run by Netlify's build, not locally.

---

## Map of `index.html`

Sections in order, each opening with a `/* ---` comment block explaining why it exists.

| Section | Roughly | What it does |
|---|---|---|
| ZIP reader | 205 | Walks the ZIP central directory, inflates with `DecompressionStream`. Handles ZIP64 and the local-header extra-field trap. |
| XLSX sheet reader | 284 | Shared strings, inline strings, serial dates, duplicate header labels. |
| File intake | 380 | Drop zones and the file picker. |
| Remembering the exports | 387 | IndexedDB persistence, restore on open, Forget stored data. |
| Dates | 553 | **UTC day numbers throughout.** Local `Date` objects are the wrong tool: a date parsed at 1am in a negative offset lands on the previous day and moves students onto schedules they do not have. |
| Normalisation | 611 | Rounding, the name join, roster records, duplicate names. |
| Schedule inference | 691 | Per-month inference and the confidence rule. |
| Whole-month absence | 777 | Enrolment decided from evidence, never from current status. |
| Overrides | 809 | Holds, per-month plans, the hold lifecycle. |
| Per-month accounting | 864 | Requirement, proration, missed dates, current-month projection. |
| What is owed | 960 | The judged window and the standalone-month shortfalls. |
| Report assembly | 1011 | Puts a student together and builds the lists. |
| Review queue | 1139 | Generates questions and applies answers. |
| Rendering | 1345 | Cards, tabs, table, detail panels. |
| Writing .xlsx | 1521 | CRC32 plus `CompressionStream`, minimal OOXML. |
| Shared mode | 2590 | Sign-in, accounts, answer sync (`answerPatch`/`adoptAnswers`), shared exports, the pre-sharing offer. |
| Self-check | 3410 | The 126 assertions. |
| Student search | 3770 | Global search, keyboard handling, focus mode. |

Line numbers drift as soon as you edit. Search for the section title instead.

**Safe to change without deep care:** labels, wording, colours in `:root`, column headers,
card text, the 40-question render cap.

**Change only with the self-check and parity run afterwards:** anything in Dates,
Normalisation, Schedule inference, Whole-month absence, Per-month accounting, What is
owed.

**If you change a rule, change it in `reference/` too**, or parity will fail — which is the
system working, not a nuisance.

---

## The rules, as Ethan set them. Do not re-ask.

**Monthly requirement** is the `Sessions Per Month` value on the attendance rows, in
**hours**: 4, 8 or 12. A 120-minute visit is 2 hours.

**Each month uses its own plan** (25 Oct 2026): the `Sessions Per Month` on that month's
rows, the latest row winning; a month with no rows keeps the month before's; months
before the first row take the first known plan. `monthlyPlans`/`monthly_plans`. A current
plan is never applied backwards. The student's plan column shows the latest.

**Durations round half-up to the nearest hour.** 58 min is 1, 90 min is 2, under 30 min is
0 and ignored entirely.

**Calendar months.**

**Only the current month and the two whole months before it are judged** (25 Oct 2026).
Ethan exports attendance from 1 August 2026 to today every time. On 25 October the judged
months are Aug, Sep, Oct; on 1 November Aug drops out. Months are whole, never a rolling
61 days (he confirmed: "on 10/25 judge Aug, Sep, Oct"). Older visits only feed schedule
inference, `monthlyPlans` and plan reading. `JUDGED_MONTHS_BACK = 2`, `judgedWindow` in
the page, `judged_window` in `reference/report.py`.

**Each month stands alone** (25 Oct 2026, replacing the FIFO grace ledger). Ethan's golden
rule: a completed month owes makeup hours only if that month's own hours fell short of its
plan ("just look at all of their August sessions and see if it meets the minimum
requirement"). Extra hours in one month never pay another month, and never bank forward.
`settle` returns one debt per completed, non-held, short month and nothing else. Do not
reintroduce FIFO or cross-month payment.

**Enrolment dates prorate**, by scheduled sessions rather than calendar days.

**Holds cover whole calendar months only.** Nobody is on hold for half a month. A held
month owes nothing. Since 25 Oct 2026 hours attended during it no longer pay any other
month (each month stands alone).

**A hold closes itself** when an export shows the student enrolled again, dated by the
month that export covers rather than by today. Entered for August, with an export on 3
October showing them enrolled: August and September held, October not.

**A whole elapsed month with no attendance** is resolved from evidence, never from current
`Enrollment Status`, which describes today and cannot testify about a past month.
Attendance can only be recorded for an enrolled student, so a visit proves enrolment on
that date. Nothing after means they left; nothing before means they had not started.
**Bracketed on both sides is assumed to be a HOLD** (decided 20 Aug 2026: a student with
no attendances for a whole month is assumed to have been on hold). Nothing is
owed, and a `charged` override charges the full plan instead. This
replaced the old charge-and-flag behaviour and moved the real-data totals from
160 students / 780 hrs owed to 100 / 301, with 62 months assumed held.
**Not asked about** (decided 25 Oct 2026: "a hold or a break"): no review-queue
question; the month's line in the student's panel has a charge button and an undo.

**Missed sessions are netted per ISO week in both engines.** A week is short only by
`attended - (scheduled - missed)`; the earliest scheduled days are forgiven first. This
is the fix for week-to-week schedule drift and removed 202 phantom misses from the real
export (1859 -> 1657). Do not revert to exact-weekday judging.

**Nothing a person answers is permanent.** Per-hold remove buttons plus a per-student
"Clear and ask again" that deletes the whole override record. Assume answers will be
wrong sometimes: misclicks and changing schedules are normal, not exceptional.

**The current month is projected**, not judged: remaining scheduled sessions added to
hours attended, and any gap granted as makeup hours now.

**Attendance only became reliable from 1 July 2026.** There is no earlier data. Do not
suggest re-exporting from further back. Since 25 Oct 2026 the export Ethan uses starts on
1 August 2026.

**"Enrolled, never attended" means `Enrollment Status = Enrolled` only.** New and
Pre-Enrolled were tried and produced mostly false alarms.

**A visit outside the session windows is a makeup** (25 Oct 2026, the same
windows as the Radius roster tool's Time In / Time Out, all year round, no summer
exception): Mon, Tue, Thu, Fri 2:45–7:15 PM; Wed 1:45–7:15 PM; Sat 8:45 AM–1:15 PM;
Sunday closed. Regular only if it STARTS no earlier than the window opens AND ENDS no
later than it closes (Ethan: "not the end time, the start time... and same with the end
time"). The end is Departure Time (`END_TIME_COLUMNS`), else start + Duration (Minutes).
`SESSION_WINDOWS`/`isMakeupTime`/`endMinutesFor` in the page, `SESSION_WINDOWS`/
`is_makeup_time`/`end_minutes_for` in `reference/loaders.py`. Departure Time is one of the
columns the shared copy keeps (both column lists). A 12:00 AM entry is the commonest case (confirmed 20 Aug 2026:
12 AM is never legitimate). Makeup ("marker") hours credit the
month they are dated in, and only that month, but are excluded from schedule inference and from plan-reading
evidence, and are never audited. The centre's logging convention is one logged hour = one delivered hour: a
makeup attached to a regular session is logged as two entries, the regular hour at its
real time plus a 1-hour 12 AM marker dated to the month being credited, ideally on the
exact missed date. If the export carries no start times at all, the tool says so in a
warning and markers simply cannot be recognised.

**A plan number can mean hours or sessions** (confirmed 20 Aug 2026: the 4/month students
with 2-hour sessions cannot be moved to 8/month in Radius, so the tool must infer).
`resolvePlan`/`resolve_plan`: with two or more completed months, the median of each
month's real hours as a multiple of that month's plan, against 1 (hours) or the session
length (sessions). With fewer, or a tie (25 Oct 2026), the weekly pattern: real hours per
week attended, over at least three weeks, x 52/12, against the current plan, decided only
when one reading is at most half as far off as the other. Defaults to hours when
uncertain, asks in the review queue only then, and honours a pinned `planReading`.

**Above-plan attendance is a note, not a flag** (25 Oct 2026). When regular (non-makeup)
hours reach the next plan tier (4 -> 8 -> 12) in each of the last three completed,
non-held months on an unchanged plan, the student's panel says "Likely on a 12/month
plan" (inferred). A plan change visible in the export is noted at once as confirmed.
Both are recomputed every run, so they disappear when the facts change. Notes are not
"to check" flags.

**Shared names** (25 Oct 2026): a student who re-enrolled has old roster records under the
same name; the live one is used without a flag. Two students sharing a name are told
apart in Radius with " *" after the last name ("Jacob Chan *"), a different name here.
Only two Enrolled records under exactly one name are flagged.

**The current month never opens a debt of its own**; its gap shows as hours to book now.
Its hours do not pay earlier months (that rule, "current-month hours pay old debt
immediately", ended with FIFO on 25 Oct 2026).

**Makeups are owed only for the two completed months being judged** (confirmed 20 Aug
2026 as the two-month grace; kept as the judged window on 25 Oct 2026). A makeup has to be
dated in the month it makes up. When Radius will not backdate, the tracker cannot tell, and
that month still shows short.

**Radius has a per-student hold screen with exact start and end dates** (found
20 Aug 2026; every observed hold is whole calendar months). The queue's hold questions
accept a month range for this reason. **If that screen can be exported, build the
importer**: a third optional drop zone that turns hold periods into closed hold
overrides and removes hold questions from the queue entirely. Waiting on a sample
export to learn its columns; do not guess the format.

**The audit panel asks; answers correct the numbers** (changed 20 Aug 2026
from the earlier points-only design). Answers are stored as `auditChecked`
ids plus `hourAdjust` per-month deltas in overrides; the deltas are applied to a
month's attended hours in BOTH engines (`hour_adjust` in `reference/months.py`).
**Since 25 Oct 2026 it lists only duplicates and future-dated entries.** Off-hours
entries are makeups now; heavy months and 2-hour entries for 1-hour students were
dropped at Ethan's request (extra hours are fine). The audit only looks at visits inside
the judged months. Earlier
`hourAdjust` corrections still apply.

**Holds can be exact dates.** `holdDates` overrides carry mid-month periods; a period
covering every scheduled day acts as a whole-month hold, and a partial one prorates
the month by the scheduled sessions it covers (both engines). Month-aligned typed
dates are converted to clean month holds by `holdEntryFromDates`. Radius has no bulk
hold export (verified in the live site 20 Aug 2026: Reports has none, the Student
Management Excel export lacks hold dates); holds are read per student from
Students -> Student Management -> student -> Enrollments -> Holds, which is why the
tool takes typed dates. The internal JSON endpoints (`/Student/Enrollment_Read/{id}`,
`/Student/Hold_Read`) exist if a fetcher is ever wanted; the tradeoff was weighed and
declined for now.

---

## Settled decisions. Do not reopen.

- **Current month stays schedule-based.** Pace-based projection was offered with numbers
  and rejected; the weekly schedule is inferred as well as possible instead.
- **Never commit real exports.** Not once, not temporarily.
- **No AI call from inside the page.** It talks to its own site and nothing else, and that
  is the property that keeps the data where it belongs.
- **Storage is deliberate.** On one computer, exports and answers persist in IndexedDB, the
  page says so, and there is a Forget stored data button. Signed in, they live on the
  site's own Netlify Blobs instead and nothing is kept in the browser.
- **Shared copy sign-in is a username and a password, no email** (decided 25 Oct 2026).
  First admin via `SETUP_CODE`; admins add people with temporary passwords and reset
  forgotten ones. Do not add email, magic links or third-party sign-in.

## Known limits, honestly

**Schedule inference is the weak point.** With about six weeks of data and schedules that
genuinely change — 70 of 380 students differ between July and August — roughly 149 of 380
schedules cannot be inferred confidently, and those drive most of the granted makeup hours.
Per-month inference was measured as the best of several approaches against the 190 students
who fully met July, but the ceiling is low. **The review queue is the real fix**: a
hand-confirmed schedule beats any inference, and answers persist.

**The "likely on a bigger plan" note needs three completed months.** It reads every month
in the export, so with an export starting 1 August it cannot appear before November.

---

## Deploying

**How Ethan deploys:** he uploads through GitHub's web page (Add file → Upload files) onto
the `development` branch, one commit per update. Hand him a zip of **only the files that
changed**, each in its folder (e.g. `makeup-tracker/netlify/lib/core.mjs`), and list them.

Push to `main` and Netlify redeploys. Push a branch and Netlify builds a preview at its own
URL without touching the live site — that is the closest thing to staging, and it needs no
local tooling:

```bash
git checkout -b try-something
# edit, run the self-check
git commit -am "..."
git push -u origin try-something
```

Netlify posts the preview URL. Merge to `main` when it looks right, or delete the branch.

A preview's shared copy is separate from the live one (`netlify/functions/api.mjs` picks
`preview-` stores for any deploy that is not production). It starts empty: set it up with
the same SETUP_CODE, and nothing done there touches the live accounts, exports or answers.

Every Netlify build runs `npm test` first; a failing server test stops the deploy.

**Credits.** On Netlify's credit plans each successful production deploy (a commit on
`main`) costs 15 credits of the free plan's 300 a month. Branch deploys, deploy previews
and failed deploys cost nothing. So: test on `development` (its branch deploy is
switched on in Netlify), merge into `main` when it works, and upload a change as one
commit. `ignore` in `netlify.toml` skips builds for commits that change only unserved
files (notes, tests, `reference/`); `[skip ci]` in a commit message skips one by hand.
