const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// PUT (not POST) because a Review is unique per (user, studio) — edit-in-place,
// never a new row, per the data model spec.
router.put("/studios/:studioId", requireAuth, async (req, res) => {
  const { rating, text } = req.body || {};
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "rating must be 1-5." });

  const review = await prisma.review.upsert({
    where: { studioId_userId: { studioId: req.params.studioId, userId: req.user.id } },
    update: { rating, text },
    create: { studioId: req.params.studioId, userId: req.user.id, rating, text },
  });

  await recomputeAvgRating(req.params.studioId);
  res.json(review);
});

async function recomputeAvgRating(studioId) {
  const agg = await prisma.review.aggregate({ where: { studioId }, _avg: { rating: true } });
  await prisma.studio.update({ where: { id: studioId }, data: { avgRating: agg._avg.rating || 0 } });
}

module.exports = router;
