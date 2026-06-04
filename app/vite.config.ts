import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { randomBytes } from "node:crypto";
import path from "node:path";

// A unique id stamped into every build. It is baked into the JS bundle as the
// global `__BUILD_ID__` AND injected as a <meta> tag in index.html, so the Rust
// core (always the current build) and the loaded frontend (possibly a stale,
// WebView-cached one) can compare ids and force one fresh reload on mismatch.
// This is the standard "stale deploy" guard — it eliminates the cached-shell
// problem without fragile cache-directory deletion.
const BUILD_ID = randomBytes(8).toString("hex");

// Vite 8 + React 19 + Tailwind v4. Tauri expects a fixed port and no auto-clearing.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "bharga-build-id",
      transformIndexHtml(html) {
        return html.replace(
          "</head>",
          `    <meta name="bharga-build" content="${BUILD_ID}" />\n  </head>`,
        );
      },
    },
  ],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split heavy vendors into cacheable chunks instead of one big bundle.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "editor";
          if (id.includes("@phosphor-icons")) return "icons";
          if (id.includes("/motion/") || id.includes("framer-motion")) return "motion";
          if (id.includes("/react") || id.includes("react-dom") || id.includes("scheduler")) return "react";
          if (id.includes("dayjs")) return "date";
          if (id.includes("gsap")) return "gsap";
          return "vendor";
        },
      },
    },
  },
});
