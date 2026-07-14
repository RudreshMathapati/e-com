import express from "express";
import crypto from "crypto";
import { blacklistSession, blacklistUser } from "../utils/sentinelBlacklist.js";

const router = express.Router();

/**
 * POST /webhooks/sentinel
 *
 * Async, out-of-band threat alerts from the Sentinel dashboard — this is
 * what gives us defense in depth beyond the synchronous /evaluate call in
 * the proxy routes. Two event types now fire here:
 *
 *  - "alert.created": automatic detection (Sentinel's own scoring flagged
 *    this session). Carries the real session_id — the exact same value we
 *    sent on /evaluate — so we blacklist that one session.
 *
 *  - "session.terminated_by_operator": someone on the security team clicked
 *    "Kill" on a session in the Sentinel dashboard (Live Sessions or an
 *    alert's detail page). Sentinel cannot end the real session itself —
 *    this is how it tells us so we can react without waiting for that
 *    session's next /evaluate call. Critically, this event does NOT carry
 *    session_id: Sentinel only ever stores a one-way hash of the token it
 *    was given, so the original value isn't recoverable here. We blacklist
 *    by user_id instead — every active session for that user/admin is
 *    treated as terminated, not just the one that was killed.
 *
 * Either way, if delivery fails, the app still finds out on that session's
 * next /evaluate call — a session Sentinel has already marked terminated
 * short-circuits to a CRITICAL/TERMINATE_SESSION response regardless.
 *
 * Sentinel signs `JSON.stringify(req.body)` with HMAC-SHA256 using
 * SENTINEL_WEBHOOK_SECRET (configured to match in the Sentinel dashboard's
 * webhook settings). This route re-derives that signature over the
 * already-parsed body (express.json() ran globally in server.js/api/index.js)
 * and rejects anything that doesn't match byte-for-byte.
 */
router.post("/", async (req, res) => {
  try {
    const signatureHeader = req.headers["x-sentinel-signature"];
    if (!signatureHeader) return res.status(401).send("Signature missing");

    const secret = process.env.SENTINEL_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[Sentinel Webhook] SENTINEL_WEBHOOK_SECRET is not set — rejecting");
      return res.status(500).send("Webhook not configured");
    }

    const payloadStr = JSON.stringify(req.body);
    const expectedSignature =
      "sha256=" + crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");

    const provided = Buffer.from(signatureHeader);
    const expected = Buffer.from(expectedSignature);
    const valid =
      provided.length === expected.length && crypto.timingSafeEqual(provided, expected);

    if (!valid) {
      return res.status(403).send("Signature verification failed");
    }

    const { event, session_id, risk_level, recommended_action, user_id } = req.body || {};

    if (event === "alert.created" && (recommended_action === "TERMINATE_SESSION" || risk_level === "CRITICAL")) {
      if (session_id) {
        await blacklistSession(session_id, recommended_action || risk_level);
      }
    } else if (event === "session.terminated_by_operator") {
      if (user_id) {
        await blacklistUser(user_id, event);
      }
    }

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("[Sentinel Webhook] error:", err.message);
    return res.status(500).send("Internal server error");
  }
});

export default router;
