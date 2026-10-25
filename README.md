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

Run the attendance export from **1 August 2026** to today each time. The calculator only
judges the last two whole months and the current one (see *Which months are judged*);
anything older in the export is used only to read schedules and plans. The export does not
need to run up to today; the page shows the last attendance date it found so it is clear
how current the numbers are.

## Rules

**Monthly requirement** is the `Sessions Per Month` value on the student's attendance rows,
counted in **hours**: 4, 8, or 12. A 120-minute visit counts as 2 hours.

**Each month uses its own plan.** The plan for a month is the `Sessions Per Month` on that
month's rows (the latest row wins). A month with no rows keeps the month before's plan.
So a plan changed in Radius from 8 to 12 in September counts as 8 for July and August and
12 from September, and a student's current plan is never applied backwards. The
student's panel notes the change.

**Durations round to the nearest whole hour.** 56 minutes is 1 hour, 115 minutes is 2 hours.
Rows that round down to 0 hours are ignored entirely — they earn no credit and are not used
to infer a schedule.

**Months are calendar months.**

**Which months are judged.** The current month and the two whole months before it. On
25 October that is August, September and October; on 1 November August drops off and it is
September, October and November. Months are judged whole: all of August counts, whatever
day of the month it is today. Older visits in the export still help work out a student's
weekly schedule and what their plan number means, but nothing is owed for those months.

**Each month stands alone.** A completed month owes makeup hours only if that month's own
hours fell short of its plan: add up every August visit (makeups dated in August included)
and compare with August's requirement. Extra hours in a later month never pay off an
earlier one, and extra hours never bank forward.

**Behind pace** flags a student who is running short of even pace for the current month.

**The two hour columns.** *Makeup hrs owed* is how far each of the two completed months
fell short, added up: hours the student is entitled to book. The student's panel lists them
month by month ("Aug 2026: 1 hr(s) short"). *Hrs to book now* is what the current month is
still short after projecting the sessions left in it, so it shrinks on its own as they
attend.

**A month with no attendance at all is taken as a hold or a break.** Charging a full
plan for a month nobody attended manufactures makeup hours nobody will ever book, and
at this centre an empty month is nearly always a hold or a break.
- Nothing is owed for it, and the review queue does not ask about it.
- If a student really was enrolled and absent, the month's line in their panel has a
  button to charge it, and an **undo**.

**Missed sessions are netted within each week.** Schedules drift: a Tue/Thu student
who comes Monday and Wednesday one week has moved their sessions, not missed them. A
week counts as short only by how many fewer sessions were attended than scheduled,
and the earliest scheduled days are the ones forgiven.

**A visit outside the session windows is a makeup, never a regular session.** A visit is
regular only if it **starts** no earlier than its day's window opens **and ends** no later
than it closes. The windows are the same all year, summer included:

| Days | Window |
|---|---|
| Mon, Tue, Thu, Fri | 2:45–7:15 PM |
| Wed | 1:45–7:15 PM |
| Sat | 8:45 AM–1:15 PM |
| Sun | closed, so any visit is a makeup |

- A Monday visit starting at 2:30 PM is a makeup, and so is one running 6:30 to 7:30 PM.
- The end is the export's Departure Time, or the start plus the minutes logged when that
  column is missing.
- The 12:00 AM marker is the most common makeup entry.
- A makeup's hours credit the month it is dated in, like any other hours, and only that
  month. To make up August, the makeup has to be dated in August.
- Makeups are not evidence of the weekly schedule or of what the plan means, and they
  are never flagged as odd.
- The student's panel tags them "makeup" and says how many of each month's hours were
  makeups.

**A plan number can mean hours or sessions.** For students whose sessions run 2 hours, a
plan of 4 sometimes means 4 sessions × 2 hours = 8 hours a month, and the plan cannot
always be changed in Radius because it is tied to billing. The tool reads it from what the
student attends:
- With two or more completed months, it compares what those months delivered.
- With fewer, it uses their weekly pattern: one 2-hour session a week is about 8.7 hours
  a month, so it is 8 hours, not 8 two-hour sessions.

It asks in the review queue only when neither can tell. The answer is remembered.

