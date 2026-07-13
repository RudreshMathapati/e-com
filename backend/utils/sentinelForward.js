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
 * Resolves the REAL shopper IP on this server, before forwarding to
 * Sentinel. SEC-015: Sentinel's /evaluate never trusts an IP inside the
 * JSON body (spoofable) and instead defaults to whoever is DIRECTLY
 * connecting to it over TCP — since these proxy routes are the ones
 * calling Sentinel (not the shopper's browser), that would be THIS
 * SERVER's own IP for every single request, silently making every
 * customer show up as the same one location. Forwarding this via
 * X-Sentinel-Client-IP is how Sentinel learns the real one instead.
 *
 * Priority mirrors the SDK's own proxy reference implementations
 * (sdk/examples/proxy/express/proxy.js): a trusted CDN header first
 * (Cloudflare's cf-connecting-ip, or the generic x-real-ip), then the
 * first hop of x-forwarded-for (what Vercel's edge network sets — this
 * backend is deployed there per vercel.json), then Express's own req.ip
 * as a last resort (only meaningful with `app.set('trust proxy', ...)`,
 * which server.js/api/index.js both set).
 */
export function resolveRealClientIp(req) {
  const cfIp = req.headers["cf-connecting-ip"];
  if (cfIp) return cfIp;
  const realIp = req.headers["x-real-ip"];
  if (realIp) return realIp;
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) return String(forwardedFor).split(",")[0].trim();
  return req.ip || null;
}

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
 *
 * @param {object} payload
 * @param {string|null} [clientIp] from resolveRealClientIp(req) — sent as
 *   X-Sentinel-Client-IP so geo/VPN/Tor/impossible-travel scoring reflects
 *   the actual shopper, not this server. Omitted entirely when null so
 *   Sentinel falls back to its own TCP-observed address rather than an
 *   empty header.
 */
export async function forwardToSentinel(payload, clientIp = null) {
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
        ...(clientIp ? { "X-Sentinel-Client-IP": clientIp } : {}),
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
