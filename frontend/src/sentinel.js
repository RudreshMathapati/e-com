/**
 * sentinel.js — thin wrapper around the real @sentinel-dev/sdk package.
 *
 * Kept as a wrapper (instead of importing the SDK directly in every
 * component) so call sites — Login.jsx, PlaceOrder.jsx, MfaModal.jsx,
 * ShopContext.jsx, main.jsx — never had to change when this app moved
 * from a hand-rolled shim to the real SDK. Same four exports, same
 * signatures, same fail-open contract.
 *
 * The SDK's browser transport authenticates via `credentials: 'include'`
 * (cookies), not the `token` header this app uses everywhere else — the
 * backend sets an httpOnly `sentinel_user_token` cookie on login/register
 * specifically so this proxy call can authenticate (see
 * backend/controllers/userController.js and backend/middleware/auth.js).
 */
import Sentinel from "@sentinel-dev/sdk";

let _initialized = false;

const FAIL_OPEN = {
  risk: { score: 0, level: "LOW" },
  recommended_action: "ALLOW",
  degraded: true,
};

/**
 * initSentinel(options?)
 *
 * Call ONCE at app boot (main.jsx, before rendering). Second and
 * subsequent calls are safe no-ops (logs a warning) — enforced by the SDK
 * itself as well as this guard.
 *
 * @param {Object} [options]
 * @param {string} [options.endpoint='/api/sentinel-proxy']
 */
export function initSentinel(options = {}) {
  if (_initialized) {
    console.warn(
      "[Sentinel] initSentinel() was called more than once. First call wins — this call is ignored."
    );
    return;
  }
  _initialized = true;
  Sentinel.init({
    endpoint: options.endpoint || "/api/sentinel-proxy",
  });
}

/**
 * sentinelIdentify(userId, sessionId)
 *
 * Call right after a successful login. In this app both arguments are the
 * JWT token — the proxy re-derives the real identity from the
 * server-verified session (header or cookie), so these are hints only.
 */
export function sentinelIdentify(userId, sessionId) {
  Sentinel.identify(userId, sessionId);
}

/**
 * sentinelTrack(actionType, metadata?)
 *
 * Track a meaningful user action and get a verdict from Sentinel. NEVER
 * throws, NEVER rejects — the SDK itself fails open on network errors;
 * this wrapper additionally fails open if called before initSentinel()
 * rather than letting the SDK's synchronous error propagate into callers
 * that don't expect track() to throw.
 *
 * @param {string} actionType e.g. 'login', 'place_order'
 * @param {Object} [metadata]
 * @returns {Promise<{recommended_action: string, risk: Object, degraded?: boolean}>}
 */
export async function sentinelTrack(actionType, metadata = {}) {
  if (!_initialized) {
    console.error(
      "[Sentinel] sentinelTrack() called before initSentinel(). " +
        "Make sure initSentinel() is called in main.jsx before the React app mounts."
    );
    return { ...FAIL_OPEN };
  }
  return Sentinel.track(actionType, metadata);
}

/**
 * destroySentinel()
 *
 * Tears down collector listeners/timers. Useful in tests or a full reset.
 */
export function destroySentinel() {
  Sentinel.destroy();
  _initialized = false;
}
