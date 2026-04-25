/**
 * Tests for the update-checker's pure logic. The network call itself
 * (`fetchLatestRelease`) is covered via `checkForUpdates` mocking the
 * fetch layer — we don't exercise it against real GitHub in CI.
 */
import { describe, it, expect } from "vitest"
import { isNewer } from "./update-check"

describe("isNewer — semver comparison", () => {
  it("remote > local on patch", () => {
    expect(isNewer("0.3.10", "0.3.9")).toBe(true)
  })

  it("remote > local on minor", () => {
    expect(isNewer("0.4.0", "0.3.99")).toBe(true)
  })

  it("remote > local on major", () => {
    expect(isNewer("1.0.0", "0.99.99")).toBe(true)
  })

  it("remote equal to local is NOT newer", () => {
    expect(isNewer("0.3.9", "0.3.9")).toBe(false)
  })

  it("remote < local is NOT newer (user on a nightly build)", () => {
    expect(isNewer("0.3.8", "0.3.9")).toBe(false)
  })

  it("tolerates leading 'v' on remote tag", () => {
    expect(isNewer("v0.3.10", "0.3.9")).toBe(true)
  })

  it("tolerates leading 'v' on local too", () => {
    expect(isNewer("v0.4.0", "v0.3.9")).toBe(true)
  })

  it("handles missing components as zero", () => {
    // Weirdly short tag like "v1" — treat as 1.0.0.
    expect(isNewer("v1", "0.3.9")).toBe(true)
    expect(isNewer("v1.0", "1.0.0")).toBe(false)
  })

  it("does not false-positive on lexicographic comparison", () => {
    // "0.3.9" comes AFTER "0.3.10" alphabetically — the check must be
    // numeric, not string-based. If this ever regressed to .localeCompare
    // or similar, users on 0.3.10 would be told there's a newer 0.3.9.
    expect(isNewer("0.3.9", "0.3.10")).toBe(false)
    expect(isNewer("0.3.10", "0.3.9")).toBe(true)
  })

  it("double-digit minor/patch compare correctly", () => {
    expect(isNewer("0.10.0", "0.9.99")).toBe(true)
    expect(isNewer("0.10.5", "0.10.4")).toBe(true)
    expect(isNewer("0.10.4", "0.10.5")).toBe(false)
  })

  it("non-numeric garbage in a slot collapses to 0 (can't sneak through an upgrade)", () => {
    // Defense against a malformed remote tag like "v0.3.foo" — don't
    // treat "foo" as infinity and tell the user to upgrade to nothing.
    expect(isNewer("v0.3.foo", "0.3.9")).toBe(false)
    expect(isNewer("v0.foo.0", "0.3.0")).toBe(false)
  })

  it("empty string treated as 0.0.0", () => {
    expect(isNewer("", "0.3.9")).toBe(false)
    expect(isNewer("0.3.9", "")).toBe(true)
  })
})
