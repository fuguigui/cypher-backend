/**
 * In-memory stand-in for a handful of Prisma Client model methods, used ONLY
 * for the smoke test in test/smoke.test.js. It exists because this sandbox's
 * network policy blocks binaries.prisma.sh, so the real `prisma generate`
 * step (which downloads the query engine binary) can't complete here — see
 * README "What's stubbed vs. real". This file is not wired into production;
 * it's activated only when MOCK_DB=1, purely so route logic (auth, status
 * codes, moderation transitions, admin gating) can be exercised end-to-end
 * without a real database. Swap MOCK_DB off and run `npx prisma generate`
 * against a real DATABASE_URL to use the real thing.
 */
let nextId = 1;
const uid = (prefix) => `${prefix}_${nextId++}`;

const db = { users: [], studios: [] };

function clone(x) { return x ? JSON.parse(JSON.stringify(x)) : x; }

const user = {
  async findUnique({ where }) {
    if (where.id) return clone(db.users.find((u) => u.id === where.id)) || null;
    if (where.email) return clone(db.users.find((u) => u.email === where.email)) || null;
    return null;
  },
  async create({ data }) {
    const row = { id: uid("user"), role: "submitter", createdAt: new Date(), ...data };
    db.users.push(row);
    return clone(row);
  },
  async update({ where, data }) {
    const row = db.users.find((u) => u.id === where.id);
    if (!row) throw new Error("User not found");
    Object.assign(row, data);
    return clone(row);
  },
};

const studio = {
  async findMany({ where = {} } = {}) {
    return db.studios
      .filter((s) => (where.status ? s.status === where.status : true))
      .filter((s) => (where.submittedById ? s.submittedById === where.submittedById : true))
      .map((s) => ({ ...clone(s), locations: [] }));
  },
  async findUnique({ where }) {
    const row = db.studios.find((s) => s.id === where.id);
    return row ? { ...clone(row), locations: [], teachers: [], reviews: [], videos: [] } : null;
  },
  async create({ data }) {
    const row = { id: uid("studio"), status: "pending", createdAt: new Date(), ...data };
    db.studios.push(row);
    return clone(row);
  },
  async update({ where, data }) {
    const row = db.studios.find((s) => s.id === where.id);
    if (!row) throw new Error("Studio not found");
    Object.assign(row, data);
    return clone(row);
  },
};

module.exports = { user, studio, _db: db };
