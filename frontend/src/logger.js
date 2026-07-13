/**
 * logger.js — logs every Axios request and error to the browser console.
 * Import and call setupLogger(axiosInstance) once in main.jsx.
 */
import axios from "axios";

export function setupLogger() {
  // ── Request ────────────────────────────────────────────────────────────
  axios.interceptors.request.use(
    (config) => {
      console.log(
        `%c→ ${config.method?.toUpperCase()} ${config.url}`,
        "color:#6366f1;font-weight:bold;"
      );
      return config;
    },
    (error) => {
      console.error("✗ Request error:", error.message);
      return Promise.reject(error);
    }
  );

  // ── Response ───────────────────────────────────────────────────────────
  axios.interceptors.response.use(
    (response) => {
      console.log(
        `%c← ${response.status} ${response.config.url}`,
        "color:#10b981;font-weight:bold;"
      );
      return response;
    },
    (error) => {
      const status = error.response?.status ?? "ERR";
      const url    = error.config?.url ?? "unknown";
      console.error(
        `%c✗ ${status} ${url}`,
        "color:#ef4444;font-weight:bold;",
        error.message
      );
      return Promise.reject(error);
    }
  );
}
