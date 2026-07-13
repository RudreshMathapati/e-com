import express from "express";
import jwt from "jsonwebtoken";
import { isBlacklisted } from "../utils/sentinelBlacklist.js";
import { forwardToSentinel } from "../utils/sentinelForward.js";

const router = express.Router();

/**
 * POST /api/sentinel-proxy
 *
 * Authentication strategy (two layers, first wins):
 *
 *  1. Cookie / header token (standard: same-origin dev, or if the browser
 *     stores SameSite=None correctly in production). Read by authUser in
 *     every other route.
 *
 *  2. SDK session_id fallback — sentinelIdentify(token, token) is called
 *     in Login.jsx right after login, so the SDK's POST body carries the
 *     user's JWT as session_id. We verify it with JWT_SECRET server-side,
 *     which is just as secure as the cookie: we never trust req.body.user_id
 *     directly, we re-derive it from the verified JWT.
 *
 *     This removes the cross-origin SameSite cookie dependency entirely —
 *     the cookie flow only works when the browser stores the cookie on a
 *     credentialed cross-origin request (requires SameSite=None + CORS
 *     credentials), which varies by browser and Render cold-start timing.
 *
 * Three rules always enforced:
 *  1. Unauthenticated requests are rejected outright (401).
 *  2. Blacklisted sessions are rejected before forwarding (403).
 *  3. user_id / session_id in the forwarded payload are ALWAYS derived from
 *     the server-verified JWT — never from the raw req.body values.
 */
router.post("/sentinel-proxy", async (req, res) => {
  let userId = null;
  let sessionId = null;

  // ── Layer 1: standard header / cookie token ───────────────────────────
  const headerToken = req.headers.token || req.cookies?.sentinel_user_token;
  if (headerToken) {
    try {
      if (await isBlacklisted(headerToken)) {
        return res.status(403).json({ success: false, sentinelVerdict: "TERMINATE_SESSION" });
      }
      const decoded = jwt.verify(headerToken, process.env.JWT_SECRET);
      userId = decoded.id;
      sessionId = headerToken;
    } catch {
      // invalid token — fall through to layer 2
    }
  }

  // ── Layer 2: SDK session_id carries the JWT (set by sentinelIdentify) ─
  // sentinelIdentify(userToken, userToken) is called in Login.jsx after
  // successful login. The SDK includes session_id in every track() payload.
  if (!userId && req.body?.session_id) {
    try {
      const decoded = jwt.verify(req.body.session_id, process.env.JWT_SECRET);
      if (decoded?.id) {
        if (await isBlacklisted(req.body.session_id)) {
          return res.status(403).json({ success: false, sentinelVerdict: "TERMINATE_SESSION" });
        }
        userId = decoded.id;
        sessionId = req.body.session_id;
      }
    } catch {
      // not a valid JWT — reject below
    }
  }

  if (!userId) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  // Overwrite identity fields with server-authoritative values
  // (remove whatever user_id the SDK sent in the body)
  const { userId: _ignored, ...sdkPayload } = req.body;
  const forwarded = {
    ...sdkPayload,
    user_id: String(userId),
    session_id: sessionId,
  };

  const result = await forwardToSentinel(forwarded);
  return res.json(result);
});

export default router;
