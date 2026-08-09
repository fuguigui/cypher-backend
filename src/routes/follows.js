const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// POST /follows { studioId } | { teacherId } — toggle: creates if absent,
// removes if already following. Keeps the frontend's "Follow"/"Following"
// button a single click either way.
router.post("/", requireAuth, async (req, res) => {
  const { studioId, teacherId } = req.body || {};
  if (!studioId && !teacherId) return res.status(400).json({ error: "studioId or teacherId is required." });

  const where = studioId
    ? { userId_studioId: { userId: req.user.id, studioId } }
    : { userId_teacherId: { userId: req.user.id, teacherId } };

  const existing = await prisma.follow.findUnique({ where }).catch(() => null);
  if (existing) {
    await prisma.follow.delete({ where: { id: existing.id } });
    return res.json({ following: false });
  }

  await prisma.follow.create({ data: { userId: req.user.id, studioId, teacherId } });
  res.json({ following: true });
});

// GET /follows/me — everything the current user follows, split by type.
// Backs the profile page's Following tabs and the map's default-center
// fallback (followed studios' locations).
router.get("/me", requireAuth, async (req, res) => {
  const follows = await prisma.follow.findMany({
    where: { userId: req.user.id },
    include: { studio: true, teacher: true },
  });
  res.json({
    studios: follows.filter((f) => f.studioId).map((f) => f.studio),
    teachers: follows.filter((f) => f.teacherId).map((f) => f.teacher),
  });
});

module.exports = router;
