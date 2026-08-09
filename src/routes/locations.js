const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { geocodeAddress } = require("../lib/geocode");
const { CITIES } = require("../lib/cities");

const router = express.Router();

// POST /locations — a Studio can have multiple Locations (branches). city
// must be one of the fixed enum values; address is geocoded server-side so
// the map always has real coordinates rather than trusting client input.
router.post("/", requireAuth, async (req, res) => {
  const { studioId, label, address, city, country } = req.body || {};
  if (!studioId || !address || !city || !country) {
    return res.status(400).json({ error: "studioId, address, city, and country are required." });
  }
  if (!CITIES.includes(city)) {
    return res.status(400).json({ error: `city must be one of the supported cities: ${CITIES.join(", ")}` });
  }

  const studio = await prisma.studio.findUnique({ where: { id: studioId } });
  if (!studio) return res.status(404).json({ error: "Studio not found." });

  const { lat, lng } = await geocodeAddress(address, city, country);

  const location = await prisma.location.create({
    data: {
      studioId, label, address, city, country, lat, lng,
      status: "pending",
      submittedById: req.user.id,
    },
  });
  res.status(201).json(location);
});

// GET /locations?city=Los+Angeles — approved locations, optionally filtered
// by city; this is what backs the map view's pins.
router.get("/", async (req, res) => {
  const { city } = req.query;
  const locations = await prisma.location.findMany({
    where: { status: "approved", ...(city ? { city } : {}) },
    include: { studio: true },
  });
  res.json(locations);
});

module.exports = router;
