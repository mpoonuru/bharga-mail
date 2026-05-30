import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests run in jsdom (the store touches document for theme/density).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
