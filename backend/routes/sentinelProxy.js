import express from "express";
import authUser from "../middleware/auth.js";
import { forwardToSentinel } from "../utils/sentinelForward.js";

const router = express.Router();

/**
 * POST /api/sentinel-proxy
 *
 * Three rules this proxy always enforces (per Sentinel integration guide):
 *  1. Sits behind authUser — anonymous requests are rejected outright, and
 *     an already-blacklisted session is rejected before it gets here.
 *  2. user_id and session_id are derived from the SERVER-verified JWT
 *     (authUser sets req.sentinelSessionId), never from req.body — the
 *     browser can lie about that.
 *  3. Fail open — forwardToSentinel() resolves to ALLOW on any upstream
 *     error so a Sentinel outage cannot take the app down.
 */
router.post("/sentinel-proxy", authUser, async (req, res) => {
  const userId = req.body.userId;
  const sessionId = req.sentinelSessionId;

  if (!userId) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  // Take the SDK payload and OVERWRITE the identity fields with server-authoritative values
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
