/*! Sentinel SDK | MIT License */
/**
 * Internal helpers shared by collectors. Not part of the public API.
 *
 * Collectors must never throw and must never depend on storage. These
 * helpers enforce that: `safe()` swallows any exception and degrades to a
 * fallback value (usually `null`), and `sha256Hex()` only ever returns a
 * digest — never the raw input that produced it.
 */

/** Runs `fn`, returning `fallback` (default null) if it throws or returns undefined. */
function safe(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_err) {
    return fallback;
  }
}

/**
 * SHA-256 hex digest of `input` using the native SubtleCrypto API.
 *
 * We deliberately do not ship a pure-JS SHA-256 fallback: this package has
 * zero runtime dependencies and `crypto.subtle` is unavailable only in
 * non-secure (non-HTTPS) contexts or very old browsers. In those cases we
 * return null rather than guessing at a weaker hash implementation.
 */
async function sha256Hex(input) {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle || typeof TextEncoder === 'undefined') return null;
  try {
    const bytes = new TextEncoder().encode(input);
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (_err) {
    return null;
  }
}

/** True when running in a browser-like environment with a DOM. */
function hasDom() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * DeviceCollector — one-time device/browser signals read on init.
 *
 * Everything here is either a hash of rendered output (canvas, WebGL) or a
 * coarse, already-public capability flag (screen size, timezone, language,
 * core count). We NEVER collect: raw pixel data, font enumeration, battery
 * status, audio fingerprints, or camera/mic device counts — those are
 * permanently excluded regardless of how much they'd improve signal
 * quality, per SDK policy. Every read degrades to `null` instead of
 * throwing, because fingerprinting-resistant browsers (Firefox strict
 * mode, Brave, Safari ITP) intentionally block or randomize these APIs.
 *
 * Results are cached after the first `collect()` — these signals don't
 * change within a page session, and re-deriving the canvas/WebGL hashes on
 * every `track()` call would be wasted work. The cache lives in memory
 * only (never localStorage/sessionStorage/cookies).
 */
class DeviceCollector {
  constructor() {
    this._cache = null;
  }

  async collect() {
    if (this._cache) return this._cache;
    this._cache = await this._compute();
    return this._cache;
  }

  async _compute() {
    const canvasFingerprint = await this._canvasFingerprint();
    const webgl = await this._webglFingerprint();

    const screenInfo = safe(() => ({
      width: window.screen.width,
      height: window.screen.height,
      color_depth: window.screen.colorDepth,
    }));

    const device = {
      canvas_fingerprint: canvasFingerprint,
      webgl_vendor_hash: webgl?.vendorHash ?? null,
      webgl_renderer_hash: webgl?.rendererHash ?? null,
      screen_resolution: screenInfo ? `${screenInfo.width}x${screenInfo.height}` : null,
      color_depth: screenInfo ? screenInfo.color_depth : null,
      pixel_ratio: safe(() => window.devicePixelRatio),
      timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      language: safe(() => navigator.language),
      hardware_concurrency: safe(() => navigator.hardwareConcurrency),
      // Chromium-only; null everywhere else. Deliberately NOT battery status
      // or camera/mic device counts, which are permanently excluded.
      device_memory: safe(() => navigator.deviceMemory),
    };

    // Composite stable fingerprint used for cross-account device matching.
    // Built from already-hashed / already-coarse fields, never from raw
    // pixels or any of the permanently-excluded signal categories.
    device.fingerprint = await sha256Hex(
      JSON.stringify([
        device.canvas_fingerprint,
        device.webgl_vendor_hash,
        device.webgl_renderer_hash,
        device.screen_resolution,
        device.timezone,
        device.language,
        device.hardware_concurrency,
      ])
    );

    return device;
  }

  async _canvasFingerprint() {
    if (!hasDom()) return null;
    const dataUrl = safe(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 220;
      canvas.height = 30;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Sentinel fp', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('Sentinel fp', 4, 17);
      return canvas.toDataURL();
    });
    if (!dataUrl) return null;
    // Hash immediately — the data URL (which encodes raw pixel data) is
    // never stored on `this` or returned to the caller, only its digest.
    return sha256Hex(dataUrl);
  }

  async _webglFingerprint() {
    if (!hasDom()) return null;
    const info = safe(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return null;
      const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
      const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      if (!vendor || !renderer) return null;
      return { vendor: String(vendor), renderer: String(renderer) };
    });
    if (!info) return null;
    const [vendorHash, rendererHash] = await Promise.all([
      sha256Hex(info.vendor),
      sha256Hex(info.renderer),
    ]);
    return { vendorHash, rendererHash };
  }
}

