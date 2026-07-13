import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/sentinel-proxy": "http://localhost:4000",
      "/api/user/send-otp": "http://localhost:4000",
      "/api/user/verify-otp": "http://localhost:4000",
    },
  },
});
