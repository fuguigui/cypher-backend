const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", async (req, res) => {
  const teachers = await prisma.teacher.findMany({
    where: { status: "approved" },
    orderBy: { name: "asc" },
  });
  res.json(teachers);
});

router.get("/:id", async (req, res) => {
  const teacher = await prisma.teacher.findUnique({
    where: { id: req.params.id },
    include: { studios: { include: { studio: true } }, videos: { where: { status: "live" } } },
  });
  if (!teacher) return res.status(404).json({ error: "Not found." });
  res.json(teacher);
});

// POST /teachers — studioIds is optional; a teacher can be linked to
// multiple studios via the StudioTeacher join table.
router.post("/", requireAuth, async (req, res) => {
  const { name, bio, photoUrl, instagramLink, instagramFollowers, studioIds = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required." });

  const teacher = await prisma.teacher.create({
    data: {
      name, bio, photoUrl, instagramLink, instagramFollowers,
      status: "pending",
      submittedById: req.user.id,
      studios: { create: studioIds.map((studioId) => ({ studio: { connect: { id: studioId } } })) },
    },
  });
  res.status(201).json(teacher);
});

module.exports = router;
