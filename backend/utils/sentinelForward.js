/**
 * Shared upstream-forwarding logic for both the user and admin Sentinel
 * proxy routes (backend/routes/sentinelProxy.js, adminSentinelProxy.js).
 * Fail-open and shadow-mode behavior lives here once instead of being
 * duplicated across the two routes.
 */
const SENTINEL_URL = process.env.SENTINEL_API_URL;
const SENTINEL_KEY = process.env.SENTINEL_API_KEY;
const SHADOW_MODE = process.env.SENTINEL_SHADOW_MODE === "true";
const TIMEOUT_MS = 3000;

/**
 * Returned whenever Sentinel is unreachable, times out, or returns a
 * non-200. Sentinel being down must never block legitimate users.
 */
export const FAIL_OPEN = {
  risk: { score: 0, level: "LOW" },
  recommended_action: "ALLOW",
  degraded: true,
};

/**
 * Forwards an already-identity-verified payload to the Sentinel /evaluate
 * endpoint. Never throws — every failure path resolves to FAIL_OPEN.
 *
 * When SENTINEL_SHADOW_MODE=true, Sentinel still receives and scores every
 * event (so baselines/alerts keep building), but a non-ALLOW verdict is
 * downgraded to ALLOW before it reaches the client — the real verdict is
 * preserved as `shadow_verdict` for observability. Flip to enforcement by
 * setting SENTINEL_SHADOW_MODE=false once baselines are trustworthy (see
 * Sentinel_Integration_Guide.md, "Go Live Safely").
 */
export async function forwardToSentinel(payload) {
  if (!SENTINEL_URL || !SENTINEL_KEY) {
    console.warn("[Sentinel Proxy] SENTINEL_API_URL or SENTINEL_API_KEY not set — failing open");
    return FAIL_OPEN;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(SENTINEL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentinel-Key": SENTINEL_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      console.warn(`[Sentinel Proxy] upstream returned ${upstream.status} — failing open`);
      return FAIL_OPEN;
    }

    const body = await upstream.json().catch(() => null);
    const result = body && typeof body === "object" ? body : FAIL_OPEN;

    if (SHADOW_MODE && result.recommended_action && result.recommended_action !== "ALLOW") {
      return { ...result, recommended_action: "ALLOW", shadow_verdict: result.recommended_action };
    }

    return result;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("[Sentinel Proxy] request timed out (3s) — failing open");
    } else {
      console.error("[Sentinel Proxy] error:", err.message);
    }
    return FAIL_OPEN;
  } finally {
    clearTimeout(timer);
  }
}