**A student coming at the next plan level is noted, not flagged.** Extra hours are not a
problem. But if a student's regular (non-makeup) hours reach the next
plan level (8 on a 4, 12 on an 8) for each of the last three completed months, their panel
says they are likely on that plan. This looks at every month in the export, not only the
judged ones, so with an export starting 1 August the first such notes can appear in
November. The note is inferred from attendance, and it disappears
as soon as a month drops back. A plan change that Radius itself shows is noted at once, as
confirmed.

**Names.** A student who left and re-enrolled has old roster records under the same name.
The tracker uses the live one without fuss. Two students who share a name are told apart in
Radius with " *" after the last name ("Jacob Chan *"), which the tracker treats as a
different name. It warns only when two **Enrolled** records have exactly the same name.

### How to log makeups so the numbers stay exact

One logged hour must equal one delivered hour. Concretely:

- **Never fold a makeup hour into a longer entry.** A student sitting 3–5 pm where one hour
  is their regular session and one is a makeup gets **two** entries: the regular hour at its
  real time, and a separate 1-hour entry at **12:00–1:00 AM** dated to the month being
  credited (same month or a past month). This also makes the Radius session counts come out
  right without inventing filler entries.
- **Date the 12 AM marker in the month it makes up**, on the exact missed date where
  possible. A marker dated in October counts for October only, so it cannot clear an
  August shortfall. Dating it on the missed date also clears that date from the missed list.
- **When Radius refuses to backdate** (the enrollment plan rolled over at the month
  boundary), the tracker has no way to tell that a current-month entry was meant for an
  earlier month, so that month still shows as short.
- **Genuine 2-hour students keep their honest 2-hour entries.** The rule is only about
  makeup hours hiding inside longer entries.
- **Makeups are only owed for the two completed months being judged.** Once a month drops
  out of the window, it is no longer owed.

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

(On one computer, without signing in. Signed in, the exports come from the shared copy
instead and nothing is kept in the browser: see "The shared copy" below.)

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

The queue is grouped by kind of question, with a count for each kind, so the answers
can be batched:
- students who stopped partway through last month;
- plan readings that could not be worked out;
- guessed schedules.

Empty months are no longer asked about (see the rules). A hold can be answered with its
exact dates: "On hold — pick the months" takes the start and end straight off the Radius
hold screen.
Holds are entered as whole months by default — two dropdowns, which is how Radius
holds almost always run — with an "exact dates" toggle for the rare hold that starts
or ends mid-month. A mid-month hold is kept exact and the partly held month's
requirement is prorated by the scheduled sessions the hold covers. Every student's
detail panel also has an "Add a hold" button, so a hold can be entered even when the
queue never asked about that student.

**Nothing answered is permanent.** Each entered hold has a remove button, and every
student's detail panel has "Clear and ask again", which drops that student's saved
answers entirely and puts their questions back in the queue. Use it after a misclick,
or when a student's schedule changes and an old hand-set schedule no longer fits.

## Attendance worth checking

A separate panel lists only entries that cannot be right as logged, for a person to fix in
Radius:
- identical duplicate entries on the same date and time;
- entries dated in the future.

Visits outside session hours are makeups, not oddities. A month with extra hours is not a
problem. And 2-hour entries for 1-hour students count either way. None of these are listed
any more.

Each finding is answerable:
- Confirming it marks it checked.
- Marking a duplicate ignores its hours. That correction is stored with the other saved
  answers and flows through the requirement, the missed dates and the hours owed.

The other questions the tool asks rather than guessing, each with the likely answer marked:

- **Stopped partway through a month.** Away and still owing, or on hold from then?
- **What the plan number means**, when neither the months nor the weekly pattern can tell.
- **A guessed schedule.** Confirm the inferred days, take the days seen this month, or
  pick them by hand. This is the highest-leverage answer, since the schedule drives both
  missed dates and the current-month projection.

Answers save automatically and an answered question does not come back. Signed in to the
shared copy, they save to the site for everyone; otherwise they stay in this browser.
**Save answers to a file** writes a small JSON file, which also works as a backup of the
shared answers. **Load answers** merges one back in rather than replacing, so loading a
colleague's copy cannot silently drop answers given here.

## The shared copy

