import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_PI_REMOTE_PROXY_TARGET ?? "http://127.0.0.1:8787";

// HMR is disabled by default in this deploy. The WUI is consumed from a
// remote browser (often iPhone Safari over Tailscale); when iOS suspends
// the tab in background the Vite HMR WebSocket dies, and on resume the
// HMR client calls `location.reload()` to recover — destroying the user's
// scroll position. Telemetry (logs/client-events.jsonl) showed every
// observed "random refresh" was actually a Vite HMR reload. Opt back in
// with VITE_PI_REMOTE_HMR=1 if you want HMR while editing on the same
// machine that runs `vite`.
const hmrEnabled = process.env.VITE_PI_REMOTE_HMR === "1";

export default defineConfig({
  plugins: [react()],
  server: {
    hmr: hmrEnabled,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
