/*
  Shared mode, end to end, in real browsers:

    npm install
    node tests/shared_browser.mjs

  Starts the stand-in site (tests/shared_server.mjs), then drives two separate browsers,
  one admin and one staff member, through setup, adding an account, a first sign-in with
  a temporary password, sharing exports, answering, and seeing each other's answers. A
  third browser checks that a computer's pre-sharing answers can join the shared copy,
  and that "Use on this computer only" and the page opened from disk still work with
  nothing shared. The exports are made up on the spot: no real student data.

  Prints one line per check and exits non-zero if any fails.

  SITE_URL=http://localhost:8888 node tests/shared_browser.mjs runs the same checks
  against another copy of the site instead, such as `netlify dev` (start it with
  SETUP_CODE=local-setup-code and no accounts yet).
*/

import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { startSite, SETUP_CODE } from "./shared_server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Playwright through require(), so a global install (NODE_PATH) is found as well as a local one.
const { chromium } = createRequire(import.meta.url)("playwright");
let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail !== undefined ? "  -> " + JSON.stringify(detail) : ""));
  if (!ok) failed++;
};

/* --- made-up exports ------------------------------------------------------------- */

const pad = (n) => String(n).padStart(2, "0");
function exportsRows() {
  const attendance = [["Attendance Date", "First Name", "Last Name", "Duration (Minutes)", "Sessions Per Month", "Lead Id", "Center", "Notes"]];
  const roster = [["Student Id", "First Name", "Last Name", "Enrollment Status", "Enrollment Start Date", "Enrollment End Date",
                   "Last Attendance Date", "Center", "Address", "Date of Birth", "Medical Notes"]];
  const today = new Date();
  const until = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - 2));
  for (let i = 0; i < 24; i++) {
    const first = "Test", last = "Student" + String.fromCharCode(65 + i);
    const days = i % 2 ? [1, 3] : [2, 4]; // Tue/Thu or Wed/Fri, getUTCDay numbering
    let lastSeen = null;
    for (let d = new Date(Date.UTC(2026, 6, 1)); d <= until; d = new Date(d.getTime() + 86400000)) {
      if (!days.includes(d.getUTCDay())) continue;
      const m = d.getUTCMonth() + 1;
      if (i < 3 && m === 9) continue;                    // a whole month away: a hold question
      if (i >= 3 && i < 9 && d.getUTCDate() % 7 === 0) continue; // the odd missed session
      if (i === 23) continue;                            // enrolled, never attended
      attendance.push([m + "/" + d.getUTCDate() + "/" + d.getUTCFullYear() + " 3:30 PM", first, last, 60, 8, "L" + i, "Temple City", "made up"]);
      lastSeen = m + "/" + d.getUTCDate() + "/" + d.getUTCFullYear();
    }
    roster.push(["S" + pad(i), first, last, "Enrolled", "6/1/2026", "", lastSeen || "", "Temple City",
                 i + " Example St", "1/1/2015", "none (made up)"]);
  }
  return { attendance, roster };
}

async function xlsxFiles(page) {
  const rows = exportsRows();
  return page.evaluate(async (rows) => {
    const toB64 = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    };
    return {
      attendance: await toB64(await workbook([{ name: "Sheet1", rows: rows.attendance }])),
      roster: await toB64(await workbook([{ name: "Sheet1", rows: rows.roster }])),
    };
  }, rows);
}

async function drop(page, zone, b64, name) {
  await page.evaluate(([zone, b64, name]) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], name));
    document.getElementById(zone).dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
  }, [zone, b64, name]);
}

const text = (page, sel) => page.locator(sel).innerText();
const queueCount = async (page) => {
  const t = await text(page, "#queueTitle").catch(() => "");
  const m = t.match(/(\d+)/);
  return m ? +m[1] : 0;
};

async function watch(page, label, problems) {
  page.on("pageerror", (e) => problems.push(label + " page error: " + e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/.test(m.text())) problems.push(label + " CSP: " + m.text()); });
  page.on("dialog", (d) => d.accept());
}

