/*
  Tests for the shared side (netlify/lib/core.mjs): sign-in, accounts, shared answers
  and shared exports.

    node --test tests/api.test.mjs        (needs: npm install)

  Netlify runs these on every deploy (netlify.toml), so a change that breaks sign-in or
  saving never goes live. They need no Netlify account: each test runs against an
  in-memory store that follows Netlify's documented ETag rules, and the main flows run a
  second time against the Netlify Blobs test server through the real @netlify/blobs
  client. No real student data: the names below are made up.
*/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
import { getStore } from "@netlify/blobs";
import { createApi, LOCK, SESSION_HOURS, PASSWORD_ITERATIONS, STAFF_REMOVE_LIMIT, cleanRecord } from "../netlify/lib/core.mjs";

const CODE = "temple-city-setup";

/* --- stores ---------------------------------------------------------------- */

// Netlify's documented behavior: every read returns an ETag, a conditional write that
// loses the race returns { modified: false }, and a write replaces the metadata.
class MemoryStore {
  // beforeWrite: run once, just before the next write to hookKey (or to any key), to land
  // a competing save between someone's read and their write.
  constructor() { this.items = new Map(); this.n = 0; this.beforeWrite = null; this.hookKey = null; this.writes = 0; }
  decode(item, type) {
    if (type === "json") return JSON.parse(Buffer.from(item.data).toString("utf8"));
    if (type === "arrayBuffer") return item.data.buffer.slice(item.data.byteOffset, item.data.byteOffset + item.data.length);
    return Buffer.from(item.data).toString("utf8");
  }
  async get(key, opts = {}) { const it = this.items.get(key); return it ? this.decode(it, opts.type) : null; }
  async getWithMetadata(key, opts = {}) {
    const it = this.items.get(key);
    return it ? { data: this.decode(it, opts.type), etag: it.etag, metadata: { ...it.metadata } } : null;
  }
  async getMetadata(key) { const it = this.items.get(key); return it ? { etag: it.etag, metadata: { ...it.metadata } } : null; }
  async set(key, data, opts = {}) {
    if (this.beforeWrite && (!this.hookKey || this.hookKey === key)) { const hook = this.beforeWrite; this.beforeWrite = null; await hook(key); }
    if (this.failConditional && (opts.onlyIfMatch || opts.onlyIfNew)) return { modified: true, etag: "" };
    this.writes++;
    const cur = this.items.get(key);
    if (opts.onlyIfNew && cur) return { modified: false };
    if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
    const etag = '"' + ++this.n + '"';
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(new Uint8Array(data));
    this.items.set(key, { data: bytes, etag, metadata: opts.metadata || {} });
    return { modified: true, etag };
  }
  async setJSON(key, value, opts) { return this.set(key, JSON.stringify(value), opts); }
  async delete(key) { this.items.delete(key); }
  async list({ prefix = "" } = {}) {
    return { blobs: [...this.items.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, it]) => ({ key, etag: it.etag })), directories: [] };
  }
}

async function blobsServerStores() {
  const dir = mkdtempSync(join(tmpdir(), "makeup-blobs-"));
  const server = new BlobsServer({ directory: dir, token: "test-token" });
  const { port } = await server.start();
  const url = "http://localhost:" + port;
  const open = (name) => getStore({ name, siteID: "test-site", token: "test-token", edgeURL: url, uncachedEdgeURL: url, consistency: "strong" });
  return {
    authStore: open("makeup-auth"),
    dataStore: open("makeup-data"),
    close: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/* --- a site and its browsers ------------------------------------------------ */

function site(stores, overrides = {}) {
  const clock = { t: Date.UTC(2026, 9, 26, 20, 0, 0) };
  const api = createApi({
    authStore: stores.authStore,
    dataStore: stores.dataStore,
    env: { SETUP_CODE: CODE },
    cache: {},
    now: () => clock.t,
    iterations: 1000,
    ...overrides,
  });
  // One browser: keeps its own cookie, like a real one.
  const browser = (ip = "10.0.0.1") => {
    const jar = { cookie: "" };
    const call = async (method, path, { json, raw, headers = {}, csrf = true, origin } = {}) => {
      const h = new Headers(headers);
      if (csrf && method !== "GET") h.set("x-makeup-tracker", "1");
      if (origin) h.set("origin", origin);
      if (jar.cookie) h.set("cookie", jar.cookie);
      let body;
      if (json !== undefined) { body = JSON.stringify(json); h.set("content-type", "application/json"); }
      if (raw !== undefined) body = raw;
      const res = await api(new Request("https://makeup.example" + path, { method, headers: h, body }), { ip });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const pair = setCookie.split(";")[0];
        jar.cookie = /Max-Age=0/.test(setCookie) ? "" : pair;
      }
      const type = res.headers.get("content-type") || "";
      const data = res.status === 304 ? null : type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, setCookie, headers: res.headers };
    };
    return { call, jar };
  };
  return { api, clock, browser };
}