const HEADLESS_UA_PATTERN = /headless|phantomjs|slimerjs|nightmare|puppeteer|playwright/i;

// Known globals injected by browser-automation frameworks. Presence of any
// of these is a strong automation signal — none of them are user-content,
// they're just object-existence checks.
const AUTOMATION_GLOBAL_KEYS = [
  '__selenium_unwrapped',
  '__webdriver_evaluate',
  '__driver_evaluate',
  '__webdriver_script_function',
  '__fxdriver_unwrapped',
  '_phantom',
  'callPhantom',
  '__nightmare',
  'domAutomation',
  'domAutomationController',
];

// Headless Chrome / Puppeteer inject an array property on `document` whose
// name is randomized per version but always starts with this prefix.
const CDC_PROPERTY_PREFIX = 'cdc_';

/**
 * EnvironmentCollector — automation & DevTools detection.
 *
 * Every check here inspects the *existence* of a marker (a global, a
 * property, a UA substring) — never page content, form values, or user
 * behavior. Checked once on init; `recheck()` re-runs the checks that can
 * change after load (DevTools open/close, `navigator.webdriver` toggled by
 * some automation tools after page load) and is called on an interval by
 * the core SDK class, not by this collector itself — collectors never
 * schedule their own timers so they stay easy to unit test and to tear
 * down from one place (`SentinelSDK.destroy()`).
 */
class EnvironmentCollector {
  constructor() {
    this._state = this._computeStatic();
    this._state.devtools_open = this._detectDevtools();
  }

  /** Re-runs the checks that can legitimately change after page load. */
  recheck() {
    this._state.webdriver = safe(() => navigator.webdriver === true, false);
    this._state.devtools_open = this._detectDevtools();
    return this._state;
  }

  collect() {
    return { ...this._state };
  }

  destroy() {
    // No listeners/timers owned by this collector — nothing to tear down.
    // Present for interface symmetry with the other collectors.
  }

  _computeStatic() {
    return {
      webdriver: safe(() => navigator.webdriver === true, false),
      automation_markers: this._detectAutomationGlobals(),
      headless_ua: safe(() => HEADLESS_UA_PATTERN.test(navigator.userAgent), false),
      languages_empty: safe(() => Array.isArray(navigator.languages) && navigator.languages.length === 0, false),
      plugins_empty: safe(() => navigator.plugins && navigator.plugins.length === 0, false),
      devtools_open: false,
    };
  }

  _detectAutomationGlobals() {
    if (!hasDom()) return false;
    return safe(() => {
      const hasKnownGlobal = AUTOMATION_GLOBAL_KEYS.some((key) => key in window);
      const hasCdcProp = Object.keys(document).some((key) => key.startsWith(CDC_PROPERTY_PREFIX));
      return hasKnownGlobal || hasCdcProp;
    }, false);
  }

  /**
   * Best-effort DevTools heuristic based on the gap between outer and inner
   * window dimensions. This only catches docked (bottom/side) panels in the
   * same window — it cannot detect a detached DevTools window, and can
   * false-positive on some mobile browser chrome. Documented as a
   * heuristic, not a guarantee, because there is no reliable cross-browser
   * API for this.
   */
  _detectDevtools() {
    if (!hasDom()) return false;
    return safe(() => {
      const threshold = 160;
      const widthDiff = window.outerWidth - window.innerWidth;
      const heightDiff = window.outerHeight - window.innerHeight;
      return widthDiff > threshold || heightDiff > threshold;
    }, false);
  }
}

const MIN_KEY_DELTA_MS = 20;
const MAX_KEY_DELTA_MS = 5000;
const MOUSE_BUFFER_SIZE = 50;
const MAX_STORED_LINEARITY_SCORES = 20;
const MAX_STORED_PASTE_EVENTS = 20;
const MAX_STORED_KEY_TIMINGS = 200;

// A loose "looks like a credential" check used only to derive a boolean
// signal for pasted content — the matched text itself is never retained.
const CREDENTIAL_SHAPE_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,}$|^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_FIELD_SELECTOR = '[data-sentinel-field]';

