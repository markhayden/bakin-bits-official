import { test } from 'bun:test'

// Importing playwright at module top crashes bun 1.3.13's --isolate runner
// (intermittent SIGSEGV across the whole suite) even when every test in the
// file is skipped, so the module loads only when a live preview makes the
// browser tests runnable.
export const browserTest = process.env.TERMINAL_PREVIEW_URL ? test : test.skip

export async function launchChromium() {
  const { chromium } = await import('playwright')
  return chromium.launch({ headless: true })
}
