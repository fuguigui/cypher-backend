/**
 * End-to-end smoke test of the real Express app + route wiring, running
 * against the in-memory mock DB (see src/lib/mockPrisma.js) since this
 * sandbox can't download the Prisma query engine binary to hit a real
 * database. This still exercises real HTTP routing, JSON parsing, bcrypt
 * hashing, JWT signing/verification, and the auth/admin middleware — the
 * parts most likely to have wiring bugs. Swap to a real DATABASE_URL and
 * drop MOCK_DB to also verify actual persistence.
 *
 * Run with: MOCK_DB=1 node --test test/smoke.test.js
 */
process.env.MOCK_DB = "1";
process.env.JWT_SECRET = "test-secret";
process.env.PORT = "4099";

const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("../src/app");
const BASE = `http://localhost:${process.env.PORT}`;
let server;

test.before(() => {
  server = app.listen(process.env.PORT);
});

test.after(() => {
  server.close();
});

// Reads the body exactly once and returns it, so callers can both assert on
// the status code and use the body in a failure message without triggering
// undici's "Body has already been read" error from a double read.
async function readJson(res) {
  return res.json();
}

test("health check responds ok", async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("register -> login -> me round-trip", async () => {
  const email = `smoketest+${Date.now()}@example.com`;

  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Smoke Test", email, password: "hunter2", city: "Los Angeles" }),
  });
  const regBody = await readJson(reg);
  assert.equal(reg.status, 201, JSON.stringify(regBody));
  assert.ok(regBody.token, "register should return a session token");
  assert.equal(regBody.user.role, "submitter", "new accounts must default to submitter, never admin");

  const login = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2" }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();

  const me = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.email, email);
});

test("studio submission starts pending, is invisible on the public list, then admin approval publishes it", async () => {
  // Regular user creates a studio.
  const userEmail = `submitter+${Date.now()}@example.com`;
  const userReg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Submitter", email: userEmail, password: "hunter2" }),
  });
  const { token: userToken } = await userReg.json();

  const create = await fetch(`${BASE}/studios`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ name: "Smoke Test Studio" }),
  });
  const studio = await readJson(create);
  assert.equal(create.status, 201, JSON.stringify(studio));
  assert.equal(studio.status, "pending", "new studios must start pending, never auto-approved");

  // Public list should NOT include it yet.
  const publicList = await fetch(`${BASE}/studios`);
  const publicBody = await publicList.json();
  assert.ok(!publicBody.some((s) => s.id === studio.id), "pending studio leaked into the public (approved-only) list");

  // A non-admin cannot approve it.
  const forbidden = await fetch(`${BASE}/admin/Studio/${studio.id}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(forbidden.status, 403, "non-admin must not be able to approve — this is the actual security boundary, not just hidden UI");

  // Promote a fresh account to admin directly via the mock DB (mirrors the
  // "manual DB update" promotion path described in the README), then approve.
  const adminEmail = `admin+${Date.now()}@example.com`;
  const adminReg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Admin", email: adminEmail, password: "hunter2" }),
  });
  const { user: adminUser } = await adminReg.json();
  require("../src/lib/mockPrisma")._db.users.find((u) => u.id === adminUser.id).role = "admin";

  const adminLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: "hunter2" }),
  });
  const { token: adminToken } = await adminLogin.json();

  const approve = await fetch(`${BASE}/admin/Studio/${studio.id}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const approved = await readJson(approve);
  assert.equal(approve.status, 200, JSON.stringify(approved));
  assert.equal(approved.status, "approved");

  const publicListAfter = await fetch(`${BASE}/studios`);
  const publicBodyAfter = await publicListAfter.json();
  assert.ok(publicBodyAfter.some((s) => s.id === studio.id), "approved studio should now be publicly visible");
});
