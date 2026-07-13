/**
 * Shared upstream-forwarding logic for both the user and admin Sentinel
 * proxy routes (backend/routes/sentinelProxy.js, adminSentinelProxy.js).
 * Fail-open and shadow-mode behavior lives here once instead of being
 * duplicated across the two routes.
 */
const SENTINEL_URL = process.env.SENTINEL_API_URL;
const SENTINEL_KEY = process.env.SENTINEL_API_KEY;
const SHADOW_MODE = process.env.SENTINEL_SHADOW_MODE === "true";
const TIMEOUT_MS = 8000; // 8s — generous for Render/Railway cold-start response times


// ── Startup diagnostics ────────────────────────────────────────────────────
// Logged once at module load so you can immediately see at boot whether
// the Sentinel integration is correctly configured, without needing to
// trigger a request first.
console.log("[Sentinel] Config check:", {
  url: SENTINEL_URL || "⚠️  SENTINEL_API_URL not set — all events will fail open",
  keyPresent: !!SENTINEL_KEY || "⚠️  SENTINEL_API_KEY not set — all events will fail open",
  shadowMode: SHADOW_MODE,
});

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
    const reason = !SENTINEL_URL && !SENTINEL_KEY
      ? "SENTINEL_API_URL and SENTINEL_API_KEY not set"
      : !SENTINEL_URL ? "SENTINEL_API_URL not set" : "SENTINEL_API_KEY not set";
    console.warn(`[Sentinel Proxy] ${reason} — failing open`);
    return { ...FAIL_OPEN, fail_reason: reason };
  }

  if (process.env.NODE_ENV !== "production") {
    console.log("[Sentinel Proxy] → forwarding event", {
      url: SENTINEL_URL,
      action: payload.action?.type,
      user: payload.user_id ? String(payload.user_id).slice(0, 8) + "..." : null,
    });
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
      const errBody = await upstream.text().catch(() => "");
      const reason = `upstream ${upstream.status} from ${SENTINEL_URL}`;
      console.warn(`[Sentinel Proxy] upstream returned ${upstream.status} — failing open`, {
        url: SENTINEL_URL,
        status: upstream.status,
        body: errBody.slice(0, 300),
      });
      return { ...FAIL_OPEN, fail_reason: reason, upstream_status: upstream.status, upstream_body: errBody.slice(0, 200) };
    }

    const body = await upstream.json().catch(() => null);
    const result = body && typeof body === "object" ? body : FAIL_OPEN;

    if (process.env.NODE_ENV !== "production") {
      console.log("[Sentinel Proxy] ← received verdict", {
        action: payload.action?.type,
        recommended_action: result.recommended_action,
        risk_score: result.risk?.score,
        degraded: result.degraded ?? false,
      });
    }

    if (SHADOW_MODE && result.recommended_action && result.recommended_action !== "ALLOW") {
      return { ...result, recommended_action: "ALLOW", shadow_verdict: result.recommended_action };
    }

    return result;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("[Sentinel Proxy] request timed out (3s) — failing open");
      return { ...FAIL_OPEN, fail_reason: `timeout after 3s calling ${SENTINEL_URL}` };
    } else {
      console.error("[Sentinel Proxy] error:", err.message);
      return { ...FAIL_OPEN, fail_reason: err.message };
    }
  } finally {
    clearTimeout(timer);
  }
}
