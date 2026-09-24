import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Unit tests run in jsdom (the store touches document for theme/density).
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
