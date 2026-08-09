const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { detectPriceFromBookingLink } = require("../lib/priceDetect");

const router = express.Router();

// GET /classes — the core discovery-feed/calendar query. Supports every
// filter listed in the wireframe spec: style, studio, teacher, date range,
// price range, level, and city (via the joined Location).
router.get("/", async (req, res) => {
  const { style, studioId, teacherId, city, level, from, to, minPrice, maxPrice } = req.query;

  const where = {
    status: "approved",
    ...(style ? { danceStyle: style } : {}),
    ...(studioId ? { studioId } : {}),
    ...(teacherId ? { teacherId } : {}),
    ...(level ? { level } : {}),
    ...(city ? { location: { city } } : {}),
    ...(from || to ? { datetime: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    ...(minPrice || maxPrice ? { price: { ...(minPrice ? { gte: Number(minPrice) } : {}), ...(maxPrice ? { lte: Number(maxPrice) } : {}) } } : {}),
  };

  const classes = await prisma.class.findMany({
    where,
    orderBy: { datetime: "asc" },
    include: { studio: true, location: true, teacher: true },
  });
  res.json(classes);
});

// POST /classes — price is optional. If omitted, we attempt to auto-detect
// it from the booking link; if that fails too, price stays null and the
// frontend simply won't show a price rather than a misleading "$0"/"N/A".
router.post("/", requireAuth, async (req, res) => {
  const {
    studioId, locationId, teacherId, title, danceStyle,
    datetime, duration, price, currency, bookingLink, level, songIds = [],
  } = req.body || {};

  if (!studioId || !locationId || !title || !danceStyle || !datetime || !bookingLink || !level) {
    return res.status(400).json({ error: "studioId, locationId, title, danceStyle, datetime, bookingLink, and level are required." });
  }

  let finalPrice = price ?? null;
  let priceSource = price != null ? "manual" : null;

  if (finalPrice == null) {
    const detected = await detectPriceFromBookingLink(bookingLink);
    if (detected) {
      finalPrice = detected.amount;
      priceSource = "auto_detected";
    }
  }

  const cls = await prisma.class.create({
    data: {
      studioId, locationId, teacherId: teacherId || null, title, danceStyle,
      datetime: new Date(datetime), duration: duration || 60,
      price: finalPrice, currency: finalPrice != null ? (currency || "USD") : null,
      priceSource, bookingLink, level,
      status: "pending",
      submittedById: req.user.id,
      songs: { create: songIds.map((songId) => ({ song: { connect: { id: songId } } })) },
    },
  });
  res.status(201).json(cls);
});

module.exports = router;