async function withAdmin(stores, opts) {
  const s = site(stores, opts);
  const admin = s.browser();
  const r = await admin.call("POST", "/api/setup", { json: { code: CODE, username: "Ethan", password: "first-password" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { ...s, admin };
}

async function addUser(admin, s, name, password = "temporary-1", isAdmin = false) {
  const r = await admin.call("POST", "/api/users", { json: { username: name, password, admin: isAdmin } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const b = s.browser("10.0.0." + (name.length + 10));
  const signIn = await b.call("POST", "/api/login", { json: { username: name, password } });
  assert.equal(signIn.status, 200);
  assert.equal(signIn.data.user.mustChange, true);
  const changed = await b.call("POST", "/api/password", { json: { current: password, next: password + "-mine" } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  return b;
}

const attendanceUpload = (extra = {}) => gzipSync(Buffer.from(JSON.stringify({
  fileName: "Student Attendance Report Export 10_26_2026.xlsx",
  headers: ["First Name", "Last Name", "Attendance Date", "Duration (Minutes)", "Sessions Per Month", "Start Time"],
  records: [
    { "First Name": "Test", "Last Name": "Student", "Attendance Date": "46230", "Duration (Minutes)": "60", "Sessions Per Month": "8", "Start Time": "3:30 PM" },
    { "First Name": "Sample", "Last Name": "Pupil", "Attendance Date": "46231", "Duration (Minutes)": "120", "Sessions Per Month": "4", "Start Time": "12:00 AM" },
  ],
  ...extra,
})));

/* --- the flows, against both stores ----------------------------------------- */

for (const kind of ["memory", "blobs test server"]) {
  describe("shared flows (" + kind + ")", () => {
    const make = async () => (kind === "memory" ? { authStore: new MemoryStore(), dataStore: new MemoryStore(), close: async () => {} } : blobsServerStores());

    test("setup makes the first admin once, and only with the code", async () => {
      const stores = await make();
      try {
        const s = site(stores);
        const b = s.browser();
        let r = await b.call("GET", "/api/session");
        assert.equal(r.status, 200);
        assert.deepEqual([r.data.service, r.data.signedIn, r.data.setupNeeded, r.data.setupAllowed], ["makeup-tracker", false, true, true]);

        r = await b.call("POST", "/api/setup", { json: { code: "wrong-code-123", username: "ethan", password: "first-password" } });
        assert.equal(r.status, 400);
        assert.match(r.data.error, /setup code/);
        r = await b.call("POST", "/api/setup", { json: { code: CODE, username: "x", password: "first-password" } });
        assert.equal(r.status, 400, "one-letter username refused");
        r = await b.call("POST", "/api/setup", { json: { code: CODE, username: "ethan", password: "short" } });
        assert.equal(r.status, 400, "short password refused");

        r = await b.call("POST", "/api/setup", { json: { code: CODE, username: " Ethan ", password: "first-password" } });
        assert.equal(r.status, 200);
        assert.deepEqual(r.data.user, { name: "ethan", admin: true, mustChange: false });
        assert.match(r.setCookie, /HttpOnly/);
        assert.match(r.setCookie, /SameSite=Strict/);
        assert.match(r.setCookie, /Secure/);
        assert.match(r.setCookie, /Path=\/api/);

        r = await b.call("GET", "/api/session");
        assert.equal(r.data.signedIn, true);
        assert.equal(r.data.setupNeeded, false);

        r = await s.browser().call("POST", "/api/setup", { json: { code: CODE, username: "other", password: "first-password" } });
        assert.equal(r.status, 409, "setup cannot run twice");
      } finally { await stores.close(); }
    });

    test("sign in, sign out, wrong passwords", async () => {
      const stores = await make();
      try {
        const s = await withAdmin(stores);
        const b = s.browser();
        let r = await b.call("POST", "/api/login", { json: { username: "ethan", password: "nope-nope-nope" } });
        assert.equal(r.status, 401);
        const wrongPassword = r.data.error;
        r = await b.call("POST", "/api/login", { json: { username: "nobody", password: "nope-nope-nope" } });
        assert.equal(r.status, 401);
        assert.equal(r.data.error, wrongPassword, "unknown username and wrong password read the same");

        r = await b.call("POST", "/api/login", { json: { username: "ETHAN", password: "first-password" } });
        assert.equal(r.status, 200);
        assert.equal((await b.call("GET", "/api/status")).status, 200);

        r = await b.call("POST", "/api/logout");
        assert.equal(r.status, 200);
        assert.match(r.setCookie, /Max-Age=0/);
        assert.equal((await b.call("GET", "/api/status")).status, 401);
      } finally { await stores.close(); }
    });

    test("answers from two people about different students both survive", async () => {
      const stores = await make();
      try {
        const s = await withAdmin(stores);
        const maria = await addUser(s.admin, s, "maria");
        const a = "test\u001fstudent", b = "sample\u001fpupil";
        let r = await s.admin.call("PATCH", "/api/answers", { json: { set: { [a]: { holds: [{ start: "2026-09", until: null }] } } } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        r = await maria.call("PATCH", "/api/answers", { json: { set: { [b]: { weekdays: [2, 4] } } } });
        assert.equal(r.status, 200);
        assert.deepEqual(Object.keys(r.data.answers.students).sort(), [b, a].sort());
        assert.equal(r.data.meta[a].by, "ethan");
        assert.equal(r.data.meta[b].by, "maria");
        assert.equal(r.data.savedBy, "maria");

        r = await s.admin.call("GET", "/api/answers");
        assert.deepEqual(r.data.answers.students[b].weekdays, [2, 4]);

        r = await s.admin.call("PATCH", "/api/answers", { json: { remove: [a] } });
        assert.deepEqual(Object.keys(r.data.answers.students), [b]);
        assert.equal(r.data.meta[a], undefined);

        r = await s.admin.call("GET", "/api/status");
        assert.equal(r.data.answers.savedBy, "ethan");
      } finally { await stores.close(); }
    });

    test("exports: only the used columns, stored byte for byte", async () => {
      const stores = await make();
      try {
        const s = await withAdmin(stores);
        const maria = await addUser(s.admin, s, "maria");
        const upload = attendanceUpload();
        let r = await maria.call("PUT", "/api/exports/attendance", { raw: upload, headers: { "content-type": "application/octet-stream" } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.exports.attendance.rows, 2);
        assert.equal(r.data.exports.attendance.savedBy, "maria");
        assert.equal(r.data.exports.attendance.fileName, "Student Attendance Report Export 10_26_2026.xlsx");
        assert.equal(r.data.exports.roster, null);

        r = await s.admin.call("GET", "/api/exports/attendance");
        assert.equal(r.status, 200);
        assert.ok(Buffer.compare(r.data, upload) === 0, "the same bytes come back");

        r = await maria.call("PUT", "/api/exports/attendance", {
          raw: attendanceUpload({ headers: ["First Name", "Last Name", "Attendance Date", "Duration (Minutes)", "Home Address"] }),
        });
        assert.equal(r.status, 400);
        assert.match(r.data.error, /Home Address/);

        r = await maria.call("PUT", "/api/exports/roster", { raw: attendanceUpload() });
        assert.equal(r.status, 400, "the attendance file dropped on the roster is refused");

        r = await maria.call("DELETE", "/api/exports");
        assert.equal(r.status, 400, "only an admin removes the shared exports");
        assert.match(r.data.error, /Only an admin/);
        r = await s.admin.call("DELETE", "/api/exports");
        assert.equal(r.status, 200);
        assert.equal(r.data.exports.attendance, null);
      } finally { await stores.close(); }
    });
  });
}

/* --- the rest, on the memory store ----------------------------------------- */

const memory = () => ({ authStore: new MemoryStore(), dataStore: new MemoryStore() });

describe("accounts", () => {
  test("a new person must replace their temporary password before using anything", async () => {
    const s = await withAdmin(memory());
    let r = await s.admin.call("POST", "/api/users", { json: { username: "maria", password: "temporary-1" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.users.map((u) => [u.name, u.admin, u.mustChange]), [["ethan", true, false], ["maria", false, true]]);

    const maria = s.browser();
    r = await maria.call("POST", "/api/login", { json: { username: "maria", password: "temporary-1" } });
    assert.equal(r.data.user.mustChange, true);
    r = await maria.call("GET", "/api/answers");
    assert.equal(r.status, 409);
    assert.equal(r.data.mustChange, true);
    r = await maria.call("POST", "/api/password", { json: { current: "temporary-1", next: "temporary-1" } });
    assert.equal(r.status, 400, "the new password must differ");
    r = await maria.call("POST", "/api/password", { json: { current: "temporary-1", next: "marias-own-password" } });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.mustChange, false);
    assert.equal((await maria.call("GET", "/api/answers")).status, 200);
    assert.equal((await maria.call("GET", "/api/users")).status, 400, "not an admin");
  });

  test("taken usernames, and admins cannot remove or reset themselves here", async () => {
    const s = await withAdmin(memory());
    await addUser(s.admin, s, "maria");
    assert.equal((await s.admin.call("POST", "/api/users", { json: { username: "MARIA", password: "another-pass" } })).status, 409);
    assert.equal((await s.admin.call("DELETE", "/api/users/ethan")).status, 400);
    assert.equal((await s.admin.call("POST", "/api/users/ethan/reset", { json: { password: "whatever-123" } })).status, 400);
    assert.equal((await s.admin.call("POST", "/api/users/ghost/reset", { json: { password: "whatever-123" } })).status, 400);
  });

  test("a reset signs the person out everywhere and makes them choose again", async () => {
    const s = await withAdmin(memory());
    const maria = await addUser(s.admin, s, "maria");
    assert.equal((await maria.call("GET", "/api/status")).status, 200);
    const r = await s.admin.call("POST", "/api/users/maria/reset", { json: { password: "reset-temp-1" } });
    assert.equal(r.status, 200);
    assert.equal((await maria.call("GET", "/api/status")).status, 401, "old session ended");
    const again = s.browser();
    const signIn = await again.call("POST", "/api/login", { json: { username: "maria", password: "reset-temp-1" } });
    assert.equal(signIn.data.user.mustChange, true);
  });

  test("removing someone ends their session", async () => {
    const s = await withAdmin(memory());
    const maria = await addUser(s.admin, s, "maria");
    const r = await s.admin.call("DELETE", "/api/users/maria");
    assert.deepEqual(r.data.users.map((u) => u.name), ["ethan"]);
    assert.equal((await maria.call("GET", "/api/status")).status, 401);
  });

  test("an admin can make someone else an admin", async () => {
    const s = await withAdmin(memory());
    const maria = await addUser(s.admin, s, "maria");
    assert.equal((await maria.call("GET", "/api/users")).status, 400);
    await s.admin.call("POST", "/api/users/maria/admin", { json: { admin: true } });
    assert.equal((await maria.call("GET", "/api/users")).status, 200);
    assert.equal((await maria.call("POST", "/api/users/maria/admin", { json: { admin: false } })).status, 400, "not on yourself");
  });

  test("changing your own password signs out your other browsers but not this one", async () => {
    const s = await withAdmin(memory());
    const laptop = s.browser();
    await laptop.call("POST", "/api/login", { json: { username: "ethan", password: "first-password" } });
    let r = await s.admin.call("POST", "/api/password", { json: { current: "wrong-wrong", next: "second-password" } });
    assert.equal(r.status, 401);
    r = await s.admin.call("POST", "/api/password", { json: { current: "first-password", next: "second-password" } });
    assert.equal(r.status, 200);
    assert.equal((await s.admin.call("GET", "/api/status")).status, 200);
    assert.equal((await laptop.call("GET", "/api/status")).status, 401);
  });

  test("new passwords use the full PBKDF2 count unless told otherwise", async () => {
    const stores = memory();
    const s = site(stores, { iterations: undefined });
    await s.browser().call("POST", "/api/setup", { json: { code: CODE, username: "ethan", password: "first-password" } });
    const accounts = await stores.authStore.get("accounts", { type: "json" });
    assert.equal(accounts.users.ethan.iterations, PASSWORD_ITERATIONS);
    assert.equal(accounts.users.ethan.password, undefined, "no plain password is stored");
    assert.ok(!JSON.stringify(accounts).includes("first-password"));
  });
});

describe("sign-in safety", () => {
  test("ten wrong passwords lock that username for fifteen minutes", async () => {
    const s = await withAdmin(memory());
    const b = s.browser();
    for (let i = 0; i < LOCK.userTries; i++) {
      assert.equal((await b.call("POST", "/api/login", { json: { username: "ethan", password: "guess-" + i } })).status, 401);
    }
    let r = await b.call("POST", "/api/login", { json: { username: "ethan", password: "first-password" } });
    assert.equal(r.status, 429, "even the right password waits");
    assert.match(r.data.error, /15 minutes/);
    s.clock.t += LOCK.lockMs + 1000;
    r = await b.call("POST", "/api/login", { json: { username: "ethan", password: "first-password" } });
    assert.equal(r.status, 200);
  });

  test("one connection guessing at many usernames is locked too", async () => {
    const s = await withAdmin(memory());
    const b = s.browser("192.0.2.9");
    for (let i = 0; i < LOCK.ipFails; i++) await b.call("POST", "/api/login", { json: { username: "user" + i, password: "guess-guess" } });
    const r = await b.call("POST", "/api/login", { json: { username: "ethan", password: "first-password" } });
    assert.equal(r.status, 429);
    const elsewhere = s.browser("192.0.2.10");
    assert.equal((await elsewhere.call("POST", "/api/login", { json: { username: "ethan", password: "first-password" } })).status, 200);
  });

  test("a session lasts the working day, then ends", async () => {
    const s = await withAdmin(memory());
    s.clock.t += (SESSION_HOURS - 1) * 3600000;
    assert.equal((await s.admin.call("GET", "/api/status")).status, 200);
    s.clock.t += 2 * 3600000;
    assert.equal((await s.admin.call("GET", "/api/status")).status, 401);
  });

  test("a cookie that has been edited is worthless", async () => {
    const s = await withAdmin(memory());
    const [payload, mac] = s.admin.jar.cookie.split("=")[1].split(".");
    const forged = Buffer.from(JSON.stringify({ u: "ethan", e: 1, x: s.clock.t + 99 * 3600000 })).toString("base64url");
    s.admin.jar.cookie = "mt_session=" + forged + "." + mac;
    assert.equal((await s.admin.call("GET", "/api/status")).status, 401);
    s.admin.jar.cookie = "mt_session=" + payload + "." + mac.slice(0, -2) + "AA";
    assert.equal((await s.admin.call("GET", "/api/status")).status, 401);
  });

  test("changes must come from the page itself", async () => {
    const s = await withAdmin(memory());
    let r = await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "x" } } }, csrf: false });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /calculator page/);
    r = await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "x" } } }, origin: "https://evil.example" });
    assert.equal(r.status, 400);
    r = await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "x" } } }, origin: "https://makeup.example" });
    assert.equal(r.status, 200);
  });

  test("refusals are never 403 or 404, which a CDN can swap for a static page", async () => {
    const s = await withAdmin(memory());
    const maria = await addUser(s.admin, s, "maria");
    const statuses = [
      (await maria.call("GET", "/api/users")).status,
      (await maria.call("PATCH", "/api/answers", { json: {}, csrf: false })).status,
      (await maria.call("GET", "/api/exports/roster")).status,
      (await s.admin.call("DELETE", "/api/users/ghost")).status,
      (await s.browser().call("POST", "/api/setup", { json: { code: "x", username: "aa", password: "bbbbbbbb" } })).status,
    ];
    assert.ok(statuses.every((n) => n !== 403 && n !== 404), JSON.stringify(statuses));
  });

  test("nothing but the session check is open without signing in", async () => {
    const s = await withAdmin(memory());
    const stranger = s.browser();
    for (const [method, path] of [["GET", "/api/status"], ["GET", "/api/answers"], ["GET", "/api/exports"], ["GET", "/api/exports/roster"], ["GET", "/api/users"]]) {
      assert.equal((await stranger.call(method, path)).status, 401, method + " " + path);
    }
    assert.equal((await stranger.call("GET", "/api/nothing-here")).status, 404);
    assert.equal((await stranger.call("PUT", "/api/session")).status, 405);
  });

  test("setup is off without a SETUP_CODE", async () => {
    const s = site(memory(), { env: {} });
    const b = s.browser();
    assert.equal((await b.call("GET", "/api/session")).data.setupAllowed, false);
    const r = await b.call("POST", "/api/setup", { json: { code: "", username: "ethan", password: "first-password" } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /SETUP_CODE/);
  });
});

