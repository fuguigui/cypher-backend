require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { attachUser } = require("./middleware/auth");

const authRoutes = require("./routes/auth");
const studioRoutes = require("./routes/studios");
const locationRoutes = require("./routes/locations");
const teacherRoutes = require("./routes/teachers");
const classRoutes = require("./routes/classes");
const songRoutes = require("./routes/songs");
const reviewRoutes = require("./routes/reviews");
const videoRoutes = require("./routes/videos");
const followRoutes = require("./routes/follows");
const likeRoutes = require("./routes/likes");
const studioListRoutes = require("./routes/studioLists");
const adminRoutes = require("./routes/admin");

const app = express();

app.use(cors());
app.use(express.json());
app.use(attachUser); // populates req.user from the Bearer token when present, on every request

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/studios", studioRoutes);
app.use("/locations", locationRoutes);
app.use("/teachers", teacherRoutes);
app.use("/classes", classRoutes);
app.use("/songs", songRoutes);
app.use("/reviews", reviewRoutes);
app.use("/videos", videoRoutes);
app.use("/follows", followRoutes);
app.use("/likes", likeRoutes);
app.use("/studio-lists", studioListRoutes);
app.use("/admin", adminRoutes);

// Centralized error handler — routes can just `throw` or reject and land here
// instead of every handler needing its own try/catch boilerplate.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error." });
});

// Only auto-listen when this file is run directly (`node src/app.js` /
// `npm run dev`) — not when it's `require`d, so tests can import the app,
// bind it to their own port, and close it cleanly afterwards.
if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`Cypher API listening on :${port}`));
}

module.exports = app;
