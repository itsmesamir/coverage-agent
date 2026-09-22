import { defineConfig } from "vitest/config";

// Mirrors api/tests/unit and api/tests/integration from the Python layout.
// Same directories, .test.ts instead of test_*.py.
export default defineConfig({
  test: {
    include: ["api/tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Gate 1's exit criterion is literally "green with zero tests" --
    // vitest's default is to fail when no test files exist, so that has to
    // be opted out of explicitly rather than left as an accident.
    passWithNoTests: true,
  },
});
