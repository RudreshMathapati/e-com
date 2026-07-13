import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import axios from "axios";
import { toast } from "react-toastify";
import { initSentinel, sentinelTrack } from "./sentinel.js";

// Initialize the Sentinel SDK early at app boot. Absolute endpoint for the
// same reason as the storefront (frontend/src/main.jsx): admin and backend
// are separate Vercel deployments with no API rewrite between them.
const backendUrl = import.meta.env.VITE_BACKEND_URL;
initSentinel({ endpoint: `${backendUrl}/api/admin/sentinel-proxy` });

// Global Axios interceptor — tracks every state-changing admin action
// (add product, remove product, update order status, etc.) that isn't
// already manually tracked with richer metadata elsewhere.
axios.interceptors.request.use(async (config) => {
  const isSecurityRoute = config.url.includes("/api/admin/sentinel-proxy");
  if (isSecurityRoute) {
    return config;
  }

  const urlParts = config.url.split("/");
  const actionName = urlParts[urlParts.length - 1] || "api_request";

  try {
    if (config.method === "post" || config.method === "put" || config.method === "delete") {
      // Admin login (identity not yet known) and the two highest-risk
      // actions (manually tracked with richer metadata in List.jsx /
      // Orders.jsx) are excluded here to avoid double-tracking.
      const isAlreadyHandledInUI =
        config.url.includes("/api/user/admin") ||
        config.url.includes("/api/product/remove") ||
        config.url.includes("/api/order/status");

      if (!isAlreadyHandledInUI) {
        const verdict = await sentinelTrack(actionName, { url: config.url });

        if (verdict.recommended_action === "BLOCK") {
          toast.error("Action blocked due to security detection.");
          throw new axios.Cancel("Blocked by Sentinel");
        }

        if (verdict.recommended_action === "TERMINATE_SESSION") {
          toast.error("Session terminated due to security risk. Please login again.");
          localStorage.removeItem("token");
          window.location.href = "/";
          throw new axios.Cancel("Session terminated by Sentinel");
        }

        if (verdict.recommended_action === "STEP_UP_AUTH") {
          toast.warn("Unusual activity detected on this admin session.");
        }
      }
    }
  } catch (err) {
    if (axios.isCancel(err)) {
      throw err;
    }
    console.warn("[Sentinel Interceptor] fail open on tracking error:", err);
  }

  return config;
}, (error) => {
  return Promise.reject(error);
});

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
