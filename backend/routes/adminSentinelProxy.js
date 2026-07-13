import express from "express";
import adminAuth from "../middleware/adminAuth.js";
import { forwardToSentinel } from "../utils/sentinelForward.js";

const router = express.Router();

/**
 * POST /api/admin/sentinel-proxy
 *
 * Same three rules as the user proxy (backend/routes/sentinelProxy.js):
 * sits behind adminAuth (rejects anonymous + blacklisted sessions), derives
 * identity from the server-verified admin JWT rather than req.body, and
 * fails open via forwardToSentinel().
 *
 * There is no per-admin user document in this app (admin identity is a
 * single email/password pair from env vars), so user_id is a stable
 * "admin:<email>" string rather than a Mongo _id.
 */
router.post("/sentinel-proxy", adminAuth, async (req, res) => {
  const sessionId = req.sentinelSessionId;

  if (!sessionId) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  const forwarded = {
    ...req.body,
    user_id: `admin:${process.env.ADMIN_EMAIL || "unknown"}`,
    session_id: sessionId,
  };

  const result = await forwardToSentinel(forwarded);
  return res.json(result);
});

export default router;