describe("shared answers", () => {
  for (const existing of [false, true]) {
    test("two saves landing at the same instant both survive (" + (existing ? "answers already saved" : "first answers") + ")", async () => {
      const stores = memory();
      const s = await withAdmin(stores);
      const maria = await addUser(s.admin, s, "maria");
      if (existing) await s.admin.call("PATCH", "/api/answers", { json: { set: { "first\u001fone": { note: "earlier" } } } });
      // Maria's save lands between the admin's read and write.
      stores.dataStore.hookKey = "answers";
      stores.dataStore.beforeWrite = async () => {
        const r = await maria.call("PATCH", "/api/answers", { json: { set: { "sample\u001fpupil": { weekdays: [1] } } } });
        assert.equal(r.status, 200);
      };
      const r = await s.admin.call("PATCH", "/api/answers", { json: { set: { "test\u001fstudent": { weekdays: [3] } } } });
      assert.equal(r.status, 200);
      const want = ["sample\u001fpupil", "test\u001fstudent", ...(existing ? ["first\u001fone"] : [])].sort();
      assert.deepEqual(Object.keys(r.data.answers.students).sort(), want);
      const stored = await stores.dataStore.get("answers", { type: "json" });
      assert.deepEqual(Object.keys(stored.students).sort(), want);
    });
  }

  test("two account changes landing at the same instant both survive", async () => {
    const stores = memory();
    const s = await withAdmin(stores);
    stores.authStore.hookKey = "accounts";
    stores.authStore.beforeWrite = async () => {
      const r = await s.admin.call("POST", "/api/users", { json: { username: "maria", password: "temporary-1" } });
      assert.equal(r.status, 200);
    };
    const r = await s.admin.call("POST", "/api/users", { json: { username: "lee", password: "temporary-2" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.users.map((u) => u.name), ["ethan", "lee", "maria"]);
  });

  test("an unchanged copy is not sent again", async () => {
    const s = await withAdmin(memory());
    const first = await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "x" } } } });
    const r = await s.admin.call("GET", "/api/answers", { headers: { "if-none-match": first.data.etag } });
    assert.equal(r.status, 304);
    await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "y" } } } });
    const changed = await s.admin.call("GET", "/api/answers", { headers: { "if-none-match": first.data.etag } });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.answers.students["a\u001fb"].note, "y");
  });

  test("bad records are refused", async () => {
    const s = await withAdmin(memory());
    for (const patch of [
      { set: { __proto__: null, ["__proto__"]: { note: "x" } } },
      { set: { "a\u001fb": [1, 2] } },
      { set: { "a\u001fb": "text" } },
      { set: { "a\u001fb": { note: "x".repeat(70000) } } },
      { remove: [""] },
    ]) {
      const r = await s.admin.call("PATCH", "/api/answers", { json: patch });
      assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 80));
    }
  });
});

