import express from "express";
import crypto from "crypto";
import { blacklist } from "../utils/sentinelBlacklist.js";

const router = express.Router();

/**
 * POST /webhooks/sentinel
 *
 * Async, out-of-band threat alerts from the Sentinel dashboard — this is
 * what gives us defense in depth beyond the synchronous /evaluate call in
 * the proxy routes. If Sentinel decides mid-session (from signals the
 * synchronous call never saw) that a session must die, it POSTs here and we
 * blacklist it so the *next* request from that session is rejected server
 * side, even if the attacker never touches the frontend's own interceptor.
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

    const { session_id, risk_level, recommended_action } = req.body || {};

    if (recommended_action === "TERMINATE_SESSION" || risk_level === "CRITICAL") {
      if (session_id) {
        await blacklist(session_id, recommended_action || risk_level);
      }
    }

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("[Sentinel Webhook] error:", err.message);
    return res.status(500).send("Internal server error");
  }
});

export default router;