/* --- the run ---------------------------------------------------------------------- */

const site = process.env.SITE_URL ? { url: process.env.SITE_URL, close: async () => {} } : await startSite();

// What the site holds, read the way the page reads it: through /api, as a signed-in user.
const fromSite = {
  answers: (page) => page.evaluate(async () => (await fetch("/api/answers")).json()),
  export: async (page, which) => {
    const b64 = await page.evaluate(async (which) => {
      const bytes = new Uint8Array(await (await fetch("/api/exports/" + which)).arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    }, which);
    return JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString());
  },
};
const browser = await chromium.launch();
const problems = [];
try {
  // --- setup, as the admin ---------------------------------------------------------
  const adminCtx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  const admin = await adminCtx.newPage();
  await watch(admin, "admin", problems);
  await admin.goto(site.url + "/");
  await admin.waitForSelector("#authPanel:not([hidden])");
  check("a new site asks for setup", (await text(admin, "#authTitle")) === "Set up the shared calculator");
  check("the drop zones stay hidden until signed in", await admin.locator("#intakePanel").isHidden());

  await admin.fill("#fCode", "not-the-code");
  await admin.fill("#fUser", "Ethan");
  await admin.fill("#fNext", "first-password");
  await admin.fill("#fConfirm", "first-password");
  await admin.click("#authGo");
  await admin.waitForFunction(() => document.getElementById("authErr").textContent.length > 0);
  check("a wrong setup code is refused", /setup code/i.test(await text(admin, "#authErr")), await text(admin, "#authErr"));

  await admin.fill("#fCode", SETUP_CODE);
  await admin.fill("#fNext", "first-password");
  await admin.fill("#fConfirm", "first-password");
  await admin.click("#authGo");
  await admin.waitForSelector("#whoBar:not([hidden])");
  check("setup signs the admin in", (await text(admin, "#whoName")) === "ethan");
  check("the admin sees Accounts", await admin.locator("#openAccounts").isVisible());
  await admin.waitForFunction(() => document.getElementById("storageNote").textContent.length > 0);
  check("the page says nothing is shared yet", /Nobody has shared/.test(await text(admin, "#storageNote")), await text(admin, "#storageNote"));

  // --- share the exports --------------------------------------------------------------
  const files = await xlsxFiles(admin);
  await drop(admin, "dropAtt", files.roster, "Students Export.xlsx");
  await admin.waitForSelector("#messages .err");
  check("the roster dropped on the attendance zone is refused", /does not look like the Student Attendance Report/.test(await text(admin, "#messages")));

  await drop(admin, "dropAtt", files.attendance, "Student Attendance Report Export.xlsx");
  await admin.waitForFunction(() => /shared by ethan/.test(document.getElementById("nameAtt").textContent));
  await drop(admin, "dropStu", files.roster, "Students Export.xlsx");
  await admin.waitForFunction(() => /shared by ethan/.test(document.getElementById("nameStu").textContent));
  check("both exports are shared", true);

  const storedRoster = await fromSite.export(admin, "roster");
  const storedAtt = await fromSite.export(admin, "attendance");
  check("only the used roster columns reached the site", !storedRoster.headers.some((h) => /Address|Birth|Medical|Center/.test(h)), storedRoster.headers);
  check("only the used attendance columns reached the site", !storedAtt.headers.some((h) => /Lead|Center|Notes/.test(h)), storedAtt.headers);
  check("no address text anywhere in the stored roster", !JSON.stringify(storedRoster).includes("Example St"));

  await admin.click("#run");
  await admin.waitForSelector("#results:not([hidden])");
  const adminCards = await admin.locator(".card .n").allInnerTexts();
  const startQueue = await queueCount(admin);
  check("the report runs from the shared exports", adminCards.length > 0 && startQueue > 0, { adminCards, startQueue });

  await admin.click("#selfcheck");
  const selfcheck = await text(admin, "#selfcheckOut");
  check("the in-page self-check passes", /checks passed/.test(selfcheck), selfcheck);

  // --- add a staff member ---------------------------------------------------------------
  await admin.click("#openAccounts");
  await admin.waitForSelector("#accountsTable tr:nth-child(2)");
  const temp = await admin.inputValue("#newPass");
  check("a temporary password is suggested", /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(temp), temp);
  await admin.fill("#newUser", "Maria");
  await admin.click("#addUserForm button[type=submit]");
  await admin.waitForSelector("#accountsMsg .notice");
  check("the admin is told the temporary password to pass on", (await text(admin, "#accountsMsg")).includes(temp));
  check("the new account shows a temporary password", /maria[\s\S]*temporary/.test(await text(admin, "#accountsTable")));
  await admin.click("#closeAccounts");

  // --- the staff member's first sign-in, on another computer ---------------------------
  const mariaCtx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  const maria = await mariaCtx.newPage();
  await watch(maria, "maria", problems);
  await maria.goto(site.url + "/");
  await maria.waitForSelector("#authPanel:not([hidden])");
  check("an existing site asks to sign in", (await text(maria, "#authTitle")) === "Sign in");
  await maria.fill("#fUser", "maria");
  await maria.fill("#fCurrent", "wrong-password");
  await maria.click("#authGo");
  await maria.waitForFunction(() => /Wrong username or password/.test(document.getElementById("authErr").textContent));
  check("a wrong password is refused", true);
  await maria.fill("#fCurrent", temp);
  await maria.click("#authGo");
  await maria.waitForFunction(() => document.getElementById("authTitle").textContent === "Choose your own password");
  check("the temporary password is not asked for twice", await maria.locator('label[data-f="current"]').isHidden());
  await maria.fill("#fNext", "marias-password");
  await maria.fill("#fConfirm", "marias-password");
  await maria.click("#authGo");
  await maria.waitForSelector("#results:not([hidden])");
  check("staff see the shared numbers without dropping anything",
        JSON.stringify(await maria.locator(".card .n").allInnerTexts()) === JSON.stringify(adminCards));
  check("staff do not see Accounts", await maria.locator("#openAccounts").isHidden());
  check("staff cannot clear everyone's answers", await maria.locator("#clearAnswers").isHidden());

  // --- answering, and seeing each other's answers ---------------------------------------
  await admin.locator("#queueList button[data-o=\"skip\"]").first().click();
  await admin.waitForFunction(() => /Last saved by ethan/.test(document.getElementById("syncNote").textContent));
  const afterAdmin = await queueCount(admin);
  check("the admin's answer is saved to the site", afterAdmin === startQueue - 1, { startQueue, afterAdmin });

  await maria.evaluate(() => pollShared(false));
  await maria.waitForFunction(() => /ethan changed answers for 1 student/.test(document.getElementById("syncNote").textContent));
  check("staff are told about a colleague's answer", true);
  await maria.click("#syncShow");
  await maria.waitForFunction((n) => /(\d+)/.test(document.getElementById("queueTitle").textContent) &&
    +document.getElementById("queueTitle").textContent.match(/(\d+)/)[1] === n, afterAdmin);
  check("and see it after updating", (await queueCount(maria)) === afterAdmin);

  await maria.locator("#queueList button[data-o=\"skip\"]").first().click();
  await maria.waitForFunction(() => /Last saved by maria/.test(document.getElementById("syncNote").textContent));
  await admin.evaluate(() => pollShared(false));
  await admin.waitForFunction(() => /maria changed answers/.test(document.getElementById("syncNote").textContent));
  await admin.click("#syncShow");
  check("both answers are in both browsers", (await queueCount(admin)) === startQueue - 2 && (await queueCount(maria)) === startQueue - 2,
        { admin: await queueCount(admin), maria: await queueCount(maria) });
  const stored = await fromSite.answers(admin);
  check("the site holds both answers, each with who gave it",
        Object.values(stored.meta).map((m) => m.by).sort().join(",") === "ethan,maria", Object.values(stored.meta));

  // --- a hostile answer record cannot run script in a colleague's page --------------------
  const target = await admin.evaluate(() => window.__mt.report.students[0].key);
  const hostile = await maria.evaluate(async (key) => {
    const res = await fetch("/api/answers", { method: "PATCH", headers: { "content-type": "application/json", "x-makeup-tracker": "1" },
      body: JSON.stringify({ set: { [key]: { planHours: { "2026-08": "<img src=x onerror=window.__pwned=1>" }, sessionHours: "<img src=x onerror=window.__pwned=1>", weekdays: [1, 3], note: "<img src=x onerror=window.__pwned=1>" } } }) });
    return res.status;
  }, target);
  await admin.evaluate(() => pollShared(false));
  await admin.waitForSelector("#syncShow");
  await admin.click("#syncShow");
  // Draw that student's details, the panel that shows plans and session lengths.
  const drawDetail = (key) => admin.evaluate((key) => {
    const st = window.__mt.report.students.find((x) => x.key === key);
    document.body.insertAdjacentHTML("beforeend", '<dl id="probe">' + detailFor(st) + "</dl>");
  }, key);
  await drawDetail(target);
  // And the same with a raw record put straight into memory, past every cleaning step:
  // only the escaping on the page stands between it and the screen.
  await admin.evaluate((key) => {
    window.__mt.overrides.students[key] = { holds: [], holdDates: [], planHours: { "2026-08": "<img src=x onerror=window.__pwned=2>" },
      hourAdjust: {}, notEnrolled: [], charged: [], weekdays: [1, 3], sessionHours: "<img src=x onerror=window.__pwned=3>",
      planReading: null, note: "<img src=x onerror=window.__pwned=4>", answered: [], auditChecked: [] };
    rerun();
  }, target);
  await drawDetail(target);
  await admin.waitForTimeout(500);
  check("a hostile answer record is cleaned and runs nothing", hostile === 200 &&
        (await admin.evaluate(() => window.__pwned)) === undefined, await admin.evaluate(() => window.__pwned));
  // Put the record back the way the site has it, so the rest of the run is unaffected.
  await admin.evaluate((key) => {
    window.__mt.overrides.students[key] = JSON.parse(window.__mt.shared.synced[key]);
    document.querySelectorAll("#probe").forEach((n) => n.remove());
    rerun();
  }, target);
  await admin.evaluate(() => pollShared(false));

  // --- the Accounts panel offers the answer backups ------------------------------------------
  await admin.click("#openAccounts");
  await admin.waitForFunction(() => document.getElementById("backupsBox").textContent.length > 0);
  check("admins see the answer backups", /Answer backups/.test(await text(admin, "#backupsBox")), await text(admin, "#backupsBox"));
  await admin.click("#closeAccounts");

  // --- an answer made while signed out is kept and saved on signing back in --------------
  await mariaCtx.clearCookies();
  await maria.locator("#queueList button[data-o=\"skip\"]").first().click();
  await maria.waitForSelector("#authPanel:not([hidden])");
  check("an expired sign-in asks to sign in again", /signed out/.test(await text(maria, "#authIntro")));
  await maria.fill("#fUser", "maria");
  await maria.fill("#fCurrent", "marias-password");
  await maria.click("#authGo");
  await maria.waitForFunction(() => /Last saved by maria/.test(document.getElementById("syncNote").textContent) &&
                                     !document.getElementById("results").hidden);
  const storedAfter = await fromSite.answers(admin);
  check("and the answer given meanwhile reaches the site", Object.keys(storedAfter.answers.students).length === Object.keys(stored.answers.students).length + 1,
        { before: Object.keys(stored.answers.students).length, after: Object.keys(storedAfter.answers.students).length });

  // --- signing out ---------------------------------------------------------------------
  await maria.click("#signOut");
  await maria.waitForSelector("#authPanel:not([hidden])");
  check("signing out returns to the sign-in screen with nothing on it", await maria.locator("#results").isHidden() &&
        (await maria.evaluate(() => window.__mt.state.attendance)) === null);

  // --- a computer with answers from before sharing ---------------------------------------
  const oldCtx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  const old = await oldCtx.newPage();
  await watch(old, "old", problems);
  await old.goto(site.url + "/");
  await old.waitForSelector("#authPanel:not([hidden])");
  await old.click("#useLocal");
  await old.waitForSelector("#intakePanel:not([hidden])");
  check("'this computer only' says nothing is uploaded", /nothing is uploaded/.test(await text(old, "#headerSub")));
  check("and offers to sign in instead", await old.locator("#signInBar").isVisible());
  await drop(old, "dropAtt", files.attendance, "attendance.xlsx");
  await drop(old, "dropStu", files.roster, "students.xlsx");
  await old.waitForFunction(() => !document.getElementById("run").disabled);
  await old.click("#run");
  await old.waitForSelector("#results:not([hidden])");
  check("the same files give the same numbers on this computer as from the shared copy",
        JSON.stringify(await old.locator(".card .n").allInnerTexts()) === JSON.stringify(adminCards));
  // Answer the last question in the list, which nobody has answered on the shared copy.
  await old.locator("#queueList button[data-o=\"skip\"]").last().click();
  await old.waitForTimeout(300);
  const localSaved = await old.evaluate(() => Object.keys(window.__mt.overrides.students).length);
  const answersBefore = Object.keys((await fromSite.answers(admin)).answers.students).length;
  await old.waitForTimeout(500);
  check("local mode saved its answer locally, not to the site", localSaved === 1 &&
        Object.keys((await fromSite.answers(admin)).answers.students).length === answersBefore);

  await old.click("#signIn");
  await old.waitForSelector("#authPanel:not([hidden])");
  await old.fill("#fUser", "ethan");
  await old.fill("#fCurrent", "first-password");
  await old.click("#authGo");
  await old.waitForSelector("#sharedOffer:not([hidden])");
  check("signing in offers to add this computer's own copy", /answers for 1 student/.test(await text(old, "#sharedOffer")));
  await old.click("#offerAdd");
  await old.waitForSelector("#sharedOffer", { state: "hidden" });
  const answersAfter = Object.keys((await fromSite.answers(admin)).answers.students).length;
  check("the local answer joins the shared copy", answersAfter === answersBefore + 1, { answersBefore, answersAfter });
  const leftLocally = await old.evaluate(async () => (await dbGet("overrides")) || null);
  check("and this computer's own copy is erased", leftLocally === null);

  // --- the file opened from disk: no sign-in, nothing shared ---------------------------------
  const diskCtx = await browser.newContext();
  const disk = await diskCtx.newPage();
  await watch(disk, "disk", problems);
  await disk.goto(pathToFileURL(join(ROOT, "index.html")).href);
  await disk.waitForTimeout(500);
  check("from disk: no sign-in screen", await disk.locator("#authPanel").isHidden());
  check("from disk: the drop zones are there", await disk.locator("#intakePanel").isVisible());
  check("from disk: nothing offers to sign in", await disk.locator("#signInBar").isHidden() && await disk.locator("#whoBar").isHidden());
  const blocked = await disk.evaluate(async () => {
    try { await fetch("https://example.com/x"); return "NOT BLOCKED"; } catch (e) { return "blocked"; }
  });
  check("from disk: outside connections are blocked", blocked === "blocked");
  const blockedOnSite = await admin.evaluate(async () => {
    try { await fetch("https://example.com/x"); return "NOT BLOCKED"; } catch (e) { return "blocked"; }
  });
  check("on the site: connections anywhere but the site are blocked", blockedOnSite === "blocked");

  const realProblems = problems.filter((p) => !/example\.com/.test(p));
  check("no page errors or CSP complaints in normal use", realProblems.length === 0, realProblems);
} catch (err) {
  failed++;
  console.log("  FAIL crashed: " + (err && err.stack));
} finally {
  await browser.close();
  await site.close();
}
console.log(failed ? failed + " check(s) failed" : "all checks passed");
process.exit(failed ? 1 : 0);
