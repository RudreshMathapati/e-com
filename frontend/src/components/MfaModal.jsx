import React, { useState, useEffect, useRef, useContext } from "react";
import axios from "axios";
import { ShopContext } from "../context/ShopContext";

/**
 * MfaModal
 *
 * Shown when Sentinel returns STEP_UP_AUTH on login, indicating the session
 * looks unusual enough to warrant a second factor before proceeding.
 *
 * Flow:
 *   1. Modal opens → automatically calls POST /api/user/send-otp to email the code
 *   2. User enters the 6-digit code (auto-advances between boxes)
 *   3. "Verify" → POST /api/user/verify-otp
 *   4. On success → calls onVerified() → Login.jsx sets the token & navigates home
 *   5. "Resend Code" re-triggers step 1 after a 30s cooldown
 *
 * Props:
 *   isOpen      {boolean}  Controls visibility
 *   onVerified  {function} Called when OTP is confirmed — caller should then complete login
 *   onClose     {function} Called when user cancels / max retries exceeded
 *   token       {string}   The JWT from the successful login (used to auth OTP requests)
 */
const RESEND_COOLDOWN = 30; // seconds
const MAX_ATTEMPTS = 3;

const MfaModal = ({ isOpen, onVerified, onClose, token }) => {
  const { backendUrl } = useContext(ShopContext);

  // OTP digits — 6 individual boxes
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const inputRefs = useRef([]);

  // UI state
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [attempts, setAttempts] = useState(0);

  // Resend cooldown timer
  const [cooldown, setCooldown] = useState(0);
  const cooldownRef = useRef(null);

  // ─── Auto-send OTP when modal opens ───────────────────────────────────────
  useEffect(() => {
    if (isOpen && token) {
      handleSendOtp();
    }
    // Reset state on every open
    return () => {
      setDigits(["", "", "", "", "", ""]);
      setError("");
      setAttempts(0);
      setSent(false);
      setCooldown(0);
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, [isOpen]);

  // Focus first box when modal opens
  useEffect(() => {
    if (isOpen && inputRefs.current[0]) {
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    }
  }, [isOpen]);

  // ─── Send OTP ─────────────────────────────────────────────────────────────
  const handleSendOtp = async () => {
    if (cooldown > 0 || sending) return;
    setSending(true);
    setError("");
    try {
      const res = await axios.post(
        backendUrl + "/api/user/send-otp",
        {},
        { headers: { token } }
      );
      if (res.data.success) {
        setSent(true);
        startCooldown();
      } else {
        setError(res.data.message || "Failed to send code. Please try again.");
      }
    } catch {
      setError("Network error. Please check your connection.");
    } finally {
      setSending(false);
    }
  };

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN);
    cooldownRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearInterval(cooldownRef.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  };

  // ─── Digit input handlers ─────────────────────────────────────────────────
  const handleDigitChange = (index, value) => {
    const clean = value.replace(/\D/g, "").slice(-1); // only last digit
    const next = [...digits];
    next[index] = clean;
    setDigits(next);
    setError("");

    // Auto-advance to next box
    if (clean && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
    // Auto-submit when all 6 are filled
    if (clean && index === 5 && next.every((d) => d !== "")) {
      handleVerify(next.join(""));
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      // On empty box + backspace → go to previous
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === "ArrowRight" && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  // Paste handler: distribute all 6 digits across boxes
  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) {
      const next = pasted.split("");
      setDigits(next);
      inputRefs.current[5]?.focus();
      handleVerify(pasted);
    }
  };

  // ─── Verify OTP ───────────────────────────────────────────────────────────
  const handleVerify = async (codeOverride) => {
    const code = codeOverride ?? digits.join("");
    if (code.length < 6) {
      setError("Please enter the complete 6-digit code.");
      return;
    }
    if (loading) return;

    setLoading(true);
    setError("");

    try {
      const res = await axios.post(
        backendUrl + "/api/user/verify-otp",
        { code },
        { headers: { token } }
      );

      if (res.data.success) {
        onVerified(); // 🎉 Let Login.jsx complete the login
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);

        if (newAttempts >= MAX_ATTEMPTS) {
          setError("Too many incorrect attempts. Please start over.");
          setTimeout(() => onClose(), 2000);
        } else {
          setError(
            `${res.data.message} (${MAX_ATTEMPTS - newAttempts} attempt${
              MAX_ATTEMPTS - newAttempts === 1 ? "" : "s"
            } remaining)`
          );
          // Clear the digit boxes for retry
          setDigits(["", "", "", "", "", ""]);
          inputRefs.current[0]?.focus();
        }
      }
    } catch {
      setError("Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  if (!isOpen) return null;

  const code = digits.join("");
  const isComplete = code.length === 6;

  return (
    // Backdrop
    <div
      id="mfa-modal-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target.id === "mfa-modal-backdrop") onClose();
      }}
    >
      {/* Modal card */}
      <div
        id="mfa-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Identity Verification"
        style={{
          background: "#fff",
          borderRadius: "16px",
          padding: "40px 36px",
          width: "100%",
          maxWidth: "420px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.18)",
          textAlign: "center",
          animation: "sentinelModalIn 0.22s cubic-bezier(0.34,1.56,0.64,1)",
        }}
      >
        {/* Lock icon */}
        <div
          style={{
            width: "56px",
            height: "56px",
            background: "#f5f5f5",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 20px",
          }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path
              d="M17 11H7V8a5 5 0 0 1 10 0v3Z"
              stroke="#111"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <rect
              x="4"
              y="11"
              width="16"
              height="11"
              rx="2"
              stroke="#111"
              strokeWidth="1.8"
            />
            <circle cx="12" cy="16.5" r="1.5" fill="#111" />
          </svg>
        </div>

        <h2
          style={{
            fontSize: "20px",
            fontWeight: "700",
            color: "#111",
            margin: "0 0 8px",
            letterSpacing: "-0.3px",
          }}
        >
          Verify Your Identity
        </h2>
        <p
          style={{
            fontSize: "14px",
            color: "#666",
            margin: "0 0 28px",
            lineHeight: "1.6",
          }}
        >
          {sent
            ? "A 6-digit code was sent to your registered email address."
            : sending
            ? "Sending your verification code…"
            : "Preparing to send your verification code…"}
        </p>

        {/* 6-digit input boxes */}
        <div
          style={{
            display: "flex",
            gap: "10px",
            justifyContent: "center",
            marginBottom: "20px",
          }}
        >
          {digits.map((digit, i) => (
            <input
              key={i}
              id={`mfa-digit-${i}`}
              ref={(el) => (inputRefs.current[i] = el)}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={handlePaste}
              disabled={loading || !sent}
              style={{
                width: "48px",
                height: "56px",
                border: error
                  ? "2px solid #e74c3c"
                  : digit
                  ? "2px solid #111"
                  : "2px solid #ddd",
                borderRadius: "10px",
                fontSize: "22px",
                fontWeight: "700",
                textAlign: "center",
                color: "#111",
                outline: "none",
                transition: "border-color 0.15s",
                background: !sent ? "#f9f9f9" : "#fff",
                cursor: !sent ? "not-allowed" : "text",
              }}
            />
          ))}
        </div>

        {/* Error message */}
        {error && (
          <p
            style={{
              color: "#e74c3c",
              fontSize: "13px",
              margin: "0 0 16px",
              padding: "10px 14px",
              background: "#fdf2f2",
              borderRadius: "8px",
              border: "1px solid #fcc",
            }}
          >
            {error}
          </p>
        )}

        {/* Verify button */}
        <button
          id="mfa-verify-btn"
          onClick={() => handleVerify()}
          disabled={!isComplete || loading || !sent}
          style={{
            width: "100%",
            padding: "14px",
            background: isComplete && sent ? "#111" : "#e5e5e5",
            color: isComplete && sent ? "#fff" : "#999",
            border: "none",
            borderRadius: "10px",
            fontSize: "15px",
            fontWeight: "600",
            cursor: isComplete && sent ? "pointer" : "not-allowed",
            transition: "background 0.2s, transform 0.1s",
            marginBottom: "16px",
          }}
          onMouseDown={(e) => {
            if (isComplete && sent) e.currentTarget.style.transform = "scale(0.98)";
          }}
          onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
        >
          {loading ? "Verifying…" : "Verify & Continue"}
        </button>

        {/* Resend + Cancel */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "13px",
          }}
        >
          <button
            id="mfa-resend-btn"
            onClick={handleSendOtp}
            disabled={cooldown > 0 || sending}
            style={{
              background: "none",
              border: "none",
              color: cooldown > 0 || sending ? "#bbb" : "#555",
              cursor: cooldown > 0 || sending ? "not-allowed" : "pointer",
              padding: 0,
              fontSize: "13px",
              textDecoration: cooldown > 0 || sending ? "none" : "underline",
              textUnderlineOffset: "3px",
            }}
          >
            {sending
              ? "Sending…"
              : cooldown > 0
              ? `Resend in ${cooldown}s`
              : "Resend Code"}
          </button>

          <button
            id="mfa-cancel-btn"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#bbb",
              cursor: "pointer",
              padding: 0,
              fontSize: "13px",
            }}
          >
            Cancel
          </button>
        </div>
      </div>

      {/* Keyframe animation */}
      <style>{`
        @keyframes sentinelModalIn {
          from { opacity: 0; transform: scale(0.88) translateY(12px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
};

export default MfaModal;