describe("shared exports", () => {
  test("uploads that are not compressed exports are refused", async () => {
    const s = await withAdmin(memory());
    let r = await s.admin.call("PUT", "/api/exports/attendance", { raw: Buffer.from("not gzip") });
    assert.equal(r.status, 400);
    r = await s.admin.call("PUT", "/api/exports/attendance", { raw: gzipSync(Buffer.from("[1,2,3]")) });
    assert.equal(r.status, 400);
    r = await s.admin.call("PUT", "/api/exports/attendance", {
      raw: attendanceUpload({ records: [{ "First Name": "Test", "Address": "1 Main St" }] }),
    });
    assert.equal(r.status, 400, "a value outside the declared columns is refused");
    r = await s.admin.call("PUT", "/api/exports/other", { raw: attendanceUpload() });
    assert.equal(r.status, 404);
  });

  test("a roster with only the used columns is accepted", async () => {
    const s = await withAdmin(memory());
    const roster = gzipSync(Buffer.from(JSON.stringify({
      fileName: "Students Export 10_26_2026.xlsx",
      headers: ["First Name", "Last Name", "Student Id", "Enrollment Status", "Enrollment Start Date", "Enrollment End Date", "Last Attendance Date"],
      records: [{ "First Name": "Test", "Last Name": "Student", "Student Id": "1", "Enrollment Status": "Enrolled",
                  "Enrollment Start Date": "46000", "Enrollment End Date": "", "Last Attendance Date": "46230" }],
    })));
    const r = await s.admin.call("PUT", "/api/exports/roster", { raw: roster });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.exports.roster.rows, 1);
  });
});

