import { afterEach, vi } from "vitest";

// Scenario rows are wiped by setupMiniflareD1({ reset: true }) before each test.
export function setupAndTeardown() {
  afterEach(() => {
    vi.useRealTimers();
  });
}
