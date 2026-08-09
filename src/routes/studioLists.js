const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /studio-lists — the current user's saved studio lists (e.g. "LA Crawl"),
// selectable as a group in the studio filter.
router.get("/", requireAuth, async (req, res) => {
  const lists = await prisma.studioList.findMany({ where: { ownerId: req.user.id } });
  res.json(lists);
});

router.post("/", requireAuth, async (req, res) => {
  const { name, studioIds } = req.body || {};
  if (!name || !Array.isArray(studioIds) || studioIds.length === 0) {
    return res.status(400).json({ error: "name and a non-empty studioIds array are required." });
  }
  const list = await prisma.studioList.create({ data: { name, studioIds, ownerId: req.user.id } });
  res.status(201).json(list);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const list = await prisma.studioList.findUnique({ where: { id: req.params.id } });
  if (!list || list.ownerId !== req.user.id) return res.status(404).json({ error: "Not found." });
  await prisma.studioList.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