describe("after review", () => {
  test("thirty guesses at once still meet the ten-try limit", async () => {
    const s = await withAdmin(memory());
    const guesses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      s.browser("10.9.0." + i).call("POST", "/api/login", { json: { username: "ethan", password: "guess-" + i } })));
    const tried = guesses.filter((r) => r.status === 401).length;
    assert.ok(tried <= LOCK.userTries, "only " + LOCK.userTries + " may be checked, " + tried + " were");
    assert.ok(guesses.every((r) => r.status === 401 || r.status === 429));
    const right = await s.browser("10.9.1.1").call("POST", "/api/login", { json: { username: "ethan", password: "first-password" } });
    assert.equal(right.status, 429);
  });

  test("an account removed and added again does not bring back old sign-ins", async () => {
    const s = await withAdmin(memory());
    const maria = await addUser(s.admin, s, "maria");
    const oldCookie = maria.jar.cookie;
    await s.admin.call("DELETE", "/api/users/maria");
    await addUser(s.admin, s, "maria");
    maria.jar.cookie = oldCookie;
    assert.equal((await maria.call("GET", "/api/status")).status, 401);
  });

  test("answer records are stored in the page's shape only", async () => {
    const s = await withAdmin(memory());
    const r = await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": {
      planHours: { "2026-08": "<img src=x onerror=alert(1)>", "2026-09": 8 }, sessionHours: "<b>", weekdays: [1, "2", 9],
      holds: [{ start: "<script>", until: null }, { start: "2026-09", until: null, source: "entered" }], extra: "dropped" } } } });
    assert.equal(r.status, 200);
    const rec = r.data.answers.students["a\u001fb"];
    assert.deepEqual(rec.planHours, { "2026-09": 8 });
    assert.equal(rec.sessionHours, null);
    assert.deepEqual(rec.weekdays, [1]);
    assert.deepEqual(rec.holds, [{ start: "2026-09", until: null, source: "entered" }]);
    assert.equal(rec.extra, undefined);
    assert.deepEqual(Object.keys(rec).sort(), Object.keys(cleanRecord({})).sort());
  });

  test("a stale save about the same student keeps a colleague's answer", async () => {
    const s = await withAdmin(memory());
    const maria = await addUser(s.admin, s, "maria");
    const key = "test\u001fstudent";
    await maria.call("PATCH", "/api/answers", { json: { set: { [key]: { holds: [{ start: "2026-09", until: null, source: "entered" }], note: "away in Sept" } }, base: { [key]: null } } });
    // The admin had not heard about that yet, and skips a question about the student.
    const r = await s.admin.call("PATCH", "/api/answers", { json: { set: { [key]: { answered: ["absent:2026-09"] } }, base: { [key]: null } } });
    const rec = r.data.answers.students[key];
    assert.deepEqual(rec.holds.map((h) => h.start), ["2026-09"]);
    assert.equal(rec.note, "away in Sept");
    assert.deepEqual(rec.answered, ["absent:2026-09"]);
  });

  test("hour corrections from two people add up, and a stale clear keeps the newer hold", async () => {
    const s = await withAdmin(memory());
    const maria = await addUser(s.admin, s, "maria");
    const key = "test\u001fstudent";
    const base = cleanRecord({ hourAdjust: { "2026-08": -1 } });
    await s.admin.call("PATCH", "/api/answers", { json: { set: { [key]: base } } });
    await maria.call("PATCH", "/api/answers", { json: { set: { [key]: { hourAdjust: { "2026-08": -2 } } }, base: { [key]: base } } });
    let r = await s.admin.call("PATCH", "/api/answers", { json: { set: { [key]: { hourAdjust: { "2026-08": -2 } } }, base: { [key]: base } } });
    assert.equal(r.data.answers.students[key].hourAdjust["2026-08"], -3);

    const other = "sample\u001fpupil";
    await maria.call("PATCH", "/api/answers", { json: { set: { [other]: { holds: [{ start: "2026-10", until: null }] } }, base: { [other]: null } } });
    r = await s.admin.call("PATCH", "/api/answers", { json: { remove: [other], base: { [other]: null } } });
    assert.deepEqual(r.data.answers.students[other].holds, [{ start: "2026-10", until: null }]);
  });

  test("only an admin clears many students at once, and a copy is kept first", async () => {
    const stores = memory();
    const s = await withAdmin(stores);
    const maria = await addUser(s.admin, s, "maria");
    const set = {};
    for (let i = 0; i < 8; i++) set["kid\u001f" + i] = { note: "n" + i };
    await s.admin.call("PATCH", "/api/answers", { json: { set } });
    const keys = Object.keys(set);
    let r = await maria.call("PATCH", "/api/answers", { json: { remove: keys } });
    assert.equal(r.status, 400);
    assert.equal((await maria.call("PATCH", "/api/answers", { json: { remove: keys.slice(0, STAFF_REMOVE_LIMIT) } })).status, 200);
    r = await s.admin.call("PATCH", "/api/answers", { json: { remove: keys } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.answers.students, {});
    const list = await s.admin.call("GET", "/api/backups");
    assert.equal(list.status, 200);
    const clear = list.data.backups.find((b) => b.reason === "clear");
    assert.ok(clear, JSON.stringify(list.data));
    assert.equal(clear.students, 8 - STAFF_REMOVE_LIMIT);
    const copy = await s.admin.call("GET", "/api/backups/" + clear.name);
    assert.equal(Object.keys(copy.data.students).length, 8 - STAFF_REMOVE_LIMIT);
    assert.equal((await maria.call("GET", "/api/backups")).status, 400, "backups are for admins");
  });

  test("the first save of the day keeps a copy of the answers before it", async () => {
    const stores = memory();
    const s = await withAdmin(stores);
    await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "day one" } } } });
    const signIn = () => s.admin.call("POST", "/api/login", { json: { username: "ethan", password: "first-password" } });
    s.clock.t += 24 * 3600000;
    await signIn();
    await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "day two" } } } });
    const list = (await s.admin.call("GET", "/api/backups")).data.backups;
    assert.equal(list.length, 1, "nothing to copy before the very first save; one copy the next day: " + JSON.stringify(list));
    const copy = await s.admin.call("GET", "/api/backups/" + list[0].name);
    assert.equal(copy.data.students["a\u001fb"].note, "day one");
    s.clock.t += 40 * 24 * 3600000;
    await signIn();
    await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "much later" } } } });
    const later = (await s.admin.call("GET", "/api/backups")).data.backups;
    assert.deepEqual(later.map((b) => b.name === list[0].name), [false], "copies older than 30 days are dropped");
  });

  test("two admins removing each other at once leave one admin", async () => {
    const stores = memory();
    const s = await withAdmin(stores);
    const lee = await addUser(s.admin, s, "lee", "temporary-1", true);
    stores.authStore.hookKey = "accounts";
    stores.authStore.beforeWrite = async () => {
      const r = await lee.call("DELETE", "/api/users/ethan");
      assert.equal(r.status, 200);
    };
    const r = await s.admin.call("DELETE", "/api/users/lee");
    assert.equal(r.status, 400, "ethan was removed first, so ethan's removal of lee is refused");
    const accounts = await stores.authStore.get("accounts", { type: "json" });
    assert.deepEqual(Object.keys(accounts.users), ["lee"]);
  });

  test("a store that reports a conditional save without an ETag is treated as a failure", async () => {
    const stores = memory();
    const s = await withAdmin(stores);
    await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "x" } } } });
    stores.dataStore.failConditional = true;
    const r = await s.admin.call("PATCH", "/api/answers", { json: { set: { "a\u001fb": { note: "y" } } } });
    assert.equal(r.status, 500);
  });
});
