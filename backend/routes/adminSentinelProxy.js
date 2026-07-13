import express from "express";
import jwt from "jsonwebtoken";
import { isBlacklisted } from "../utils/sentinelBlacklist.js";
import { forwardToSentinel, resolveRealClientIp } from "../utils/sentinelForward.js";

const router = express.Router();

/**
 * POST /api/admin/sentinel-proxy
 *
 * Same rules as the user proxy (backend/routes/sentinelProxy.js):
 * Derives identity from the server-verified admin JWT rather than req.body,
 * forwards the real admin IP (resolveRealClientIp) rather than this
 * server's own, and fails open via forwardToSentinel().
 *
 * Same two-layer auth as the user proxy (backend/routes/sentinelProxy.js):
 *
 *  1. Cookie / header token first.
 *  2. SDK session_id fallback — sentinelIdentify(adminToken, adminToken) is
 *     called in the admin panel after login, so the admin JWT lives in the
 *     SDK's session_id field. We verify it server-side with JWT_SECRET and
 *     confirm it is an admin token ({ role: 'admin' }).
 *
 * There is no per-admin user document in this app (admin identity is a
 * single email/password pair from env vars), so user_id is the stable
 * "admin:<email>" string rather than a Mongo _id.
 */
router.post("/sentinel-proxy", async (req, res) => {
  let sessionId = null;
  let isAdmin = false;

  // ── Layer 1: standard header / cookie token ───────────────────────────
  const headerToken = req.headers.token || req.cookies?.sentinel_admin_token;
  if (headerToken) {
    try {
      if (await isBlacklisted(headerToken)) {
        return res.status(403).json({ success: false, sentinelVerdict: "TERMINATE_SESSION" });
      }
      const decoded = jwt.verify(headerToken, process.env.JWT_SECRET);
      if (decoded?.role === "admin" && decoded?.email === process.env.ADMIN_EMAIL) {
        sessionId = headerToken;
        isAdmin = true;
      }
    } catch {
      // fall through to layer 2
    }
  }

  // ── Layer 2: SDK session_id carries the admin JWT ─────────────────────
  if (!isAdmin && req.body?.session_id) {
    try {
      const decoded = jwt.verify(req.body.session_id, process.env.JWT_SECRET);
      if (decoded?.role === "admin" && decoded?.email === process.env.ADMIN_EMAIL) {
        if (await isBlacklisted(req.body.session_id)) {
          return res.status(403).json({ success: false, sentinelVerdict: "TERMINATE_SESSION" });
        }
        sessionId = req.body.session_id;
        isAdmin = true;
      }
    } catch {
      // not a valid admin JWT
    }
  }

  if (!isAdmin) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  const forwarded = {
    ...req.body,
    user_id: `admin:${process.env.ADMIN_EMAIL || "unknown"}`,
    session_id: sessionId,
  };

  const result = await forwardToSentinel(forwarded, resolveRealClientIp(req));
  return res.json(result);
});

export default router;
