import { describe, it, expect } from "vitest";
import { shouldSampleAt } from "../logger";

describe("shouldSampleAt", () => {
  it("allows all when threshold is Infinity", () => {
    const r1 = shouldSampleAt("DEBUG", 1000, 0, 0, Infinity);
    const r2 = shouldSampleAt("INFO", 1000, 0, 50, Infinity);
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(true);
  });

  it("never drops ERROR regardless of threshold", () => {
    const r = shouldSampleAt("ERROR", 1000, 0, 999, 2);
    expect(r.allow).toBe(true);
  });

  it("drops non-ERROR beyond threshold within window", () => {
    const r1 = shouldSampleAt("DEBUG", 500, 0, 0, 2);
    expect(r1.allow).toBe(true);
    expect(r1.newWindowCount).toBe(1);
    const r2 = shouldSampleAt("DEBUG", 600, 0, 1, 2);
    expect(r2.allow).toBe(true);
    expect(r2.newWindowCount).toBe(2);
    const r3 = shouldSampleAt("INFO", 700, 0, 2, 2);
    expect(r3.allow).toBe(false);
    expect(r3.newWindowCount).toBe(3);
  });

  it("resets window after 1 second", () => {
    const r = shouldSampleAt("DEBUG", 1001, 0, 2, 2);
    expect(r.allow).toBe(true);
    expect(r.newWindowStart).toBe(1001);
    expect(r.newWindowCount).toBe(1);
  });

  it("counts DEBUG and INFO against shared global bucket", () => {
    const r1 = shouldSampleAt("DEBUG", 500, 0, 0, 2);
    expect(r1.allow).toBe(true);
    const r2 = shouldSampleAt("DEBUG", 510, 0, r1.newWindowCount, 2);
    expect(r2.allow).toBe(true);
    const r3 = shouldSampleAt("INFO", 520, 0, r2.newWindowCount, 2);
    expect(r3.allow).toBe(false);
  });
});
