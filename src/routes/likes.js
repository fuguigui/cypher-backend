const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// POST /likes { studioId } | { teacherId } | { classId } — same toggle
// pattern as follows, but Like is a separate concept (powers like counts /
// "popular" sorting) rather than the feed/notification semantics of Follow.
router.post("/", requireAuth, async (req, res) => {
  const { studioId, teacherId, classId } = req.body || {};
  if (!studioId && !teacherId && !classId) {
    return res.status(400).json({ error: "studioId, teacherId, or classId is required." });
  }

  const where = studioId
    ? { userId_studioId: { userId: req.user.id, studioId } }
    : teacherId
    ? { userId_teacherId: { userId: req.user.id, teacherId } }
    : { userId_classId: { userId: req.user.id, classId } };

  const existing = await prisma.like.findUnique({ where }).catch(() => null);
  if (existing) {
    await prisma.like.delete({ where: { id: existing.id } });
    return res.json({ liked: false });
  }

  await prisma.like.create({ data: { userId: req.user.id, studioId, teacherId, classId } });
  res.json({ liked: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const likes = await prisma.like.findMany({
    where: { userId: req.user.id },
    include: { studio: true, teacher: true, class: true },
  });
  res.json({
    studios: likes.filter((l) => l.studioId).map((l) => l.studio),
    teachers: likes.filter((l) => l.teacherId).map((l) => l.teacher),
    classes: likes.filter((l) => l.classId).map((l) => l.class),
  });
});

module.exports = router;
