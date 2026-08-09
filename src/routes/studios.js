const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /studios — public list. Only approved studios by default; a submitter
// can pass ?mine=1 (with auth) to see their own pending/rejected ones too,
// matching "submitters can see their own pending submissions" from the spec.
router.get("/", async (req, res) => {
  const where = req.query.mine && req.user
    ? { submittedById: req.user.id }
    : { status: "approved" };

  const studios = await prisma.studio.findMany({
    where,
    orderBy: { name: "asc" },
    include: { locations: { where: { status: "approved" } } },
  });
  res.json(studios);
});

// GET /studios/popular?city=Los+Angeles&limit=5 — ranks approved studios with
// an approved Location in `city` by Instagram followers. Used as the default
// suggestion group for users with no follows/likes yet.
router.get("/popular", async (req, res) => {
  const { city, limit = 5 } = req.query;
  if (!city) return res.status(400).json({ error: "city query param is required." });

  const studios = await prisma.studio.findMany({
    where: { status: "approved", locations: { some: { status: "approved", city } } },
    orderBy: { instagramFollowers: "desc" },
    take: Number(limit),
  });
  res.json(studios);
});

router.get("/:id", async (req, res) => {
  const studio = await prisma.studio.findUnique({
    where: { id: req.params.id },
    include: {
      locations: true,
      teachers: { include: { teacher: true } },
      reviews: { include: { user: { select: { id: true, name: true } } } },
      videos: { where: { status: "live" } },
    },
  });
  if (!studio) return res.status(404).json({ error: "Not found." });
  res.json(studio);
});

// POST /studios — new submission. Always starts pending; only an admin
// approval flips it to approved (see routes/admin.js).
router.post("/", requireAuth, async (req, res) => {
  const { name, description, website, logoUrl, instagramLink, instagramFollowers } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required." });

  const studio = await prisma.studio.create({
    data: {
      name, description, website, logoUrl, instagramLink, instagramFollowers,
      status: "pending",
      submittedById: req.user.id,
    },
  });
  res.status(201).json(studio);
});

// PATCH /studios/:id — only the original submitter or an admin may edit.
// Per the moderation spec: an edit to an already-approved Studio by its
// submitter reverts it to pending for re-approval, but the previously
// approved fields aren't touched here (they stay live) until re-approved —
// enforced by only changing `status`, not by hiding the record.
router.patch("/:id", requireAuth, async (req, res) => {
  const studio = await prisma.studio.findUnique({ where: { id: req.params.id } });
  if (!studio) return res.status(404).json({ error: "Not found." });

  const isOwner = studio.submittedById === req.user.id;
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isAdmin) return res.status(403).json({ error: "Not allowed to edit this studio." });

  const { name, description, website, logoUrl, instagramLink, instagramFollowers } = req.body || {};
  const updated = await prisma.studio.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(website !== undefined ? { website } : {}),
      ...(logoUrl !== undefined ? { logoUrl } : {}),
      ...(instagramLink !== undefined ? { instagramLink } : {}),
      ...(instagramFollowers !== undefined ? { instagramFollowers } : {}),
      // Owner edits of an approved studio go back to pending; admin edits don't.
      ...(isOwner && !isAdmin && studio.status === "approved" ? { status: "pending" } : {}),
    },
  });
  res.json(updated);
});

module.exports = router;