/**
 * BehavioralCollector — typing rhythm, mouse linearity, scroll, paste.
 *
 * Privacy constraints enforced throughout this file (see inline comments
 * at each point they apply):
 *  - Keystroke listeners attach ONLY to elements the host app opts in via
 *    `[data-sentinel-field]` — never document-wide — and we only ever read
 *    `performance.now()` timing deltas, never `event.key` / `event.code`.
 *  - Mouse points are buffered in memory just long enough to compute a
 *    linearity ratio for the current window, then discarded; only the
 *    resulting score is kept.
 *  - Pasted text is read transiently (to compute length and a
 *    credential-shape boolean) inside the same synchronous handler and
 *    never assigned to a stored field or transmitted.
 */
class BehavioralCollector {
  constructor(options = {}) {
    this._fieldSelector = options.fieldSelector || DEFAULT_FIELD_SELECTOR;

    this._keyTimings = [];
    this._lastKeydownAt = new WeakMap(); // per-element last keydown timestamp
    this._keydownCount = 0;
    this._typingWindowStart = null;

    this._mouseBuffer = [];
    this._linearityScores = [];

    this._scrollMaxDepth = 0;
    this._scrollLastDirection = null;
    this._scrollReversals = 0;
    this._lastScrollY = 0;

    this._pasteEvents = [];

    this._attachedFields = new Map(); // element -> { keydown, keyup, paste }
    this._observer = null;
    this._globalListeners = [];

    this._install();
  }

  /** Alias required by the collector interface; delegates to flush(). */
  collect() {
    return this.flush();
  }

  /** Returns current aggregates and resets all internal buffers. */
  flush() {
    const wpm = this._computeWpm();
    const aggregates = {
      typing_speed: wpm,
      inter_key_timings: [...this._keyTimings],
      mouse_linearity_scores: [...this._linearityScores],
      scroll_max_depth: this._scrollMaxDepth,
      scroll_direction_reversals: this._scrollReversals,
      paste_events: [...this._pasteEvents],
      copy_paste_detected: this._pasteEvents.length > 0,
    };

    this._keyTimings = [];
    this._keydownCount = 0;
    this._typingWindowStart = null;
    this._linearityScores = [];
    this._scrollMaxDepth = 0;
    this._scrollReversals = 0;
    this._scrollLastDirection = null;
    this._pasteEvents = [];

    return aggregates;
  }