On the Netlify site the calculator can be **shared**: everyone signs in, and everyone
works from one set of exports and one set of answers. A hold entered at one desk shows up
on every other screen, and nobody has to pass answer files around or drop the exports on
each computer.

**Signing in is a username and a password. There is no email anywhere.**

- The first account is made with a setup code (below). It is an admin.
- Admins add everyone else from **Accounts** in the top bar. A new person gets a temporary
  password, which the page suggests. They choose their own password the first time they
  sign in.
- A forgotten password is reset by an admin, in the same place.
- Admins can also make someone else an admin, or remove an account. Removing an account
  or resetting its password signs that person out everywhere at once.
- Anyone can change their own password from the top bar.
- A sign-in lasts 12 hours, about a working day. **Sign out** clears every student's data
  from that browser tab.
- More than ten sign-in tries for one username in 15 minutes lock that username for 15
  minutes. Every try counts before the password is checked, so guesses sent all at once
  cannot get past the limit. Thirty wrong passwords from one connection lock that
  connection.
  - The trade-off: anyone who knows a username can lock it for 15 minutes by guessing
    wrong. An admin can reset a locked-out person's password, which also clears the lock.

**What is shared, and what is not.**

- **Exports:** dropping an export uploads a cut-down copy that everyone then uses. Only
  the columns the calculator reads are kept: names, attendance dates and start times,
  durations, plans, and enrollment status and dates. Addresses, birth dates, contacts and
  medical notes in the full Radius export stay on the computer they were dropped on. The
  server also refuses any upload that still carries another column, so this cannot slip
  by accident.
  - The cut-down copy gives exactly the same numbers as the full file. This was checked
    student by student.
- **Answers:** every answer saves to the site straight away. The status line under the
  drop zones says when the answers were last saved and by whom.
  - Only the fields the calculator writes are kept, with the right types. The site
    cleans each record before storing it, and the page cleans whatever it receives, so a
    bad or hostile record cannot break the report or put anything on someone's screen.
- **Seeing colleagues' changes:**
  - When someone else answers, the page says so, with an **Update the numbers** button.
  - When someone shares newer exports, the page offers **Load them**.
  - Nothing redraws under you while you are typing.
- **Two people answering about the same student:** each save carries the copy it was
  made from. If a colleague saved that student in between, the two are combined, not
  overwritten:
  - Holds, months and answered questions: what each person added is kept, and what each
    removed is removed.
  - Hour corrections add up.
  - Only a single value both people changed (a schedule, a plan reading, a note) goes to
    the later save, as it would at one computer.
