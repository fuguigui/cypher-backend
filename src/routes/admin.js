const express = require("express");
const prisma = require("../lib/prisma");
const { requireAdmin } = require("../middleware/auth");
const { runScrape } = require("../scripts/runScrape");

const router = express.Router();

// Every route in this file requires role "admin" (see middleware/auth.js).
// The frontend hiding the Admin nav link for regular users is a UX nicety —
// this middleware is the actual access boundary.
router.use(requireAdmin);

// GET /admin/queue — everything pending across Studio, Location, Teacher,
// Class, newest first. Videos are excluded on purpose: they publish
// immediately and are moderated separately via /admin/videos below.
router.get("/queue", async (req, res) => {
  const [studios, locations, teachers, classes] = await Promise.all([
    prisma.studio.findMany({ where: { status: "pending" }, include: { submittedBy: true }, orderBy: { createdAt: "desc" } }),
    prisma.location.findMany({ where: { status: "pending" }, include: { submittedBy: true, studio: true }, orderBy: { createdAt: "desc" } }),
    prisma.teacher.findMany({ where: { status: "pending" }, include: { submittedBy: true }, orderBy: { createdAt: "desc" } }),
    prisma.class.findMany({ where: { status: "pending" }, include: { submittedBy: true, studio: true }, orderBy: { createdAt: "desc" } }),
  ]);

  const queue = [
    ...studios.map((s) => ({ type: "Studio", id: s.id, name: s.name, submitter: s.submittedBy.email, createdAt: s.createdAt })),
    ...locations.map((l) => ({ type: "Location", id: l.id, name: `${l.label || l.address} — ${l.studio.name}`, submitter: l.submittedBy.email, createdAt: l.createdAt })),
    ...teachers.map((t) => ({ type: "Teacher", id: t.id, name: t.name, submitter: t.submittedBy.email, createdAt: t.createdAt })),
    ...classes.map((c) => ({ type: "Class", id: c.id, name: `${c.title} — ${c.studio.name}`, submitter: c.submittedBy.email, createdAt: c.createdAt })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(queue);
});

const MODELS = { Studio: "studio", Location: "location", Teacher: "teacher", Class: "class" };

// POST /admin/:type/:id/approve
router.post("/:type/:id/approve", async (req, res) => {
  const model = MODELS[req.params.type];
  if (!model) return res.status(400).json({ error: "Unknown type." });

  const updated = await prisma[model].update({
    where: { id: req.params.id },
    data: { status: "approved", approvedAt: new Date(), approvedById: req.user.id },
  });
  res.json(updated);
});

// POST /admin/:type/:id/reject { feedback? }
router.post("/:type/:id/reject", async (req, res) => {
  const model = MODELS[req.params.type];
  if (!model) return res.status(400).json({ error: "Unknown type." });

  const updated = await prisma[model].update({
    where: { id: req.params.id },
    data: { status: "rejected" },
  });
  // A dedicated moderation_notes table would be the cleaner home for
  // req.body.feedback long-term; omitted here to keep the schema lean for v1.
  res.json(updated);
});

// GET /admin/videos — live videos, for the post-hoc block workflow (see
// routes/videos.js for the actual block/resubmit endpoints).
router.get("/videos", async (req, res) => {
  const videos = await prisma.video.findMany({
    where: { status: "live" },
    include: { submittedBy: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(videos);
});

// POST /admin/scrape/run — trigger the daily schedule scraper on demand
// (the real trigger is the Railway cron service, see DEPLOYMENT-NOTES.md;
// this is for testing a studio's scheduleUrl without waiting for it).
router.post("/scrape/run", async (req, res, next) => {
  try {
    const summary = await runScrape();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// GET /admin/studios — every studio regardless of moderation status, with
// full details and last-scrape outcome, for the admin "All Studios" panel.
// (The public GET /studios only returns approved ones, or the requesting
// user's own with ?mine=1 — this is the admin-only "see everything" view.)
router.get("/studios", async (req, res) => {
  const studios = await prisma.studio.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      submittedBy: { select: { id: true, name: true, email: true } },
      locations: true,
      _count: { select: { classes: true } },
    },
  });
  res.json(studios);
});

module.exports = router;
