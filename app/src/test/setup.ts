// Global test-environment configuration, loaded by Vitest before every test file
// (see vitest.config.ts -> test.setupFiles). React 19 requires this flag to be set
// before any act(...) call so tests exercise the real concurrent-rendering path
// instead of printing "The current testing environment is not configured to
// support act(...)". Tests that render via @/test/render already set this, but
// tests that import act from "react" directly do not.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
