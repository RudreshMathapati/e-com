/**
 * sentinel.js — thin wrapper around the real @sentinel-dev/sdk package for
 * the admin panel. Mirrors frontend/src/sentinel.js exactly, except the
 * default endpoint targets the ADMIN proxy route (gated by adminAuth, not
 * authUser) — see backend/routes/adminSentinelProxy.js.
 *
 * The SDK's browser transport authenticates via `credentials: 'include'`
 * (cookies), not the `token` header the rest of this app uses — the
 * backend sets an httpOnly `sentinel_admin_token` cookie on admin login
 * specifically so this proxy call can authenticate (see
 * backend/controllers/userController.js adminLogin, and
 * backend/middleware/adminAuth.js).
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
 * Call ONCE at app boot (main.jsx, before rendering).
 *
 * @param {Object} [options]
 * @param {string} [options.endpoint='/api/admin/sentinel-proxy']
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
    endpoint: options.endpoint || "/api/admin/sentinel-proxy",
  });
}

/**
 * sentinelIdentify(userId, sessionId)
 *
 * Call right after a successful admin login. Both arguments are the admin
 * JWT here — the proxy re-derives the real identity server-side.
 */
export function sentinelIdentify(userId, sessionId) {
  Sentinel.identify(userId, sessionId);
}

/**
 * sentinelTrack(actionType, metadata?)
 *
 * NEVER throws, NEVER rejects — fails open both on network errors (the SDK
 * itself) and if called before initSentinel() (this wrapper).
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

/** destroySentinel() — tears down collector listeners/timers. */
export function destroySentinel() {
  Sentinel.destroy();
  _initialized = false;
}
