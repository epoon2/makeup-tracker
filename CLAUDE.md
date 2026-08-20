# Working on this repo

Written for whoever picks this up next, including a Claude session starting cold. Read
this before changing anything; it exists so you do not have to re-derive the rules or
re-ask Jorge questions he has already answered.

---

## What this is

A makeup-hours tracker for the Mathnasium centre in Temple City, CA. It takes two Radius
exports and works out who owes makeup hours, who is behind pace this month, who is on
hold, and who is enrolled but has never attended.

`index.html` is the entire tool: one file, no build step, no dependencies, no server. Open
it in a browser and it works. Everything else in the repo supports it.

| Path | What it is |
|---|---|
| `index.html` | The tool. This is what ships. |
| `reference/` | A second implementation of the same rules in Python, used to check the browser engine's numbers. Not shipped, not required to run anything. |
| `tests/` | Unit tests for the Python side, plus Playwright scripts driving the real page. |
| `netlify.toml` | Static hosting config and security headers. |
| `BASELINE.md` | Expected output on a known pair of exports. Your regression check. |
| `testdata/` | Git-ignored. Where real exports go locally. |

---

## Three things you must not get wrong

**1. Never commit a Radius export.** They carry names, addresses, dates of birth and
medical notes for roughly 400 minors. `.gitignore` covers `testdata/`, `*.xlsx`, `*.xls`
and `*.csv` from the first commit. Before any push:

```bash
git log --all --pretty=format: --name-only | sort -u | grep -Ei 'testdata|\.xlsx|\.xls|\.csv'
```

Empty output is the pass. A file deleted in a later commit is still in the history and
still public the moment you push.

**2. Commits are authored `epoon2 <ethanp0811@gmail.com>` and committed by Jorge.** This
is deliberate and settled. Author is whose work it is, committer is whose hands applied
it; both statements are true as written and GitHub attributes by author.

```bash
GIT_AUTHOR_NAME=epoon2 GIT_AUTHOR_EMAIL=ethanp0811@gmail.com git commit -m "..."
```

with `user.name`/`user.email` set to Jorge. Verify with
`git log --pretty="%h A:%an <%ae> C:%cn"`.

**3. The page must never be able to send anything anywhere.** A Content Security Policy
with `connect-src 'none'` sits in both `netlify.toml` and a `<meta>` tag in `index.html`,
so fetch, XHR, WebSocket and beacon are all blocked by the browser. Do not add a directive
that relaxes it, do not add an external script or font, and do not add analytics. The meta
tag is in the file rather than only in the config because the page gets emailed around and
a file on a USB stick cannot set headers.

---

## Verifying a change

**Always run the in-page self-check first.** Open `index.html`, scroll to the bottom, click
**Run self-check**. It runs 53 assertions against fixed inputs — rounding, date handling,
FIFO settlement, hold coverage, absence resolution, schedule inference, the data horizon —
and needs no exports and no tooling. It takes milliseconds.

It is not decoration. Six deliberate rule breakages were introduced to test it, and it
caught all six: rounding changed to floor, grace widened to three months, hold end made
inclusive, weekday off by one, schedule days uncapped, data horizon ignored.

**Then check the numbers against `BASELINE.md`** using the 8/18 exports. Note: the
20 Aug 2026 changes (markers, plan reading, current-month settlement) can legitimately
shift baseline numbers; regenerate `BASELINE.md` on the next run against real exports
and record what moved and why.

**If you have Python available**, the deeper checks are:

```bash
python3 -m pytest tests -q                      # 24 unit tests on the Python rules
python3 -m reference.run testdata/attendance.xlsx testdata/students.xlsx 2026-08-19
python3 tests/parity_browser.py                 # every field, both engines, all students
python3 tests/e2e_browser.py                    # drop, run, filter, download
python3 tests/csp_browser.py                    # runs with all network blocked
```

The parity script is the strongest check available: it compares the browser engine and the
Python reference field by field across all 380 students. It must report **0 differing**.
Playwright needs a browser; `PLAYWRIGHT_BROWSERS_PATH` is already set in the Cowork sandbox.

**Jorge's Windows machine has git but no node and no npm.** No test runner, no linter, no
dev server. That is why the self-check is in the page. Never hand him a workflow that
needs npm.

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
| FIFO settlement | 960 | The two-month grace ledger. |
| Report assembly | 1011 | Puts a student together and builds the lists. |
| Review queue | 1139 | Generates questions and applies answers. |
| Rendering | 1345 | Cards, tabs, table, detail panels. |
| Writing .xlsx | 1521 | CRC32 plus `CompressionStream`, minimal OOXML. |
| Self-check | 1767 | The 53 assertions. |
| Student search | 1913 | Global search, keyboard handling, focus mode. |