- **Clearing answers:** "Clear answers" (everyone's) and "Remove the shared exports" are
  for admins only, and both ask first. The site refuses a save from a non-admin that
  clears more than five students at once.
- **Backups of the answers:** the site keeps a copy from the first save of each day, and
  another just before any save that clears many students, for 30 days.
  - Admins see them under **Accounts**. To put one back, download it and use **Load
    answers**; it is merged into the answers as they are now.

**A computer that had its own saved copy before sharing.** The first time someone signs
in on it, the page offers to add that copy to the shared one:

- Answers are merged in without replacing anything colleagues have already answered.
- The exports are shared too, if nobody has shared any yet.
- Then the computer's own copy is erased. Or erase it without adding it.

**Without signing in.** "Use the calculator on this computer only" on the sign-in screen
gives the old behavior: the exports and answers stay in that browser and nothing is
uploaded. The same happens whenever the page is opened from disk, a network share or an
email attachment. There is no sign-in there at all, because there is no server to talk to.

## Setting it up on Netlify (one time)

Test on a `development` branch first. Branch deploys cost no Netlify credits; only a
deploy to the live site does (see "Netlify credits" below).

1. **Setup code.** In Netlify, open **Site configuration → Environment variables** and add
   `SETUP_CODE`: any phrase of 8 or more characters, for all deploy contexts.
2. **Branch deploys.** Open **Project configuration → Developer settings → Continuous
   deployment → Branches and deploy contexts → Configure**. Choose **Let me add
   individual branches**, add `development`, and save.
3. **The branch.** On GitHub, open the branch menu (it says `main`), type `development`,
   and choose **Create branch: development from main**.
4. **Upload.** With `development` selected, choose **Add file → Upload files**, drag in
   everything, and commit to `development`.
   - Netlify builds it at `development--<your site name>.netlify.app`. It installs the
     one dependency, runs the server tests, and publishes only `index.html`.
   - If a test fails, nothing goes live. The deploy log should say "pass 39".
5. **Try it.** Open that address, enter the setup code, and make an admin account. Add a
   test person, drop the exports, and answer a few questions from two browsers.
   - This test site has its own accounts and data, separate from the live site's.
   - When you are done, **Remove the shared exports** there.
6. **Go live.** On GitHub, open a pull request from `development` into `main` and merge
   it. That is one production deploy (15 credits).
7. **Set up the live site.** Open it and set it up again with the setup code: the live
   site starts with no accounts. Then add everyone from **Accounts**.

`SETUP_CODE` can stay. Setup refuses to run once any account exists.

Optionally, add `SESSION_SECRET` (32 or more random characters) to sign the sign-in
cookies. Without it, the site makes its own secret and keeps it in Netlify Blobs.

Everything lives in **Netlify Blobs** on the site, in two stores:

- `makeup-auth` holds the accounts, the password hashes (PBKDF2-SHA256, never the
  passwords) and the wrong-password counters.
- `makeup-data` holds the answers and the two cut-down exports.

Deploy previews, branch deploys and `netlify dev` each use their own stores
(`preview-makeup-auth`, `preview-makeup-data`). A preview starts empty, with its own setup
and its own accounts, and cannot read or change the live site's data.

The repo is public. In Netlify, under **Site configuration → Build & deploy → Deploy
Previews**, keep pull requests from forks from deploying without your approval.

## Netlify credits

On Netlify's credit plans, each successful **production** deploy (a new commit on `main`)
costs 15 credits. The free plan has 300 a month, and when they run out every site on the
account is paused until the next month.

These cost nothing to deploy:

- **Branch deploys** (`development`).
- **Deploy previews** of pull requests.
- **Failed deploys.**

Page views and the server's work cost a little on any deploy. The shared copy checking for
colleagues' answers every two minutes comes to a few credits a month.

How to keep production deploys rare:

- **One commit per change.** Uploading several files in one GitHub upload is one commit,
  so one deploy. Uploading them one at a time is one deploy each.
- **Test on `development`.** Merge into `main` only when it works.
- **Notes-only commits build nothing.** `netlify.toml` tells Netlify to skip a build when a
  commit changes only files that are never served: this README, the notes, the tests, or
  the Python reference.
  - Anything that touches `index.html`, `netlify/`, `netlify.toml` or the package files
    still builds.
  - To skip one by hand, put `[skip ci]` in the commit message.

## Hosting it

The page is `index.html` with everything inline. The shared copy is one Netlify Function:

- `netlify/functions/api.mjs` answers `/api/*`.
- Its logic is in `netlify/lib/core.mjs`.

`netlify.toml` builds, publishes `dist/` (just the page) and sets the security headers.
The page still works opened from disk, with no server at all.

**The page can talk to its own site and nothing else, and that is enforced rather than
promised.**

- The Content Security Policy sets `connect-src 'self'`. Fetch, XHR, WebSocket and beacon
  can reach only the site's own `/api`, so a roster can never be posted to a third party.
  No CDN, analytics or font can load either.
- Opened from disk, `'self'` reaches nothing, so no network is used at all.
- The policy sits in both `netlify.toml` and a `<meta>` tag inside the page, because a
  server can add headers and a file on a USB stick cannot. The guarantee has to survive
  being emailed.

**Checks:**

- `npm test`: 39 server tests (sign-in, lockout, accounts, conflicts and merging, record
  cleaning, backups, the column filter). They run on every Netlify build.
- `node tests/shared_browser.mjs`: two real browsers against a stand-in of the site, from
  setup through answering and sign-out, including a hostile record (45 checks).
- With `SITE_URL=http://localhost:8888`, the same browser test runs against `netlify dev`
  instead. It passed against the real function too.
- The Python browser tests still pass for the page used on one computer.

## Not in scope

Real exports are never committed. They carry personal data for roughly 400 minors, so
`testdata/` is git-ignored. The full exports are read only in the browser. The shared copy
keeps just the columns the calculation needs, on this site's own Netlify storage, behind
sign-in.
