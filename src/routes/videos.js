const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB cap from the product decision

// POST /videos — unlike every other entity, Videos publish immediately
// (status "live", no pending queue). Admins moderate after the fact via
// POST /videos/:id/block below.
router.post("/", requireAuth, async (req, res) => {
  const { source, url, thumbnailUrl, caption, studioId, teacherId, classId, songId, fileSizeBytes } = req.body || {};

  if (!source || !url) return res.status(400).json({ error: "source and url are required." });
  if (!studioId && !teacherId && !classId) {
    return res.status(400).json({ error: "At least one of studioId, teacherId, or classId must be set." });
  }
  if (source === "user_upload" && fileSizeBytes > MAX_UPLOAD_BYTES) {
    // In production this check (and the compress-then-recheck step) happens
    // in the upload/ingest pipeline before this endpoint is ever called with
    // a final URL — this is the last-line guard.
    return res.status(413).json({ error: "File exceeds 50 MiB even after compression. Please trim or re-export." });
  }

  const video = await prisma.video.create({
    data: {
      source, url, thumbnailUrl, caption, studioId, teacherId, classId, songId,
      status: "live",
      submittedById: req.user.id,
    },
  });
  res.status(201).json(video);
});

// POST /videos/:id/block — admin-only. Requires a reason, which is what the
// uploader sees on My Submissions.
router.post("/:id/block", requireAdmin, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: "A block reason is required." });

  const video = await prisma.video.update({
    where: { id: req.params.id },
    data: { status: "blocked", blockReason: reason },
  });
  res.json(video);
});

// POST /videos/:id/resubmit — uploader edits and goes straight back to live,
// per spec (no re-entering a pending queue).
router.post("/:id/resubmit", requireAuth, async (req, res) => {
  const existing = await prisma.video.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found." });
  if (existing.submittedById !== req.user.id) return res.status(403).json({ error: "Not your video." });

  const { url, thumbnailUrl, caption, studioId, teacherId, classId, songId } = req.body || {};
  const video = await prisma.video.update({
    where: { id: req.params.id },
    data: {
      ...(url !== undefined ? { url } : {}),
      ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
      ...(caption !== undefined ? { caption } : {}),
      ...(studioId !== undefined ? { studioId } : {}),
      ...(teacherId !== undefined ? { teacherId } : {}),
      ...(classId !== undefined ? { classId } : {}),
      ...(songId !== undefined ? { songId } : {}),
      status: "live",
      blockReason: null,
    },
  });
  res.json(video);
});

module.exports = router;