Line numbers drift as soon as you edit. Search for the section title instead.

**Safe to change without deep care:** labels, wording, colours in `:root`, column headers,
card text, the 40-question render cap.

**Change only with the self-check and parity run afterwards:** anything in Dates,
Normalisation, Schedule inference, Whole-month absence, Per-month accounting, FIFO
settlement.

**If you change a rule, change it in `reference/` too**, or parity will fail — which is the
system working, not a nuisance.

---

## The rules, as Jorge set them. Do not re-ask.

**Monthly requirement** is the `Sessions Per Month` value on the attendance rows, in
**hours**: 4, 8 or 12. A 120-minute visit is 2 hours.

**Durations round half-up to the nearest hour.** 58 min is 1, 90 min is 2, under 30 min is
0 and ignored entirely.

**Calendar months.**

**Shortfalls carry a two-month grace, paid FIFO** by later excess hours, oldest first. No
banking forward. Expiry is applied before that month's excess, so a lapsed debt can never
be paid by hours attended after it lapsed.

**Enrolment dates prorate**, by scheduled sessions rather than calendar days.

**Holds cover whole calendar months only.** Nobody is on hold for half a month. A held
month owes nothing, but hours attended during it still pay down earlier debt, because
coming in while on hold is how a student burns off what they owed.

**A hold closes itself** when an export shows the student enrolled again, dated by the
month that export covers rather than by today. Entered for August, with an export on 3
October showing them enrolled: August and September held, October not.

**A whole elapsed month with no attendance** is resolved from evidence, never from current
`Enrollment Status`, which describes today and cannot testify about a past month.
Attendance can only be recorded for an enrolled student, so a visit proves enrolment on
that date. Bracketed on both sides means the full plan is owed and **flagged**; nothing
after means they left; nothing before means they had not started.

**The current month is projected**, not judged: remaining scheduled sessions added to
hours attended, and any gap granted as makeup hours now.

**Attendance only became reliable from 1 July 2026.** There is no earlier data. Do not
suggest re-exporting from further back.

**"Enrolled, never attended" means `Enrollment Status = Enrolled` only.** New and
Pre-Enrolled were tried and produced mostly false alarms.

**A 12:00 AM entry is a makeup-redemption marker** (confirmed by Jorge 20 Aug 2026: real
sessions run only 1:30–7:30 pm, and 12 AM is never legitimate). Marker hours credit the
month they are dated in but are excluded from schedule inference and from plan-reading
evidence. The centre's logging convention is one logged hour = one delivered hour: a
makeup attached to a regular session is logged as two entries, the regular hour at its
real time plus a 1-hour 12 AM marker dated to the month being credited, ideally on the
exact missed date. If the export carries no start times at all, the tool says so in a
warning and markers simply cannot be recognised.

**A plan number can mean hours or sessions** (Jorge, 20 Aug 2026: the 4/month students
with 2-hour sessions cannot be moved to 8/month in Radius, so the tool must infer).
`resolvePlan`/`resolve_plan` compares both readings against the median of completed-month
real hours, needs at least two months of evidence to decide, defaults to hours when
uncertain, asks in the review queue, and honours a pinned `planReading` override.

**Hours already attended in the current month pay old debt immediately** — actual hours,
never the projection, and the current month still never opens a debt of its own.

**Makeups are never honored beyond the two-month grace** (confirmed by Jorge 20 Aug 2026).
The grace dial stays at 2.

---

## Settled decisions. Do not reopen.

- **Current month stays schedule-based.** Pace-based projection was offered with numbers
  and rejected; Jorge wants the weekly schedule inferred as well as possible instead.
- **Never commit real exports.** Not once, not temporarily.
- **No AI call from inside the page.** It is offline by design and that is the property
  that keeps the data local.
- **Storage is deliberate.** Exports and answers persist in IndexedDB, the page says so,
  and there is a Forget stored data button.

## Known limits, honestly

**Schedule inference is the weak point.** With about six weeks of data and schedules that
genuinely change — 70 of 380 students differ between July and August — roughly 149 of 380
schedules cannot be inferred confidently, and those drive most of the granted makeup hours.
Per-month inference was measured as the best of several approaches against the 190 students
who fully met July, but the ceiling is low. **The review queue is the real fix**: a
hand-confirmed schedule beats any inference, and answers persist.

**Two months of history is thin.** Debt cannot yet be settled against a later month, so
the FIFO ledger is mostly idle. It will start doing work as months accumulate.

---

## Deploying

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
