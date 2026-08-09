const jwt = require("jsonwebtoken");

/**
 * Verifies the Bearer token on the request and attaches `req.user` as
 * { id, role }. Does NOT reject unauthenticated requests by itself — routes
 * that need a logged-in user should compose this with `requireAuth`, and
 * routes that need an admin should compose it with `requireAdmin`.
 */
function attachUser(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role };
  } catch (err) {
    // Invalid/expired token — treat as anonymous rather than erroring here;
    // requireAuth will reject if the route actually needs a session.
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  next();
}

// IMPORTANT: this is the only gate that matters for the Admin surface.
// The frontend hiding the "Admin" nav link for non-admins is a UX nicety,
// not a security boundary — every admin route must call this.
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin };
