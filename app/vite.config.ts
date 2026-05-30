import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Vite 8 + React 19 + Tailwind v4. Tauri expects a fixed port and no auto-clearing.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