  destroy() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    for (const [element] of this._attachedFields) {
      this._detachField(element);
    }
    this._attachedFields.clear();
    for (const { target, type, handler } of this._globalListeners) {
      safe(() => target.removeEventListener(type, handler));
    }
    this._globalListeners = [];
  }

  // ── Setup ──────────────────────────────────────────────────────

  _install() {
    if (!hasDom()) return;
    safe(() => this._installFieldObserver());
    safe(() => this._installMouseTracking());
    safe(() => this._installScrollTracking());
  }

  _installFieldObserver() {
    document.querySelectorAll(this._fieldSelector).forEach((el) => this._attachField(el));

    this._observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes?.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches?.(this._fieldSelector)) this._attachField(node);
          node.querySelectorAll?.(this._fieldSelector).forEach((el) => this._attachField(el));
        });
        mutation.removedNodes?.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (this._attachedFields.has(node)) this._detachField(node);
          node.querySelectorAll?.('*').forEach((el) => {
            if (this._attachedFields.has(el)) this._detachField(el);
          });
        });
        if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          const el = mutation.target;
          const matches = safe(() => el.matches(this._fieldSelector), false);
          if (matches && !this._attachedFields.has(el)) this._attachField(el);
          if (!matches && this._attachedFields.has(el)) this._detachField(el);
        }
      }
    });

    this._observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [this._fieldSelector.replace(/^\[|\]$/g, '').split('=')[0]],
    });
  }

  _attachField(element) {
    if (this._attachedFields.has(element)) return;
    const keydown = (e) => this._onFieldKeydown(element, e);
    const keyup = () => {}; // reserved for interface symmetry; no data captured on keyup itself
    const paste = (e) => this._onFieldPaste(element, e);

    element.addEventListener('keydown', keydown, { passive: true });
    element.addEventListener('keyup', keyup, { passive: true });
    element.addEventListener('paste', paste, { passive: true });

    this._attachedFields.set(element, { keydown, keyup, paste });
  }

  _detachField(element) {
    const handlers = this._attachedFields.get(element);
    if (!handlers) return;
    safe(() => element.removeEventListener('keydown', handlers.keydown));
    safe(() => element.removeEventListener('keyup', handlers.keyup));
    safe(() => element.removeEventListener('paste', handlers.paste));
    this._attachedFields.delete(element);
    this._lastKeydownAt.delete(element);
  }

  _installMouseTracking() {
    const handler = (e) => this._onMouseMove(e);
    window.addEventListener('mousemove', handler, { passive: true });
    this._globalListeners.push({ target: window, type: 'mousemove', handler });
  }

  _installScrollTracking() {
    const handler = () => this._onScroll();
    window.addEventListener('scroll', handler, { passive: true });
    this._globalListeners.push({ target: window, type: 'scroll', handler });
  }

  // ── Typing (never reads event.key / event.code) ──────────────────

  _onFieldKeydown(element, _event) {
    const now = performance.now();
    if (this._typingWindowStart === null) this._typingWindowStart = now;
    this._keydownCount += 1;

    const last = this._lastKeydownAt.get(element);
    this._lastKeydownAt.set(element, now);
    if (last === undefined) return;

    const delta = now - last;
    if (delta >= MIN_KEY_DELTA_MS && delta <= MAX_KEY_DELTA_MS) {
      this._keyTimings.push(delta);
      if (this._keyTimings.length > MAX_STORED_KEY_TIMINGS) this._keyTimings.shift();
    }
  }

  _computeWpm() {
    if (this._keydownCount === 0 || this._typingWindowStart === null) return 0;
    const elapsedMinutes = (performance.now() - this._typingWindowStart) / 60000;
    if (elapsedMinutes <= 0) return 0;
    // Standard approximation: 5 keystrokes ~= 1 word. We only ever count
    // keystrokes, never their content, so this is the finest-grained speed
    // signal available under that constraint.
    return Math.round(this._keydownCount / 5 / elapsedMinutes);
  }

  // ── Mouse linearity (raw coordinates are discarded every window) ──

  _onMouseMove(e) {
    this._mouseBuffer.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (this._mouseBuffer.length >= MOUSE_BUFFER_SIZE) {
      const score = computeLinearity(this._mouseBuffer);
      if (score !== null) {
        this._linearityScores.push(score);
        if (this._linearityScores.length > MAX_STORED_LINEARITY_SCORES) this._linearityScores.shift();
      }
      this._mouseBuffer = []; // discard raw points immediately
    }
  }

  // ── Scroll depth & direction reversals ────────────────────────────

  _onScroll() {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight;
    const depth = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
    if (depth > this._scrollMaxDepth) this._scrollMaxDepth = depth;

    const direction = window.scrollY > (this._lastScrollY ?? window.scrollY) ? 'down' : 'up';
    if (this._scrollLastDirection && direction !== this._scrollLastDirection) {
      this._scrollReversals += 1;
    }
    this._scrollLastDirection = direction;
    this._lastScrollY = window.scrollY;
  }

  // ── Paste (field-scoped only; text is never stored) ────────────────

  _onFieldPaste(element, event) {
    // Read transiently to derive length + shape booleans; `pasted` is a
    // local variable that goes out of scope at the end of this handler and
    // is never assigned to `this` or included in any returned object.
    const pasted = safe(() => event.clipboardData?.getData('text') ?? '', '');
    const fieldType = safe(() => element.getAttribute('data-sentinel-field') || element.type || element.tagName.toLowerCase());

    this._pasteEvents.push({
      field_type: fieldType,
      paste_length: pasted.length,
      looks_like_credential: CREDENTIAL_SHAPE_PATTERN.test(pasted),
    });
    if (this._pasteEvents.length > MAX_STORED_PASTE_EVENTS) this._pasteEvents.shift();
  }
}

/** Straight-line distance / actual path distance, in [0, 1]. 1 = perfectly straight (bot-like). */
function computeLinearity(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const straightLine = Math.hypot(last.x - first.x, last.y - first.y);

  let pathLength = 0;
  for (let i = 1; i < points.length; i++) {
    pathLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }

  if (pathLength === 0) return straightLine === 0 ? 1 : 0;
  return Math.min(1, straightLine / pathLength);
}

