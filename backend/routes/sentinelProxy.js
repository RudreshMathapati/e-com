import express from "express";
import authUser from "../middleware/auth.js";

const router = express.Router();

const SENTINEL_URL = process.env.SENTINEL_API_URL;
const SENTINEL_KEY = process.env.SENTINEL_API_KEY;

/**
 * Fail-open response — returned whenever Sentinel is unreachable,
 * times out, or returns a non-200. Sentinel being down must never
 * block legitimate users.
 */
const FAIL_OPEN = {
  risk: { score: 0, level: "LOW" },
  recommended_action: "ALLOW",
  degraded: true,
};

/**
 * POST /api/sentinel-proxy
 *
 * Three rules this proxy always enforces (per Sentinel integration guide):
 *  1. Sits behind authUser — anonymous requests are rejected outright.
 *  2. user_id and session_id are derived from the SERVER-verified JWT,
 *     never from req.body (the browser can lie about that).
 *  3. Fail open — any error resolves to ALLOW so Sentinel outages
 *     cannot take the app down.
 */
router.post("/sentinel-proxy", authUser, async (req, res) => {
  // authUser middleware already verified the JWT and set req.body.userId
  const userId = req.body.userId;

  // Use the JWT token string itself as sessionId — it is unique per login
  // and has been cryptographically verified by authUser above.
  const sessionId = req.headers.token || null;

  if (!userId) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  // Validate env vars — fail open with a helpful warning if missing
  if (!SENTINEL_URL || !SENTINEL_KEY) {
    console.warn(
      "[Sentinel Proxy] SENTINEL_API_URL or SENTINEL_API_KEY is not set in .env — failing open"
    );
    return res.json(FAIL_OPEN);
  }

  // Take the SDK payload and OVERWRITE the identity fields with server-authoritative values
  const { userId: _ignored, ...sdkPayload } = req.body;
  const forwarded = {
    ...sdkPayload,
    user_id: String(userId),
    session_id: sessionId,
  };

  // 3-second timeout — Sentinel must never block the user for long
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const upstream = await fetch(SENTINEL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentinel-Key": SENTINEL_KEY,
      },
      body: JSON.stringify(forwarded),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      console.warn(
        `[Sentinel Proxy] upstream returned ${upstream.status} — failing open`
      );
      return res.json(FAIL_OPEN);
    }

    const body = await upstream.json().catch(() => null);
    return res.json(body && typeof body === "object" ? body : FAIL_OPEN);
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("[Sentinel Proxy] request timed out (3s) — failing open");
    } else {
      console.error("[Sentinel Proxy] error:", err.message);
    }
    return res.json(FAIL_OPEN);
  } finally {
    clearTimeout(timer);
  }
});

export default router;
