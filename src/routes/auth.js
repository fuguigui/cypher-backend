const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// POST /auth/register — email/password signup. New accounts are always role
// "submitter"; promoting to "admin" is a manual DB action, never self-service.
router.post("/register", async (req, res) => {
  const { name, email, password, city } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, and password are required." });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "An account with that email already exists." });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, city: city || null, role: "submitter" },
  });

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required." });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) return res.status(401).json({ error: "Invalid email or password." });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password." });

  res.json({ token: signToken(user), user: publicUser(user) });
});

// GET /auth/me — resolve the current session; used by the frontend on load
// to populate the profile chip and gate the Admin nav entry.
router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json(publicUser(user));
});

// PATCH /auth/me — update profile fields a user can self-serve (name, city).
// Role changes are deliberately not accepted here.
router.patch("/me", requireAuth, async (req, res) => {
  const { name, city } = req.body || {};
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(city !== undefined ? { city } : {}),
    },
  });
  res.json(publicUser(user));
});

module.exports = router;