const MAX_HISTORY = 20; // Hard cap — not configurable upward, by design.
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;

/**
 * Strips query strings and hash fragments (which can carry tokens, emails,
 * search terms, etc.) and generalizes numeric / UUID path segments so the
 * stored route never identifies a specific record or user.
 * e.g. "/users/48fe2.../invoices/9182?ref=x#y" -> "/users/:uuid/invoices/:id"
 */
function sanitizeRoute(pathname) {
  if (typeof pathname !== 'string') return null;
  const pathOnly = pathname.split('?')[0].split('#')[0];
  return pathOnly
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      if (UUID_SEGMENT.test(segment)) return ':uuid';
      if (NUMERIC_SEGMENT.test(segment)) return ':id';
      return segment;
    })
    .join('/');
}

/**
 * NavigationCollector — sanitized SPA route history.
 *
 * Wraps `history.pushState`/`replaceState` and listens for `popstate` to
 * build a bounded, privacy-scrubbed breadcrumb of navigation — never a
 * surveillance log of exact URLs, query strings, or fragments. The 20-entry
 * cap is enforced unconditionally (oldest entries are dropped first) and is
 * intentionally not exposed as a config option.
 */
class NavigationCollector {
  constructor() {
    this._history = [];
    this._originalPushState = null;
    this._originalReplaceState = null;
    this._popstateHandler = null;
    this._patched = false;
    this._install();
  }

  collect() {
    return { route_history: [...this._history] };
  }

  destroy() {
    if (!this._patched || !hasDom()) return;
    safe(() => {
      history.pushState = this._originalPushState;
      history.replaceState = this._originalReplaceState;
      window.removeEventListener('popstate', this._popstateHandler);
    });
    this._patched = false;
  }

  _install() {
    if (!hasDom() || typeof history === 'undefined') return;
    safe(() => {
      this._recordCurrent();

      // Store the unbound original functions (not `.bind()`ed copies) so
      // `destroy()` can restore the exact same function reference other
      // code may be holding onto or comparing against.
      this._originalPushState = history.pushState;
      this._originalReplaceState = history.replaceState;

      history.pushState = (...args) => {
        this._originalPushState.apply(history, args);
        this._recordCurrent();
      };
      history.replaceState = (...args) => {
        this._originalReplaceState.apply(history, args);
        this._recordCurrent();
      };

      this._popstateHandler = () => this._recordCurrent();
      window.addEventListener('popstate', this._popstateHandler, { passive: true });

      this._patched = true;
    });
  }

  _recordCurrent() {
    const route = safe(() => sanitizeRoute(window.location.pathname));
    if (!route) return;
    this._history.push(route);
    if (this._history.length > MAX_HISTORY) {
      this._history.shift();
    }
  }
}

/**
 * PayloadBuilder — merges collector output into the request body sent to
 * `/evaluate`.
 *
 * Deliberately absent from this payload: IP address, geolocation (lat/lon,
 * country/city), ASN, and TLS fingerprint. Those are network-derived facts
 * about the raw HTTP request — the client cannot observe them accurately
 * and, more importantly, a client-supplied IP/geo value is trivially
 * spoofable. They are enriched server-side from the actual connection, and
 * must never be sourced from anything the browser sends.
 *
 * `network.online` and `network.connection` ARE included: unlike IP/geo,
 * these describe the client's own link quality (a fact only the client can
 * observe, not a claim about the request's origin), carry no PII, and
 * cannot be used to impersonate another user even if spoofed.
 */
const PayloadBuilder = {
  async build({ collectors, userId, sessionId, actionType, metadata }) {
    const [device, environment, behavioral, navigation] = await Promise.all([
      collectSafely(collectors.device),
      collectSafely(collectors.environment),
      collectSafely(collectors.behavioral),
      collectSafely(collectors.navigation),
    ]);

    behavioral.time_on_page = getTimeOnPageSeconds();

    return {
      user_id: userId,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      action: {
        type: actionType,
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
      },
      network: collectNetworkInfo(),
      device,
      behavioral,
      navigation,
      environment,
    };
  },
};

