/// <reference types="vite/client" />

// Unique per-build id, injected by vite (see vite.config.ts). Compared against
// the core's embedded id to detect and recover from a stale WebView-cached shell.
declare const __BUILD_ID__: string;
/** Package version injected by Vite so browser preview matches desktop metadata. */
declare const __APP_VERSION__: string;
