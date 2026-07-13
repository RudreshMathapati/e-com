/**
 * sentinel.js — Manual Sentinel SDK implementation
 *
 * This file implements the same interface as @sentinel-dev/sdk so that
 * swapping to the real SDK later is a single-file change:
 *   1. npm install @sentinel-dev/sdk
 *   2. Replace the internals of initSentinel / sentinelIdentify / sentinelTrack
 *      with real SDK calls.
 *   3. Done. Login.jsx, PlaceOrder.jsx, MfaModal.jsx — nothing else changes.
 *
 * What this collects:
 *   ✅ performance.now() keystroke timing DELTAS on opted-in fields
 *   ✅ paste metadata (length + credential-shape boolean) on opted-in fields
 *   ❌ Never event.key / event.code (no raw keystrokes)
 *   ❌ Never clipboard content
 *   ❌ Never localStorage / sessionStorage / cookies written
 */

// ─── Module-level state ───────────────────────────────────────────────────────
let _endpoint = "/api/sentinel-proxy";
let _authToken = null; // JWT, used as both userId hint and auth header
let _initialized = false;

// Behavioral signal buffers — cleared after every track() call
let _keyTimings = [];    // [{ field: string, delta_ms: number }]
let _pasteEvents = [];   // [{ field: string, length: number, looks_credential: boolean }]
let _lastKeyTime = {};   // { [field]: performance.now() timestamp }

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Attaches keystroke-timing and paste listeners to every
 * [data-sentinel-field] input in the document.
 * Safe to call multiple times — uses a sentinel flag on the element.
 */
function attachFieldListeners() {
  const attachToFields = () => {
    document.querySelectorAll("[data-sentinel-field]").forEach((el) => {
      if (el._sentinelAttached) return; // already listening
      el._sentinelAttached = true;

      const field = el.getAttribute("data-sentinel-field");

      // Keystroke timing: only record the delta between consecutive keydowns
      el.addEventListener("keydown", () => {
        const now = performance.now();
        if (_lastKeyTime[field] !== undefined) {
          _keyTimings.push({
            field,
            delta_ms: Math.round(now - _lastKeyTime[field]),
          });
          // Cap buffer at 200 entries to avoid memory growth on long sessions
          if (_keyTimings.length > 200) _keyTimings.shift();
        }
        _lastKeyTime[field] = now;
      });

      // Paste metadata: length and a heuristic for credential-shaped content
      // We NEVER read the actual pasted text.
      el.addEventListener("paste", (e) => {
        const text = e.clipboardData?.getData("text") ?? "";
        _pasteEvents.push({
          field,
          length: text.length,
          // Simple heuristic: long string containing special chars → likely a password
          looks_credential:
            text.length > 8 && /[@!#$%^&*()\-_=+[\]{};:'",.<>?/\\|`~]/.test(text),
        });
      });
    });
  };

  // Attach to already-rendered fields
  attachToFields();

  // Re-attach whenever new fields are added to the DOM (SPA navigation)
  const observer = new MutationObserver(attachToFields);
  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * initSentinel(options?)
 *
 * Call ONCE at app boot (e.g., in main.jsx before rendering).
 * Second and subsequent calls are safe no-ops (logs a warning).
 *
 * @param {Object} [options]
 * @param {string} [options.endpoint='/api/sentinel-proxy'] - YOUR proxy route
 */
export function initSentinel(options = {}) {
  if (_initialized) {
    console.warn(
      "[Sentinel] initSentinel() was called more than once. First call wins — this call is ignored."
    );
    return;
  }
  _initialized = true;
  _endpoint = options.endpoint || "/api/sentinel-proxy";

  // Attach field listeners once the DOM is available
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attachFieldListeners);
    } else {
      attachFieldListeners();
    }
  }
}

/**
 * sentinelIdentify(userId, sessionId)
 *
 * Call right after a successful login. Stored in module memory only —
 * never written to localStorage, cookies, or sessionStorage.
 *
 * In this app we pass the JWT token as both arguments:
 *   sentinelIdentify(jwtToken, jwtToken)
 * The proxy re-derives the real user ID from the JWT server-side,
 * so the values passed here are convenience hints only.
 *
 * @param {string} userId
 * @param {string} sessionId
 */
export function sentinelIdentify(userId, sessionId) {
  _authToken = userId; // In this app userId === JWT token
  // sessionId is also the JWT token; the proxy handles it via req.headers.token
}

/**
 * sentinelTrack(actionType, metadata?)
 *
 * Track a meaningful user action and get a verdict from Sentinel.
 *
 * NEVER throws. NEVER rejects. Returns FAIL_OPEN on any network error,
 * timeout, or if Sentinel is down — so Sentinel outages never block users.
 *
 * @param {string} actionType - e.g. 'login', 'place_order'
 * @param {Object} [metadata] - extra context merged into action payload
 * @returns {Promise<{recommended_action: string, risk: Object, degraded?: boolean}>}
 */
export async function sentinelTrack(actionType, metadata = {}) {
  const FAIL_OPEN = {
    risk: { score: 0, level: "LOW" },
    recommended_action: "ALLOW",
    degraded: true,
  };

  if (!_initialized) {
    console.error(
      "[Sentinel] sentinelTrack() called before initSentinel(). " +
        "Make sure initSentinel() is called in main.jsx before the React app mounts."
    );
    return FAIL_OPEN;
  }

  if (!_authToken) {
    console.warn(
      "[Sentinel] sentinelTrack() called before sentinelIdentify(). " +
        "The user identity will be null in this request."
    );
  }

  // Snapshot and clear the behavioral buffers atomically
  const payload = {
    action: {
      type: actionType,
      ...metadata,
    },
    behavioral: {
      keyTimings: [..._keyTimings],
      pasteEvents: [..._pasteEvents],
    },
  };
  _keyTimings = [];
  _pasteEvents = [];

  // 3.5s timeout — slightly longer than the proxy's 3s so the proxy error
  // propagates back cleanly rather than both aborting simultaneously
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);

  try {
    const response = await fetch(_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Pass the JWT so the backend authUser middleware can verify identity
        ...(_authToken ? { token: _authToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[Sentinel] proxy returned HTTP ${response.status} — failing open`);
      return FAIL_OPEN;
    }

    const data = await response.json().catch(() => null);
    return data && typeof data === "object" ? data : FAIL_OPEN;
  } catch (err) {
    if (err.name === "AbortError") {
      console.warn("[Sentinel] sentinelTrack() timed out after 3.5s — failing open");
    } else {
      console.warn("[Sentinel] sentinelTrack() network error — failing open:", err.message);
    }
    return FAIL_OPEN;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * destroySentinel()
 *
 * Clears all module state. Useful in tests or if you need a full reset.
 * React/framework wrappers call this automatically on unmount.
 */
export function destroySentinel() {
  _initialized = false;
  _authToken = null;
  _keyTimings = [];
  _pasteEvents = [];
  _lastKeyTime = {};
}