/**
 * Collects `navigator.onLine` and the Network Information API
 * (`navigator.connection`, prefixed on some older browsers). The API is
 * Chromium-only as of this writing — Firefox and Safari have no
 * equivalent — so `connection` degrades to null rather than a
 * partially-filled object when unsupported.
 */
function collectNetworkInfo() {
  const connection = safe(
    () => navigator.connection || navigator.mozConnection || navigator.webkitConnection
  );

  return {
    user_agent: safe(() => navigator.userAgent),
    online: safe(() => navigator.onLine),
    connection: connection
      ? {
          effective_type: safe(() => connection.effectiveType),
          downlink: safe(() => connection.downlink),
          rtt: safe(() => connection.rtt),
          save_data: safe(() => connection.saveData),
        }
      : null,
  };
}

/**
 * Calls a single collector's `collect()`, isolated from the others: a
 * throwing or slow collector degrades to `{}` and never prevents the rest
 * of the payload from being built.
 */
async function collectSafely(collector) {
  try {
    const result = await collector.collect();
    return result && typeof result === 'object' ? result : {};
  } catch (_err) {
    return {};
  }
}

function getTimeOnPageSeconds() {
  return safe(() => {
    const origin = performance.timeOrigin ?? performance.timing?.navigationStart;
    if (!origin) return null;
    return Math.round((Date.now() - origin) / 1000);
  });
}

const DEFAULT_TIMEOUT_MS = 3000;
const RETRY_BACKOFF_MS = 300;

/**
 * The response returned whenever the proxy endpoint cannot be reached,
 * times out, or the server errors — this is the fail-open contract. The
 * host application must never be blocked because Sentinel is degraded,
 * so this is always `recommended_action: 'ALLOW'`, never a block/challenge.
 */
const FAIL_OPEN_RESULT = Object.freeze({
  risk: Object.freeze({ score: 0, level: 'LOW' }),
  recommended_action: 'ALLOW',
  degraded: true,
});

/**
 * Transport — sends the payload to the host application's own proxy
 * endpoint (e.g. `/api/sentinel-proxy`), with a timeout, a single retry
 * on network-level failure, and a guaranteed fail-open fallback.
 *
 * SEC-010: this class DELIBERATELY does not accept or set an API key of
 * any kind. The host application's session cookie travels with the
 * request via `credentials: 'include'`; the real Sentinel API key lives
 * on the host application's server and is attached by the proxy route,
 * never by anything running in the browser.
 *
 * `send()` never throws and never rejects: every failure path — timeout,
 * DNS/network error, non-2xx response, malformed JSON — resolves to
 * `FAIL_OPEN_RESULT` (or a shallow clone of it) instead. Non-2xx responses
 * are NOT retried (a 4xx/5xx from the server is final — retrying it can't
 * help) — only network-level failures (fetch throwing, or our own timeout
 * abort) get the single retry.
 */
class Transport {
  constructor({ endpoint, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    this._endpoint = endpoint;
    this._timeout = timeout;
  }

  async send(payload) {
    if (typeof fetch !== 'function' || !this._endpoint) {
      return { ...FAIL_OPEN_RESULT };
    }

    const first = await this._attempt(payload);
    if (first.ok) return first.body;
    if (!first.retryable) return { ...FAIL_OPEN_RESULT };

    await delay(RETRY_BACKOFF_MS);

    const second = await this._attempt(payload);
    if (second.ok) return second.body;
    return { ...FAIL_OPEN_RESULT };
  }

  /**
   * Runs one fetch attempt. Returns `{ ok, body, retryable }` — this method
   * itself never throws, so callers never need a try/catch.
   */
  async _attempt(payload) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this._timeout) : null;

    try {
      const response = await fetch(this._endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send the host application's session cookie so the proxy route
        // can authenticate the caller on its own terms. The SDK NEVER
        // attaches an API key here — that's the whole point of the proxy.
        credentials: 'include',
        body: JSON.stringify(payload),
        signal: controller?.signal,
      });

      if (!response.ok) {
        // 4xx/5xx are final — not a network failure, so not retryable.
        return { ok: false, retryable: false };
      }

