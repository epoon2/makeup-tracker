/*
  The shared side of the makeup tracker: sign-in, accounts, and the one copy of the
  exports and answers that everyone signed in works from.

  It runs as a single Netlify Function at /api/* (netlify/functions/api.mjs) and keeps
  everything in Netlify Blobs. It is written against two plain "stores" rather than
  against Netlify directly so tests/api.test.mjs can drive it against the Blobs test
  server with no Netlify account.

  Accounts are a username and a password. There is no email anywhere: nothing is ever
  sent to anyone, and a forgotten password is reset by an admin from the Accounts panel.
  The first account is made with the SETUP_CODE environment variable and is an admin;
  everyone after that is added by an admin with a temporary password they replace the
  first time they sign in.

  What is stored, in two Blob stores:

    makeup-auth   accounts           usernames, password hashes (PBKDF2-SHA256), roles
                  session-secret     signs the sign-in cookie (unless SESSION_SECRET is set)
                  fail/<kind>/<id>   wrong-password counters, keyed by a hash, never the IP

    makeup-data   answers            the review-queue answers, one record per student
                  backup/answers/*   a copy of the answers each day, and before any mass clear
                  export/attendance  the Student Attendance Report, gzip of the used columns
                  export/roster      the Students Export, gzip of the used columns

  Only the columns the calculator reads are accepted for the exports. The page strips the
  rest before uploading, and this file refuses an upload that still carries any other
  column, so addresses, birth dates and medical notes in the full Radius export can
  never be stored here even if the page had a bug.

  Answer records are cleaned to the shape the page writes (cleanRecord, the same as in
  index.html) before they are stored, so nothing but those fields, with those types, can
  reach another person's page.
*/

import { pbkdf2 as pbkdf2Callback, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const pbkdf2 = promisify(pbkdf2Callback);

export const COOKIE = "mt_session";
export const SESSION_HOURS = 12;
// OWASP's current figure for PBKDF2-SHA256. Each record keeps its own count, so this can
// be raised later without breaking existing passwords.
export const PASSWORD_ITERATIONS = 600000;
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export const LOCK = {
  userTries: 10,          // sign-in tries for one username...
  ipFails: 30,            // ...or wrong passwords from one connection...
  windowMs: 15 * 60000,   // ...inside this window...
  lockMs: 15 * 60000,     // ...lock sign-in for this long.
};

// More removals than this in one save is "clearing answers", which only an admin does.
export const STAFF_REMOVE_LIMIT = 5;
const BACKUP_DAYS = 30;

// The columns the page reads (see normalise(), TIME_COLUMNS and END_TIME_COLUMNS in index.html).
const TIME_COLUMNS = ["Arrival Time", "Start Time", "Session Start Time", "Session Start", "Time In", "Attendance Time", "Time"];
const END_TIME_COLUMNS = ["Departure Time", "End Time", "Session End Time", "Session End", "Time Out"];
export const EXPORT_COLUMNS = {
  attendance: {
    label: "Student Attendance Report",
    required: ["First Name", "Last Name", "Attendance Date", "Duration (Minutes)"],
    allowed: ["First Name", "Last Name", "Attendance Date", "Duration (Minutes)", "Sessions Per Month", ...TIME_COLUMNS, ...END_TIME_COLUMNS],
  },
  roster: {
    label: "Students Export",
    required: ["First Name", "Last Name", "Enrollment Status"],
    allowed: ["First Name", "Last Name", "Student Id", "Enrollment Status", "Enrollment Start Date",
              "Enrollment End Date", "Last Attendance Date"],
  },
};

const MAX_EXPORT_UPLOAD = 4.5 * 1024 * 1024;   // compressed; Netlify caps a request at 6 MB
const MAX_EXPORT_JSON = 80 * 1024 * 1024;      // after decompressing
const MAX_ROWS = 250000;
const MAX_CELL = 300;
const MAX_STUDENT_RECORD = 64 * 1024;
const MAX_ANSWERS = 5 * 1024 * 1024;
const MAX_JSON_BODY = 2 * 1024 * 1024;
const WRITE_TRIES = 8;

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (text) => createHash("sha256").update(String(text)).digest();
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function sameText(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

function json(status, body, headers) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(headers || {}) },
  });
}

function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function cleanUsername(value) {
  const name = String(value == null ? "" : value).trim().toLowerCase();
  if (!USERNAME.test(name)) {
    throw new HttpError(400, "Usernames are 2 to 32 characters: letters, numbers, dots, dashes or underscores, starting with a letter or number.");
  }
  return name;
}

function checkNewPassword(value) {
  const password = String(value == null ? "" : value);
  if (password.length < MIN_PASSWORD) throw new HttpError(400, "Passwords need at least " + MIN_PASSWORD + " characters.");
  if (password.length > MAX_PASSWORD) throw new HttpError(400, "That password is too long.");
  return password;
}

