import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter"; // bundled fonts users can pick from in Settings
import "@fontsource-variable/figtree";
import "@fontsource-variable/jetbrains-mono";
import { App } from "@/App";
import "@/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