      const body = await response.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return { ok: false, retryable: false };
      }
      return { ok: true, body };
    } catch (_err) {
      // fetch rejects on network errors and on our own abort() timeout —
      // both are transient/network-level, so both get the single retry.
      return { ok: false, retryable: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ResponseHandler — routes an `/evaluate` result to the developer's
 * callbacks. `onEvaluate` always fires; `onBlock`/`onChallenge` fire in
 * addition to it, based on `recommended_action`. A callback that throws is
 * caught and logged, never allowed to propagate out of `track()`.
 */
const ResponseHandler = {
  handle(result, config) {
    const action = result?.recommended_action;

    if (action === 'BLOCK' || action === 'TERMINATE_SESSION') {
      invokeSafely(config.onBlock, result);
    } else if (action === 'STEP_UP_AUTH') {
      invokeSafely(config.onChallenge, result);
    }

    invokeSafely(config.onEvaluate, result);
  },
};

function invokeSafely(callback, result) {
  if (typeof callback !== 'function') return;
  try {
    callback(result);
  } catch (err) {
    console.error('[Sentinel] a response callback threw an error:', err);
  }
}

const noop = () => {};

const DEFAULT_CONFIG = {
  endpoint: null,
  timeout: 3000,
  fieldSelector: '[data-sentinel-field]',
  environmentRecheckIntervalMs: 5000,
  onBlock: noop,
  onChallenge: noop,
  onEvaluate: noop,
};

/**
 * Error thrown when v1's `apiKey` config option is passed to v2's init().
 * Extracted so the SDK test suite can assert on the exact class and
 * message, and so callers who catch it get a clear name in stack traces.
 */
class SentinelApiKeyInBrowserError extends Error {
  constructor() {
    super(
      '[Sentinel] SECURITY: `apiKey` is no longer accepted by Sentinel.init(). ' +
        'v2 removed this option because passing an API key to a browser-side SDK ' +
        'exposes it via DevTools and page source to every user of your site. ' +
        'Instead, point `endpoint` at a proxy route on your OWN server, and attach ' +
        'the real Sentinel API key inside that route. ' +
        'Migration guide: https://sentinel.dev/docs/migrate-v1-to-v2'
    );
    this.name = 'SentinelApiKeyInBrowserError';
  }
}

/**
 * SentinelSDK — the entire public API surface of this package. On purpose,
 * this class exposes exactly three methods: `init`, `identify`, `track`.
 * Everything else (collectors, payload shape, transport/retry behavior) is
 * an internal implementation detail.
 *
 * v2 breaking change (SEC-010):
 *   - `apiKey` is no longer accepted anywhere in the SDK. Passing it to
 *     `init()` throws synchronously.
 *   - `endpoint` MUST point at a proxy route on the host application's
 *     own server (e.g. `/api/sentinel-proxy`). That route attaches the
 *     real Sentinel API key server-side and forwards the call. See
 *     `examples/proxy/` in this repo for copy-pasteable reference
 *     implementations (Express, Fastify, Next.js).
 */
class SentinelSDK {
  constructor() {
    this._initialized = false;
    this._config = null;
    this._userId = null;
    this._sessionId = null;
    this._collectors = null;
    this._transport = null;
    this._environmentIntervalId = null;
  }

  /**
   * Starts the SDK: merges `config` over documented defaults and starts all
   * collectors. Safe to call multiple times only in the sense that repeat
   * calls are ignored with a warning — the first `init()` wins.
   *
   * @param {object} config
   * @param {string} config.endpoint  REQUIRED. URL of YOUR OWN proxy route
   *                                  (e.g. `/api/sentinel-proxy`). Never
   *                                  point this at Sentinel's public API
   *                                  directly — that would require the
   *                                  browser to know an API key.
   * @param {number} [config.timeout=3000] Per-request timeout in ms before failing open.
   * @param {string} [config.fieldSelector='[data-sentinel-field]'] Selector for fields the BehavioralCollector may observe.
   * @param {number} [config.environmentRecheckIntervalMs=5000] How often automation/DevTools signals are re-checked.
   * @param {(result: object) => void} [config.onBlock] Called when the server recommends BLOCK or TERMINATE_SESSION.
   * @param {(result: object) => void} [config.onChallenge] Called when the server recommends STEP_UP_AUTH.
   * @param {(result: object) => void} [config.onEvaluate] Called on every evaluation, regardless of outcome.
   * @throws {SentinelApiKeyInBrowserError} if the caller passes `apiKey`
   *   (removed in v2 — see class doc-comment).
   */
  init(config = {}) {
    if (this._initialized) {
      console.warn('[Sentinel] init() was called more than once; ignoring this call. The first init() wins.');
      return;
    }

    // SEC-010: hard fail if v1's apiKey option is passed. A silent
    // fallback would let existing integrations keep leaking keys
    // without anyone noticing — the whole point of the v2 major bump
    // is that this MUST surface loudly.
    if (config != null && 'apiKey' in config) {
      throw new SentinelApiKeyInBrowserError();
    }

    this._config = { ...DEFAULT_CONFIG, ...config };

    if (!this._config.endpoint) {
      console.warn(
        '[Sentinel] init() was called without `endpoint`. Every track() call will fail open. ' +
          'Set `endpoint` to your proxy route (e.g. "/api/sentinel-proxy").'
      );
    }

    this._collectors = {
      device: new DeviceCollector(),
      environment: new EnvironmentCollector(),
      behavioral: new BehavioralCollector({ fieldSelector: this._config.fieldSelector }),
      navigation: new NavigationCollector(),
    };

    this._transport = new Transport({
      endpoint: this._config.endpoint,
      timeout: this._config.timeout,
    });

    if (typeof setInterval === 'function') {
      this._environmentIntervalId = setInterval(() => {
        try {
          this._collectors.environment.recheck();
        } catch (_err) {
          // A recheck failure must never take down the interval itself.
        }
      }, this._config.environmentRecheckIntervalMs);
    }

    this._initialized = true;
  }

  /**
   * Stores the current user/session identifiers in memory only — never
   * written to localStorage, sessionStorage, or cookies. Safe to call
   * before `init()`.
   *
   * IMPORTANT: These values are a CLIENT-SIDE CORRELATION HINT only.
   * They are NOT the source of truth for who the user is server-side —
   * anything running in the browser can change them. The proxy route
   * MUST derive the real `user_id`/`session_id` from its own
   * authenticated server-side session before forwarding to Sentinel.
   */
  identify(userId, sessionId) {
    this._userId = userId != null ? String(userId) : null;
    this._sessionId = sessionId != null ? String(sessionId) : null;
  }

  /**
   * Builds a payload from all collectors plus `metadata`, sends it to
   * the configured proxy endpoint, and routes the response to the
   * configured callbacks. Always resolves — a network failure resolves
   * to the fail-open default response rather than rejecting, so this
   * call can never break the host application.
   *
   * @param {string} actionType e.g. "login", "export_data", "page_view".
   * @param {object} [metadata] Arbitrary developer-supplied metadata merged into `action.metadata`.
   * @returns {Promise<object>} The evaluation result (or the fail-open default).
   */
  async track(actionType, metadata = {}) {
    if (!this._initialized) {
      throw new Error(
        '[Sentinel] Sentinel.track() was called before Sentinel.init(). Call Sentinel.init(config) once, ' +
          'during application startup, before tracking any actions.'
      );
    }

    if (!this._userId) {
      console.warn('[Sentinel] Sentinel.track() was called before Sentinel.identify(). Proceeding with user_id: null.');
    }

    let payload;
    try {
      payload = await PayloadBuilder.build({
        collectors: this._collectors,
        userId: this._userId,
        sessionId: this._sessionId,
        actionType,
        metadata,
      });
    } catch (_err) {
      // Payload construction must never block the host app either.
      ResponseHandler.handle(FAIL_OPEN_RESULT, this._config);
      return { ...FAIL_OPEN_RESULT };
    }

    const result = await this._transport.send(payload);
    ResponseHandler.handle(result, this._config);
    return result;
  }

  /**
   * Tears down all collector listeners/timers. Not part of the 3-method
   * public API contract, but necessary for correct SPA cleanup (e.g. in a
   * React `useEffect` return function) — omitting it would otherwise leak
   * a `setInterval` and DOM listeners on every remount.
   */
  destroy() {
    if (!this._initialized) return;
    if (this._environmentIntervalId != null) {
      clearInterval(this._environmentIntervalId);
      this._environmentIntervalId = null;
    }
    if (this._collectors) {
      for (const collector of Object.values(this._collectors)) {
        try {
          collector.destroy?.();
        } catch (_err) {
          // Ignore — teardown of one collector must not block the others.
        }
      }
    }
    this._initialized = false;
  }
}

const Sentinel = new SentinelSDK();

export { SentinelSDK, Sentinel as default };