async function readBody(req, limit) {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > limit) throw new HttpError(413, "That upload is too large.");
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > limit) throw new HttpError(413, "That upload is too large.");
  return buf;
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BODY);
  let data;
  try { data = JSON.parse(buf.toString("utf8") || "{}"); }
  catch (e) { throw new HttpError(400, "The request was not valid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "The request was not a JSON object.");
  return data;
}

/* --- answer records ----------------------------------------------------------- */

// JSON with object keys sorted, so the same answers always give the same text. The same
// function is in index.html.
export function canon(v) {
  if (Array.isArray(v)) return "[" + v.map((x) => canon(x === undefined ? null : x)).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

const MONTH_KEY = /^\d{4}-\d{2}$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/*
  One student's answers in exactly the shape the page writes (ovFor() in index.html):
  every field present, every value of the right type, anything else dropped. Kept
  identical to cleanRecord() in index.html.
*/
export function cleanRecord(rec) {
  const r = rec && typeof rec === "object" && !Array.isArray(rec) ? rec : {};
  const month = (v) => typeof v === "string" && MONTH_KEY.test(v);
  const day = (v) => typeof v === "string" && DAY_KEY.test(v);
  const text = (max) => (v) => typeof v === "string" && v.length <= max;
  const list = (v, max, keep) => (Array.isArray(v) ? v.filter(keep).slice(0, max) : []);
  const unique = (items) => {
    const seen = new Set();
    return items.filter((x) => { const k = canon(x); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const hours = (v, lo, hi) => {
    const out = {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) if (MONTH_KEY.test(k) && typeof x === "number" && isFinite(x) && x >= lo && x <= hi) out[k] = x;
    }
    return out;
  };
  return {
    holds: unique(list(r.holds, 60, (h) => h && month(h.start) && (h.until == null || month(h.until)) && (h.source === undefined || text(40)(h.source)))
      .map((h) => (h.source === undefined ? { start: h.start, until: h.until || null } : { start: h.start, until: h.until || null, source: h.source }))),
    holdDates: unique(list(r.holdDates, 60, (h) => h && day(h.from) && day(h.to)).map((h) => ({ from: h.from, to: h.to }))),
    planHours: hours(r.planHours, 0, 200),
    hourAdjust: hours(r.hourAdjust, -200, 200),
    notEnrolled: unique(list(r.notEnrolled, 60, month)),
    charged: unique(list(r.charged, 60, month)),
    weekdays: Array.isArray(r.weekdays) ? unique(list(r.weekdays, 7, (d) => Number.isInteger(d) && d >= 0 && d <= 6)) : null,
    sessionHours: typeof r.sessionHours === "number" && isFinite(r.sessionHours) && r.sessionHours > 0 && r.sessionHours <= 12 ? r.sessionHours : null,
    planReading: r.planReading === "hours" || r.planReading === "sessions" ? r.planReading : null,
    note: typeof r.note === "string" ? r.note.slice(0, 2000) : "",
    answered: unique(list(r.answered, 1000, text(300))),
    auditChecked: unique(list(r.auditChecked, 1000, text(300))),
  };
}

const EMPTY_RECORD = canon(cleanRecord({}));
const isEmptyRecord = (rec) => canon(rec) === EMPTY_RECORD;

/*
  Someone saved this student's answers based on an older copy than the one stored now
  (a colleague saved in between). Combine the two rather than let the later save wipe the
  earlier one:
    - lists (holds, months, answered questions): what each side added is kept, what each
      side removed is removed;
    - hour corrections add up, since each one is a delta;
    - a single value (schedule, plan reading, note, a month's plan) changed on both sides:
      the later save wins, as it would at one computer.
  All three records must already be cleaned.
*/
export function mergeRecords(base, mine, theirs) {
  const same = (a, b) => canon(a) === canon(b);
  const pick = (b, m, t) => (same(m, b) ? t : m);
  const lists = (b, m, t) => {
    const inB = new Set(b.map(canon)), inM = new Set(m.map(canon)), inT = new Set(t.map(canon));
    const out = t.filter((x) => !(inB.has(canon(x)) && !inM.has(canon(x))));
    for (const x of m) if (!inT.has(canon(x)) && !inB.has(canon(x))) out.push(x);
    return out;
  };
  const maps = (b, m, t, both) => {
    const out = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
      const v = same(m[k], b[k]) ? t[k] : same(t[k], b[k]) ? m[k] : both(b[k], m[k], t[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const out = {};
  for (const f of ["holds", "holdDates", "notEnrolled", "charged", "answered", "auditChecked"]) out[f] = lists(base[f], mine[f], theirs[f]);
  out.planHours = maps(base.planHours, mine.planHours, theirs.planHours, (b, m) => m);
  out.hourAdjust = maps(base.hourAdjust, mine.hourAdjust, theirs.hourAdjust, (b, m, t) => (t || 0) + (m || 0) - (b || 0));
  const schedule = pick({ w: base.weekdays, h: base.sessionHours }, { w: mine.weekdays, h: mine.sessionHours },
                        { w: theirs.weekdays, h: theirs.sessionHours });
  out.weekdays = schedule.w;
  out.sessionHours = schedule.h;
  out.planReading = pick(base.planReading, mine.planReading, theirs.planReading);
  out.note = pick(base.note, mine.note, theirs.note);
  return cleanRecord(out);
}

const publicUser = (name, user) => ({ name, admin: !!user.admin, mustChange: !!user.mustChange });
const newSessionId = () => randomBytes(12).toString("base64url");

/*
  options:
    authStore, dataStore   Netlify Blobs stores (or anything with the same methods)
    env                    { SETUP_CODE, SESSION_SECRET }
    cache                  an object kept between requests (signing secret, backup day)
    now                    clock, for tests
    iterations             PBKDF2 count for new passwords (tests lower it)
    secureCookie           false only for a plain-http test server
    warnMissingEtag        log when a stored item comes back without an ETag (production)
*/
export function createApi(options) {
  const { authStore, dataStore } = options;
  const env = options.env || {};
  const cache = options.cache || {};
  const now = options.now || (() => Date.now());
  const iterations = options.iterations || PASSWORD_ITERATIONS;
  const secureCookie = options.secureCookie !== false;

  /*
    The condition for writing back something just read: only if it is still the version
    read (its ETag), or only if it still does not exist. Netlify returns an ETag with
    every read; if one were ever missing, the write goes ahead unconditionally rather
    than failing forever, losing only the protection against two saves at the same
    instant. (The Blobs test server and `netlify dev` send none on reads.)
  */
  function writeCondition(got) {
    if (!got) return { onlyIfNew: true };
    if (got.etag) return { onlyIfMatch: got.etag };
    if (options.warnMissingEtag && !cache.warnedEtag) {
      cache.warnedEtag = true;
      console.warn("makeup-tracker: a Netlify Blobs read came back without an ETag; saves at the same instant are not protected");
    }
    return {};
  }

  // A conditional write that reports success must come back with the new ETag. The Blobs
  // client reports any reply other than "precondition failed" as success, so a server
  // error would otherwise pass for a save.
  async function writeIf(store, key, value, condition, metadata) {
    const opts = { ...condition, ...(metadata ? { metadata } : {}) };
    const wrote = typeof value === "string" ? await store.set(key, value, opts) : await store.setJSON(key, value, opts);
    if (wrote.modified && Object.keys(condition).length && !wrote.etag) throw new Error("conditional write reported success without an ETag");
    return wrote;
  }

  /* --- signing secret --------------------------------------------------- */

  async function secret() {
    if (env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 32) return String(env.SESSION_SECRET);
    if (cache.secret) return cache.secret;
    let value = await authStore.get("session-secret");
    if (!value) {
      const fresh = randomBytes(32).toString("base64");
      const wrote = await writeIf(authStore, "session-secret", fresh, { onlyIfNew: true });
      value = wrote.modified ? fresh : await authStore.get("session-secret");
    }
    cache.secret = value;
    return value;
  }

  const sign = async (payload) => b64url(createHmac("sha256", await secret()).update(payload).digest());

  /* --- accounts --------------------------------------------------------- */

  async function readAccounts() {
    const got = await authStore.getWithMetadata("accounts", { type: "json" });
    const doc = got && got.data && typeof got.data.users === "object" ? got.data : { version: 1, users: {} };
    return { doc, condition: writeCondition(got) };
  }

  // Read, change, write only if nobody else wrote in between; otherwise go round again.
  async function changeAccounts(change) {
    for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
      const { doc, condition } = await readAccounts();
      const result = change(doc);
      const wrote = await writeIf(authStore, "accounts", doc, condition);
      if (wrote.modified) return result;
    }
    throw new HttpError(503, "Too many changes at once. Try again.");
  }

  // Checked again inside every admin change, against the accounts as they are at that
  // moment: two admins removing each other at once must not leave nobody in charge.
  function stillAdmin(doc, ctx) {
    const actor = own(doc.users, ctx.me.name) ? doc.users[ctx.me.name] : null;
    if (!actor || !actor.admin) throw new HttpError(400, "Only an admin can do that.");
  }

  async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await pbkdf2(password.normalize("NFC"), salt, iterations, 32, "sha256");
    return { algo: "pbkdf2-sha256", iterations, salt: salt.toString("base64"), hash: key.toString("base64") };
  }

  async function passwordMatches(user, password) {
    const want = Buffer.from(user.hash, "base64");
    const got = await pbkdf2(String(password).normalize("NFC"), Buffer.from(user.salt, "base64"), user.iterations, want.length || 32, "sha256");
    return want.length === got.length && timingSafeEqual(want, got);
  }

  // Checked against when the username does not exist, so a wrong username takes as long
  // as a wrong password and cannot be told apart by timing.
  const DUMMY = { salt: "c2lnbi1pbi10aW1pbmc=", hash: Buffer.alloc(32).toString("base64"), iterations };

  /* --- sign-in limits -------------------------------------------------------- */

  const failKey = (kind, id) => "fail/" + kind + "/" + sha256(id).toString("hex").slice(0, 32);

  /*
    Count one try against `key` before the password is even checked, with a conditional
    write so parallel tries cannot slip past the count. Returns the time the key is locked
    until (0 when this try may go ahead). If the count cannot be written, the try is
    refused rather than let through uncounted.
  */
  async function countTry(key, limit) {
    for (let attempt = 0; attempt < WRITE_TRIES * 2; attempt++) {
      const got = await authStore.getWithMetadata(key, { type: "json" });
      const was = got && got.data ? got.data : null;
      if (was && was.until > now()) return was.until;
      const rec = was && now() - was.first <= LOCK.windowMs ? { ...was } : { count: 0, first: now(), until: 0 };
      rec.count++;
      if (rec.count > limit) rec.until = now() + LOCK.lockMs;
      const wrote = await writeIf(authStore, key, rec, writeCondition(got));
      if (wrote.modified) return rec.until > now() ? rec.until : 0;
    }
    return now() + 60000;
  }

  async function lockedUntil(key) {
    const rec = await authStore.get(key, { type: "json" });
    return rec && rec.until > now() ? rec.until : 0;
  }

  // Wrong passwords from one connection, counted after the fact: only failures count, so
  // a centre where everyone signs in from one address is not locked out by its own staff.
  async function noteFailure(key, limit) {
    const rec = (await authStore.get(key, { type: "json" })) || { count: 0, first: now(), until: 0 };
    if (now() - rec.first > LOCK.windowMs) { rec.count = 0; rec.first = now(); }
    rec.count++;
    if (rec.count >= limit) { rec.until = now() + LOCK.lockMs; rec.count = 0; rec.first = now(); }
    await authStore.setJSON(key, rec);
  }

  function refuse(until) {
    const minutes = Math.max(1, Math.ceil((until - now()) / 60000));
    throw new HttpError(429, "Too many wrong tries. Try again in " + minutes + " minute" + (minutes === 1 ? "" : "s") + ".", { retryAt: until });
  }

  /* --- sessions ---------------------------------------------------------- */

  function cookieHeader(value, maxAge) {
    return COOKIE + "=" + value + "; Path=/api; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + (secureCookie ? "; Secure" : "");
  }

  async function issue(name, user) {
    const payload = b64url(JSON.stringify({ u: name, s: user.sid, x: now() + SESSION_HOURS * 3600000 }));
    return cookieHeader(payload + "." + (await sign(payload)), SESSION_HOURS * 3600);
  }

  async function sessionUser(req) {
    const raw = readCookie(req, COOKIE);
    if (!raw) return null;
    const [payload, mac] = raw.split(".");
    if (!payload || !mac || !sameText(mac, await sign(payload))) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch (e) { return null; }
    if (!data || typeof data.u !== "string" || typeof data.s !== "string" || !(data.x > now())) return null;
    const { doc } = await readAccounts();
    const user = own(doc.users, data.u) ? doc.users[data.u] : null;
    // Every account carries a random session id, replaced on a password change or reset
    // and new for an account removed and added again, so each of those ends old sessions.
    if (!user || typeof user.sid !== "string" || !sameText(user.sid, data.s)) return null;
    return { name: data.u, user, accounts: doc };
  }

  const signedInBody = (name, user) => ({ service: "makeup-tracker", signedIn: true, user: publicUser(name, user) });

  /* --- routes: signing in ------------------------------------------------ */

  async function getSession(req, ctx) {
    const { doc } = await readAccounts();
    const setupNeeded = Object.keys(doc.users).length === 0;
    const me = ctx.me;
    return json(200, {
      service: "makeup-tracker",
      signedIn: !!me,
      user: me ? publicUser(me.name, me.user) : null,
      setupNeeded,
      setupAllowed: setupNeeded && String(env.SETUP_CODE || "").length >= 8,
    });
  }

  async function setup(req, ctx) {
    const body = await readJson(req);
    const ipKey = failKey("ip", ctx.ip || "unknown");
    const locked = await lockedUntil(ipKey);
    if (locked) refuse(locked);
    const code = String(env.SETUP_CODE || "");
    if (code.length < 8) {
      throw new HttpError(400, "Setup is turned off. Add a SETUP_CODE environment variable (8 or more characters) in Netlify, then redeploy.");
    }
    const { doc } = await readAccounts();
    if (Object.keys(doc.users).length) throw new HttpError(409, "Setup is already done. Sign in instead.");
    if (!sameText(String(body.code || ""), code)) {
      await noteFailure(ipKey, LOCK.ipFails);
      throw new HttpError(400, "That setup code is not right.");
    }
    const name = cleanUsername(body.username);
    const cred = await hashPassword(checkNewPassword(body.password));
    const user = { ...cred, admin: true, mustChange: false, sid: newSessionId(), created: now(), createdBy: name };
    await changeAccounts((accounts) => {
      if (Object.keys(accounts.users).length) throw new HttpError(409, "Setup is already done. Sign in instead.");
      accounts.users[name] = user;
    });
    return json(200, signedInBody(name, user), { "set-cookie": await issue(name, user) });
  }

  async function login(req, ctx) {
    const body = await readJson(req);
    const name = String(body.username == null ? "" : body.username).trim().toLowerCase().slice(0, 64);
    const password = String(body.password == null ? "" : body.password).slice(0, MAX_PASSWORD);
    const userKey = failKey("user", name);
    const ipKey = failKey("ip", ctx.ip || "unknown");
    const ipLocked = await lockedUntil(ipKey);
    if (ipLocked) refuse(ipLocked);
    const userLocked = await countTry(userKey, LOCK.userTries);
    if (userLocked) refuse(userLocked);
    const { doc } = await readAccounts();
    const user = own(doc.users, name) ? doc.users[name] : null;
    const matches = await passwordMatches(user || DUMMY, password);
    if (!user || !matches) {
      await noteFailure(ipKey, LOCK.ipFails);
      throw new HttpError(401, "Wrong username or password.");
    }
    await authStore.delete(userKey);
    return json(200, signedInBody(name, user), { "set-cookie": await issue(name, user) });
  }

  async function logout() {
    return json(200, { service: "makeup-tracker", signedIn: false }, { "set-cookie": cookieHeader("", 0) });
  }

  async function changePassword(req, ctx) {
    const body = await readJson(req);
    const me = ctx.me;
    const userKey = failKey("user", me.name);
    const locked = await countTry(userKey, LOCK.userTries);
    if (locked) refuse(locked);
    if (!(await passwordMatches(me.user, String(body.current || "")))) {
      throw new HttpError(401, "Your current password is not right.");
    }
    await authStore.delete(userKey);
    const next = checkNewPassword(body.next);
    if (next === String(body.current || "")) throw new HttpError(400, "Pick a password different from the current one.");
    const cred = await hashPassword(next);
    const user = await changeAccounts((accounts) => {
      const rec = own(accounts.users, me.name) ? accounts.users[me.name] : null;
      if (!rec) throw new HttpError(401, "Your account was removed.");
      Object.assign(rec, cred, { mustChange: false, sid: newSessionId(), changed: now() });
      return rec;
    });
    // Other signed-in browsers for this account are signed out by the new session id;
    // this one gets a fresh cookie.
    return json(200, signedInBody(me.name, user), { "set-cookie": await issue(me.name, user) });
  }

  /* --- routes: accounts (admins) ----------------------------------------- */

  function listOf(accounts) {
    return Object.keys(accounts.users).sort().map((name) => {
      const u = accounts.users[name];
      return { name, admin: !!u.admin, mustChange: !!u.mustChange, created: u.created || null, createdBy: u.createdBy || null };
    });
  }

  async function listUsers(req, ctx) {
    return json(200, { users: listOf(ctx.me.accounts) });
  }

  async function addUser(req, ctx) {
    const body = await readJson(req);
    const name = cleanUsername(body.username);
    const cred = await hashPassword(checkNewPassword(body.password));
    const accounts = await changeAccounts((doc) => {
      stillAdmin(doc, ctx);
      if (own(doc.users, name)) throw new HttpError(409, "There is already an account called " + name + ".");
      doc.users[name] = { ...cred, admin: !!body.admin, mustChange: true, sid: newSessionId(), created: now(), createdBy: ctx.me.name };
      return doc;
    });
    return json(200, { users: listOf(accounts) });
  }

  function otherUser(match, ctx, verb) {
    const name = cleanUsername(decodeURIComponent(match[1]));
    if (name === ctx.me.name) throw new HttpError(400, "You cannot " + verb + " your own account here.");
    return name;
  }

  async function resetUser(req, ctx, match) {
    const name = otherUser(match, ctx, "reset");
    const body = await readJson(req);
    const cred = await hashPassword(checkNewPassword(body.password));
    const accounts = await changeAccounts((doc) => {
      stillAdmin(doc, ctx);
      const rec = own(doc.users, name) ? doc.users[name] : null;
      if (!rec) throw new HttpError(400, "There is no account called " + name + ".");
      Object.assign(rec, cred, { mustChange: true, sid: newSessionId(), changed: now() });
      return doc;
    });
    await authStore.delete(failKey("user", name));
    return json(200, { users: listOf(accounts) });
  }

  async function setAdmin(req, ctx, match) {
    const name = otherUser(match, ctx, "change");
    const body = await readJson(req);
    const accounts = await changeAccounts((doc) => {
      stillAdmin(doc, ctx);
      const rec = own(doc.users, name) ? doc.users[name] : null;
      if (!rec) throw new HttpError(400, "There is no account called " + name + ".");
      rec.admin = !!body.admin;
      return doc;
    });
    return json(200, { users: listOf(accounts) });
  }

  async function removeUser(req, ctx, match) {
    const name = otherUser(match, ctx, "remove");
    const accounts = await changeAccounts((doc) => {
      stillAdmin(doc, ctx);
      if (!own(doc.users, name)) throw new HttpError(400, "There is no account called " + name + ".");
      delete doc.users[name];
      return doc;
    });
    return json(200, { users: listOf(accounts) });
  }

  /* --- routes: shared answers -------------------------------------------- */

  async function answersMeta() {
    const got = await dataStore.getMetadata("answers");
    if (!got) return null;
    return { etag: got.etag || null, savedBy: got.metadata.savedBy || null, savedAt: got.metadata.savedAt || null };
  }

  const answersBody = (doc, etag, metadata) => ({
    answers: { version: doc.version || 1, students: doc.students || {} },
    meta: doc.meta || {},
    etag: etag || null,
    savedBy: (metadata && metadata.savedBy) || null,
    savedAt: (metadata && metadata.savedAt) || null,
  });

  async function getAnswers(req) {
    const head = await answersMeta();
    if (!head) return json(200, answersBody({}, null, null));
    if (head.etag && req.headers.get("if-none-match") === head.etag) {
      return new Response(null, { status: 304, headers: { "cache-control": "no-store", etag: head.etag } });
    }
    const got = await dataStore.getWithMetadata("answers", { type: "json" });
    if (!got) return json(200, answersBody({}, null, null));
    return json(200, answersBody(got.data || {}, got.etag, got.metadata));
  }

  /*
    Copies of the answers: the first save of each day keeps the answers as they were
    before it, and a save that clears many students keeps a copy first. Admins can
    download these from Accounts and put them back with "Load answers". Thirty days kept.
  */
  async function backupAnswers(doc, reason) {
    const day = new Date(now()).toISOString().slice(0, 10);
    let name;
    if (reason === "clear") {
      name = new Date(now()).toISOString().replace(/[:.]/g, "-") + "-before-clear";
    } else {
      if (cache.backupDay === day) return;
      name = day;
      if (await dataStore.getMetadata("backup/answers/" + name)) { cache.backupDay = day; return; }
    }
    const students = Object.keys(doc.students || {}).length;
    await dataStore.setJSON("backup/answers/" + name, doc, { onlyIfNew: true, metadata: { savedAt: now(), students, reason: reason || "daily" } });
    if (reason !== "clear") cache.backupDay = day;
    const cutoff = new Date(now() - BACKUP_DAYS * 86400000).toISOString().slice(0, 10);
    const { blobs } = await dataStore.list({ prefix: "backup/answers/" });
    for (const b of blobs) if (b.key.slice("backup/answers/".length, "backup/answers/".length + 10) < cutoff) await dataStore.delete(b.key);
  }

  /*
    A save names whole student records: { set: { <key>: record }, remove: [keys],
    base: { <key>: the record this change was based on, or null } }.

    When the stored record is still the base, the change simply replaces it. When a
    colleague saved that student in between, the two are combined (mergeRecords) rather
    than one wiping the other. Without a base (an older page), the change replaces.
  */
  async function patchAnswers(req, ctx) {
    const body = await readJson(req);
    const set = body.set && typeof body.set === "object" && !Array.isArray(body.set) ? body.set : {};
    const remove = Array.isArray(body.remove) ? body.remove : [];
    const base = body.base && typeof body.base === "object" && !Array.isArray(body.base) ? body.base : null;
    const keys = Object.keys(set);
    if (keys.length + remove.length > 5000) throw new HttpError(400, "That is too many changes at once.");
    for (const key of [...keys, ...remove]) {
      if (typeof key !== "string" || !key || key.length > 300 || key === "__proto__") throw new HttpError(400, "A student key in that change is not valid.");
    }
    for (const key of keys) {
      const rec = set[key];
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new HttpError(400, "A student record in that change is not valid.");
      if (JSON.stringify(rec).length > MAX_STUDENT_RECORD) throw new HttpError(400, "A student record in that change is too large.");
    }
    if (remove.length > STAFF_REMOVE_LIMIT && !ctx.me.user.admin) {
      throw new HttpError(400, "Only an admin can clear answers for more than " + STAFF_REMOVE_LIMIT + " students at once.");
    }
    const changes = [
      ...keys.map((key) => [key, cleanRecord(set[key])]),
      ...remove.map((key) => [key, cleanRecord({})]),
    ];

    for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
      const got = await dataStore.getWithMetadata("answers", { type: "json" });
      const doc = got && got.data && typeof got.data === "object" ? got.data : {};
      doc.version = doc.version || 1;
      doc.students = doc.students && typeof doc.students === "object" ? doc.students : {};
      doc.meta = doc.meta && typeof doc.meta === "object" ? doc.meta : {};
      if (got && attempt === 0) await backupAnswers(got.data, remove.length > STAFF_REMOVE_LIMIT ? "clear" : null);
      const at = now();
      for (const [key, mine] of changes) {
        const stored = cleanRecord(own(doc.students, key) ? doc.students[key] : {});
        let result = mine;
        if (base && own(base, key)) {
          const was = cleanRecord(base[key] || {});
          if (canon(stored) !== canon(was)) result = mergeRecords(was, mine, stored);
        }
        if (isEmptyRecord(result)) {
          delete doc.students[key];
          delete doc.meta[key];
        } else {
          doc.students[key] = result;
          doc.meta[key] = { by: ctx.me.name, at };
        }
      }
      if (JSON.stringify(doc).length > MAX_ANSWERS) throw new HttpError(413, "The shared answers have grown too large to save.");
      const metadata = { savedBy: ctx.me.name, savedAt: at };
      const wrote = await writeIf(dataStore, "answers", doc, writeCondition(got), metadata);
      if (wrote.modified) return json(200, answersBody(doc, wrote.etag, metadata));
    }
    throw new HttpError(503, "Too many people saving at once. Try again.");
  }

  async function listBackups() {
    const { blobs } = await dataStore.list({ prefix: "backup/answers/" });
    const out = [];
    for (const b of blobs) {
      const m = await dataStore.getMetadata(b.key);
      out.push({ name: b.key.slice("backup/answers/".length), savedAt: (m && m.metadata.savedAt) || null,
                 students: (m && m.metadata.students) || 0, reason: (m && m.metadata.reason) || "daily" });
    }
    out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return json(200, { backups: out });
  }

  async function getBackup(req, ctx, match) {
    const doc = await dataStore.get("backup/answers/" + match[1], { type: "json" });
    if (!doc) throw new HttpError(409, "That backup is not there any more.");
    return json(200, { version: doc.version || 1, students: doc.students || {} });
  }

  /* --- routes: shared exports -------------------------------------------- */

  const exportKey = (which) => "export/" + which;

  async function exportMeta(which) {
    const got = await dataStore.getMetadata(exportKey(which));
    if (!got) return null;
    const m = got.metadata || {};
    return { fileName: m.fileName || "", rows: m.rows || 0, savedBy: m.savedBy || null, savedAt: m.savedAt || null, etag: got.etag || null };
  }

  async function exportsMeta() {
    return { attendance: await exportMeta("attendance"), roster: await exportMeta("roster") };
  }

  async function status() {
    return json(200, { answers: await answersMeta(), exports: await exportsMeta() });
  }

  async function listExports() {
    return json(200, { exports: await exportsMeta() });
  }

  async function getExport(req, ctx, match) {
    const which = match[1];
    const bytes = await dataStore.get(exportKey(which), { type: "arrayBuffer" });
    if (!bytes) throw new HttpError(409, "Nobody has shared that export yet.");
    return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  }

  function checkExport(which, data) {
    const spec = EXPORT_COLUMNS[which];
    if (!data || !Array.isArray(data.headers) || !Array.isArray(data.records)) {
      throw new HttpError(400, "That upload is not an export the calculator can read.");
    }
    const allowed = new Set(spec.allowed);
    for (const h of data.headers) {
      if (typeof h !== "string") throw new HttpError(400, "That upload has a column name that is not text.");
      if (!allowed.has(h)) {
        throw new HttpError(400, 'That upload carries a column the calculator does not use ("' + h.slice(0, 60) + '"). Only the columns it needs can be shared.');
      }
    }
    for (const col of spec.required) {
      if (!data.headers.includes(col)) {
        throw new HttpError(400, 'That does not look like the ' + spec.label + ': it has no "' + col + '" column.');
      }
    }
    if (data.records.length > MAX_ROWS) throw new HttpError(413, "That export has too many rows.");
    const headers = new Set(data.headers);
    for (const rec of data.records) {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new HttpError(400, "That upload has a row that is not readable.");
      for (const [k, v] of Object.entries(rec)) {
        if (!headers.has(k)) throw new HttpError(400, "That upload has a value outside its columns.");
        if (typeof v !== "string" && typeof v !== "number") throw new HttpError(400, "That upload has a value that is not text.");
        if (String(v).length > MAX_CELL) throw new HttpError(400, "That upload has a value that is too long.");
      }
    }
  }

  async function putExport(req, ctx, match) {
    const which = match[1];
    const packed = await readBody(req, MAX_EXPORT_UPLOAD);
    let data;
    try {
      data = JSON.parse(gunzipSync(packed, { maxOutputLength: MAX_EXPORT_JSON }).toString("utf8"));
    } catch (e) {
      throw new HttpError(400, "That upload is not an export the calculator can read.");
    }
    checkExport(which, data);
    const metadata = {
      fileName: String(data.fileName || which + ".xlsx").slice(0, 200),
      rows: data.records.length,
      savedBy: ctx.me.name,
      savedAt: now(),
    };
    await dataStore.set(exportKey(which), packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.length), { metadata });
    return json(200, { exports: await exportsMeta() });
  }

  async function deleteExports() {
    await dataStore.delete(exportKey("attendance"));
    await dataStore.delete(exportKey("roster"));
    return json(200, { exports: await exportsMeta() });
  }

  /* --- routing ----------------------------------------------------------- */

  // access: "open" anyone; "signed" signed in, even with a temporary password;
  // "user" signed in with their own password; "admin" the same, and an admin.
  const ROUTES = [
    ["GET", /^\/session$/, getSession, "open"],
    ["POST", /^\/setup$/, setup, "open"],
    ["POST", /^\/login$/, login, "open"],
    ["POST", /^\/logout$/, logout, "open"],
    ["POST", /^\/password$/, changePassword, "signed"],
    ["GET", /^\/users$/, listUsers, "admin"],
    ["POST", /^\/users$/, addUser, "admin"],
    ["POST", /^\/users\/([^/]+)\/reset$/, resetUser, "admin"],
    ["POST", /^\/users\/([^/]+)\/admin$/, setAdmin, "admin"],
    ["DELETE", /^\/users\/([^/]+)$/, removeUser, "admin"],
    ["GET", /^\/status$/, status, "user"],
    ["GET", /^\/answers$/, getAnswers, "user"],
    ["PATCH", /^\/answers$/, patchAnswers, "user"],
    ["GET", /^\/backups$/, listBackups, "admin"],
    ["GET", /^\/backups\/([0-9TZ-]+(?:-before-clear)?)$/, getBackup, "admin"],
    ["GET", /^\/exports$/, listExports, "user"],
    ["GET", /^\/exports\/(attendance|roster)$/, getExport, "user"],
    ["PUT", /^\/exports\/(attendance|roster)$/, putExport, "user"],
    ["DELETE", /^\/exports$/, deleteExports, "admin"],
  ];

  /*
    Status codes: 401 means "sign in", and the page shows the sign-in screen for it.
    Everything this API refuses on purpose is 400 or 409, never 403 or 404, because a
    403 or 404 from a function can be retried against static files (index.html, .htm)
    the way the CDN serves pages, and the page would get that back instead of the
    reason. Only an unknown /api path is a 404.
  */
  return async function handle(req, info) {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
      const method = req.method.toUpperCase();
      const onPath = ROUTES.filter((r) => r[1].test(path));
      if (!onPath.length) throw new HttpError(404, "Not found.");
      const route = onPath.find((r) => r[0] === method);
      if (!route) throw new HttpError(405, "Not allowed.");

      // Anything that changes something must come from this site's own page: a custom
      // header forces a cross-site request into a preflight this API never answers, and
      // the Origin, when the browser sends one, must be this site.
      if (method !== "GET") {
        if (req.headers.get("x-makeup-tracker") !== "1") throw new HttpError(400, "Requests must come from the calculator page.");
        const origin = req.headers.get("origin");
        if (origin && origin !== url.origin) throw new HttpError(400, "Requests must come from the calculator page.");
      }

      const me = await sessionUser(req);
      const access = route[3];
      if (access !== "open") {
        if (!me) throw new HttpError(401, "Sign in again to carry on.", { signedIn: false });
        if (access !== "signed" && me.user.mustChange) throw new HttpError(409, "Choose a new password first.", { mustChange: true });
        if (access === "admin" && !me.user.admin) throw new HttpError(400, "Only an admin can do that.");
      }
      return await route[2](req, { me, ip: info && info.ip }, path.match(route[1]));
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      // Never log request bodies: they carry student names.
      console.error("makeup-tracker api error:", err && err.name, err && err.message);
      return json(500, { error: "Something went wrong on the server. Try again." });
    }
  };
}
