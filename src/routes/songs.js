const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// GET /songs/leaderboard?city=Los+Angeles&from=...&to=... — ranks songs by
// how many approved Classes use them, optionally scoped to a city/date range.
router.get("/leaderboard", async (req, res) => {
  const { city, from, to, limit = 20 } = req.query;

  const classWhere = {
    status: "approved",
    ...(city ? { location: { city } } : {}),
    ...(from || to ? { datetime: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
  };

  // Group by song via the join table, counting matching classes. Prisma
  // doesn't do a single-query "count distinct related rows filtered by
  // another relation" cleanly, so we pull matching classIds first, then
  // aggregate ClassSong rows against that set.
  const matchingClasses = await prisma.class.findMany({ where: classWhere, select: { id: true } });
  const classIds = matchingClasses.map((c) => c.id);

  const grouped = await prisma.classSong.groupBy({
    by: ["songId"],
    where: { classId: { in: classIds } },
    _count: { classId: true },
    orderBy: { _count: { classId: "desc" } },
    take: Number(limit),
  });

  const songs = await prisma.song.findMany({ where: { id: { in: grouped.map((g) => g.songId) } } });
  const byId = Object.fromEntries(songs.map((s) => [s.id, s]));

  res.json(grouped.map((g) => ({ ...byId[g.songId], uses: g._count.classId })));
});

module.exports = router;
