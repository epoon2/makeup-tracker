/*
  Made-up Radius exports for checking the two engines against each other when the real
  exports are not at hand:

    node tests/synthetic_exports.mjs            writes testdata/attendance.xlsx and
                                                testdata/students.xlsx (git-ignored)
    PARITY_TODAY=2026-10-20 python3 tests/parity_browser.py

  Every name is invented. The students are built to cover the rules: plans of 4, 8 and 12,
  1- and 2-hour sessions, a plan that changes in Radius, a month with no attendance,
  makeups at 12 AM, on weekday mornings and on Sundays, a student coming above their plan
  month after month, students who start late, stop early or never come, and roster names
  shared by an old record or by two Enrolled records. The .xlsx files are written by the
  page's own writer.
*/

import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(import.meta.url)("playwright");

const LAST = Date.UTC(2026, 9, 17);          // data through Sat 17 Oct 2026
const FIRST = Date.UTC(2026, 6, 1);
const DAY = 86400000;
const text = (ms) => { const d = new Date(ms); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "/" + d.getUTCFullYear(); };
const weekday = (ms) => (new Date(ms).getUTCDay() + 6) % 7;   // Monday = 0
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const att = [["Attendance Date", "First Name", "Last Name", "Duration (Minutes)", "Duration (Hours)",
              "Sessions Per Month", "Lead Id", "Center", "Arrival Time"]];
const stu = [["Student Id", "First Name", "Last Name", "Enrollment Status", "Enrollment Start Date",
              "Enrollment End Date", "Last Attendance Date", "Center", "Lead Id", "Address"]];

function student(i, opts) {
  const first = opts.first || "Kid" + i, last = opts.last || "Test" + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? i : "");
  let lastSeen = "";
  for (let ms = opts.from || FIRST; ms <= (opts.to || LAST); ms += DAY) {
    const d = new Date(ms), m = d.getUTCMonth() + 1;
    if (!opts.days.includes(weekday(ms))) continue;
    if (opts.skipMonth && opts.skipMonth.includes(m)) continue;
    if (rnd() < (opts.miss ?? 0.1)) continue;
    const mins = opts.mins || 60;
    const plan = typeof opts.plan === "function" ? opts.plan(m) : opts.plan;
    const time = weekday(ms) === 5 ? "10:00 AM" : weekday(ms) === 2 ? "2:00 PM" : "3:30 PM";
    att.push([text(ms), first, last, mins, mins / 60, plan, "L" + i, "Temple City", time]);
    lastSeen = text(ms);
  }
  for (const extra of opts.makeups || []) {
    att.push([extra.date, first, last, 60, 1, typeof opts.plan === "function" ? opts.plan(+extra.date.split("/")[0]) : opts.plan,
              "L" + i, "Temple City", extra.time]);
  }
  stu.push(["S" + i, first, last, opts.status || "Enrolled", opts.start || "6/1/2026", opts.end || "", lastSeen,
            "Temple City", "L" + i, i + " Made Up St"]);
}

let i = 0;
// Plain students across the plans and session lengths.
for (let k = 0; k < 30; k++) {
  student(i++, { days: [[0, 2], [1, 3], [0, 3], [2], [5], [1, 4], [0, 2, 4]][k % 7],
                 plan: [8, 8, 8, 4, 4, 8, 12][k % 7], mins: k % 9 === 0 ? 120 : 60, miss: 0.08 + (k % 4) * 0.04 });
}
// 2-hour students: plan 4 delivered as 4 x 2 hrs, and plan 8 delivered as 8 hrs.
for (let k = 0; k < 6; k++) student(i++, { days: [k % 2 ? 1 : 3], plan: k < 3 ? 4 : 8, mins: 120, miss: 0.05 });
// Started in September: one completed month, so the weekly pattern decides.
for (let k = 0; k < 4; k++) student(i++, { days: [2], plan: k % 2 ? 4 : 8, mins: 120, from: Date.UTC(2026, 8, 5), start: "9/1/2026", miss: 0 });
// Plan changed in Radius from 8 to 12 in September.
for (let k = 0; k < 3; k++) student(i++, { days: [0, 2, 4], plan: (m) => (m >= 9 ? 12 : 8), miss: 0.05 });
// Coming 12+ hrs a month on an 8 plan, every month.
for (let k = 0; k < 3; k++) student(i++, { days: [0, 1, 2], plan: 8, miss: 0 });
// A month with no attendance (August, or September).
for (let k = 0; k < 4; k++) student(i++, { days: [1, 3], plan: 8, skipMonth: [k % 2 ? 8 : 9] });
// Makeups: 12 AM, a weekday morning, a Sunday, a late evening.
for (let k = 0; k < 4; k++) {
  student(i++, { days: [1, 3], plan: 8, makeups: [
    { date: "8/12/2026", time: "12:00 AM" }, { date: "9/9/2026", time: "11:00 AM" },
    { date: "9/13/2026", time: "3:00 PM" }, { date: "10/6/2026", time: "7:45 PM" }] });
}
// Stopped partway through September; started late; left.
student(i++, { days: [0, 2], plan: 8, to: Date.UTC(2026, 8, 12) });
student(i++, { days: [1, 3], plan: 8, from: Date.UTC(2026, 7, 17), start: "8/15/2026" });
student(i++, { days: [0, 2], plan: 8, to: Date.UTC(2026, 6, 31), status: "Inactive", end: "7/31/2026" });
// Enrolled, never attended; on hold.
stu.push(["S" + i, "Kid" + i, "Never", "Enrolled", "8/1/2026", "", "", "Temple City", "L" + i, "1 Made Up St"]); i++;
student(i++, { days: [1, 3], plan: 8, to: Date.UTC(2026, 7, 31), status: "On Hold" });
// Shared names: an old record under the same name, and two students told apart by " *".
student(i++, { first: "Same", last: "Name", days: [1, 3], plan: 8 });
stu.push(["S" + i, "Same", "Name", "Inactive", "1/1/2025", "5/31/2026", "", "Temple City", "L" + i, "2 Made Up St"]); i++;
student(i++, { first: "Twin", last: "Pair", days: [0, 2], plan: 8 });
student(i++, { first: "Twin", last: "Pair *", days: [1, 3], plan: 4 });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(join(ROOT, "index.html")).href);
const files = await page.evaluate(async ([att, stu]) => {
  const b64 = async (blob) => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
  return [await b64(await workbook([{ name: "Sheet1", rows: att }])), await b64(await workbook([{ name: "Sheet1", rows: stu }]))];
}, [att, stu]);
await browser.close();
mkdirSync(join(ROOT, "testdata"), { recursive: true });
writeFileSync(join(ROOT, "testdata", "attendance.xlsx"), Buffer.from(files[0], "base64"));
writeFileSync(join(ROOT, "testdata", "students.xlsx"), Buffer.from(files[1], "base64"));
console.log("wrote testdata/attendance.xlsx (" + (att.length - 1) + " rows) and testdata/students.xlsx (" + (stu.length - 1) + " rows), all made up");
