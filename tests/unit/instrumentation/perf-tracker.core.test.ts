import {
  createPerfTracker,
  formatPerfReport,
  noopTracker,
  type PerfReport,
} from "@src/instrumentation/perf-tracker";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic clock over `performance.now()`. `createPerfTracker` reads the
 * clock on every start/end, so we drive it from a queue instead of the real
 * wall clock — no sleeps, exact durations.
 */
function fakeClock(values: number[]): () => void {
  let i = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => {
    const v = values[Math.min(i, values.length - 1)] ?? 0;
    i += 1;
    return v;
  });
  return () => spy.mockRestore();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPerfTracker - start/end", () => {
  it("records a positive durationMs for a single root entry", () => {
    // start reads 100, end reads 105 → 5ms
    const restore = fakeClock([100, 105]);
    const tracker = createPerfTracker();
    tracker.start("validate");
    tracker.end("validate");
    restore();

    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.name).toBe("validate");
    expect(raw[0]!.durationMs).toBe(5);

    const report = tracker.report();
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      name: "validate",
      durationMs: 5,
      depth: 0,
    });
  });

  it("nests b under a: start(a) start(b) end(b) end(a)", () => {
    // a.start=0, b.start=1, b.end=3, a.end=10
    const restore = fakeClock([0, 1, 3, 10]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.start("b");
    tracker.end("b");
    tracker.end("a");
    restore();

    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.name).toBe("a");
    expect(raw[0]!.children).toHaveLength(1);
    expect(raw[0]!.children[0]!.name).toBe("b");

    const report = tracker.report();
    expect(report.entries.map((e) => [e.name, e.depth])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    // a = 10, b = 2
    expect(report.entries[0]!.durationMs).toBe(10);
    expect(report.entries[1]!.durationMs).toBe(2);
  });

  it("end with a mismatched name warns and does not record", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const restore = fakeClock([0, 5]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.end("b"); // mismatch: popped entry name is "a"
    restore();

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain("Mismatched end('b')");
    expect(msg).toContain("expected 'a'");

    // The popped entry "a" was never given an end time.
    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.durationMs).toBe(0);
    expect(raw[0]!.endNs).toBe(0);
  });

  it("end on an empty stack warns with expected 'none'", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const restore = fakeClock([0]);
    const tracker = createPerfTracker();
    tracker.end("ghost");
    restore();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0] as string).toContain("expected 'none'");
    expect(tracker.entries()).toHaveLength(0);
  });
});

describe("createPerfTracker - measure / measureAsync", () => {
  it("measure runs the fn, returns its value, and records", () => {
    const restore = fakeClock([0, 4]);
    const tracker = createPerfTracker();
    const result = tracker.measure("work", () => 42);
    restore();

    expect(result).toBe(42);
    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.name).toBe("work");
    expect(raw[0]!.durationMs).toBe(4);
  });

  it("measure records even when fn throws, then rethrows", () => {
    const restore = fakeClock([0, 4]);
    const tracker = createPerfTracker();
    const boom = new Error("boom");
    expect(() =>
      tracker.measure("work", () => {
        throw boom;
      })
    ).toThrow(boom);
    restore();

    // finally { end } still recorded the entry.
    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.name).toBe("work");
    expect(raw[0]!.durationMs).toBe(4);
  });

  it("measureAsync awaits, returns value, and records duration", async () => {
    const restore = fakeClock([0, 7]);
    const tracker = createPerfTracker();
    const result = await tracker.measureAsync("aio", async () => "ok");
    restore();

    expect(result).toBe("ok");
    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.name).toBe("aio");
    expect(raw[0]!.durationMs).toBe(7);
  });

  it("measureAsync records on throw (finally) then rethrows", async () => {
    const restore = fakeClock([0, 7]);
    const tracker = createPerfTracker();
    const boom = new Error("async boom");
    await expect(
      tracker.measureAsync("aio", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    restore();

    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.durationMs).toBe(7);
  });
});

describe("createPerfTracker - report aggregation", () => {
  it("totalMs sums ROOT entry durations only (no double-counting children)", () => {
    // root a: 0..10 (with child b 1..3), root c: 10..14
    const restore = fakeClock([0, 1, 3, 10, 10, 14]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.start("b");
    tracker.end("b");
    tracker.end("a"); // a = 10
    tracker.start("c");
    tracker.end("c"); // c = 4
    restore();

    const report = tracker.report();
    // total = a(10) + c(4) = 14; child b(2) NOT added.
    expect(report.totalMs).toBe(14);
  });

  it("percent is relative to totalMs and depth is correct", () => {
    const restore = fakeClock([0, 1, 3, 10]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.start("b");
    tracker.end("b");
    tracker.end("a");
    restore();

    const report = tracker.report();
    const a = report.entries[0]!;
    const b = report.entries[1]!;
    // totalMs = a's root duration = 10.
    expect(report.totalMs).toBe(10);
    expect(a.percent).toBeCloseTo(100, 5); // 10/10
    expect(b.percent).toBeCloseTo(20, 5); // 2/10
    expect(a.depth).toBe(0);
    expect(b.depth).toBe(1);
  });

  it("percent is 0 for every entry when totalMs is 0", () => {
    // All timestamps identical → every duration is 0 → totalMs 0.
    const restore = fakeClock([5, 5, 5, 5]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.start("b");
    tracker.end("b");
    tracker.end("a");
    restore();

    const report = tracker.report();
    expect(report.totalMs).toBe(0);
    expect(report.entries.every((e) => e.percent === 0)).toBe(true);
  });

  it("breakdown aggregates same-named entries: count, totalMs, avgMs", () => {
    // two "db" root entries: 0..2 and 2..8 → durations 2 and 6
    const restore = fakeClock([0, 2, 2, 8]);
    const tracker = createPerfTracker();
    tracker.start("db");
    tracker.end("db");
    tracker.start("db");
    tracker.end("db");
    restore();

    const report = tracker.report();
    expect(report.breakdown.db).toEqual({
      totalMs: 8, // 2 + 6
      count: 2,
      avgMs: 4, // 8 / 2
    });
  });

  it("breakdown includes nested (child) entries too", () => {
    const restore = fakeClock([0, 1, 3, 10]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.start("b");
    tracker.end("b");
    tracker.end("a");
    restore();

    const report = tracker.report();
    expect(Object.keys(report.breakdown).sort()).toEqual(["a", "b"]);
    expect(report.breakdown.a!.count).toBe(1);
    expect(report.breakdown.b!.count).toBe(1);
    expect(report.breakdown.b!.totalMs).toBe(2);
  });

  it("entries() returns raw root entries carrying nested children", () => {
    const restore = fakeClock([0, 1, 3, 10]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.start("b");
    tracker.end("b");
    tracker.end("a");
    restore();

    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.children[0]!.name).toBe("b");
    // parent linkage present on the raw structure.
    expect(raw[0]!.children[0]!.parent).toBe(raw[0]);
  });
});

describe("createPerfTracker - reset / isEnabled / disabled", () => {
  it("reset clears root entries, active stack, and pending starts", () => {
    const restore = fakeClock([0, 5, 10, 20]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.end("a");
    tracker.reset();

    expect(tracker.entries()).toHaveLength(0);
    expect(tracker.report()).toEqual({
      totalMs: 0,
      entries: [],
      breakdown: {},
    });

    // Active stack was cleared: a fresh start/end works cleanly (no leftover
    // parent) and produces a new root entry.
    tracker.start("b");
    tracker.end("b");
    restore();
    const raw = tracker.entries();
    expect(raw).toHaveLength(1);
    expect(raw[0]!.name).toBe("b");
    expect(raw[0]!.parent).toBeUndefined();
  });

  it("isEnabled reflects the constructor flag", () => {
    expect(createPerfTracker().isEnabled()).toBe(true);
    expect(createPerfTracker(true).isEnabled()).toBe(true);
    expect(createPerfTracker(false).isEnabled()).toBe(false);
  });

  it("disabled tracker: start/end/measure/measureAsync are pass-throughs", async () => {
    const now = vi.spyOn(performance, "now");
    const tracker = createPerfTracker(false);

    tracker.start("x");
    tracker.end("x");
    const sync = tracker.measure("y", () => 99);
    const async = await tracker.measureAsync("z", async () => "async-val");

    // fn values still returned.
    expect(sync).toBe(99);
    expect(async).toBe("async-val");
    // nothing recorded, clock never consulted.
    expect(tracker.report()).toEqual({
      totalMs: 0,
      entries: [],
      breakdown: {},
    });
    expect(tracker.entries()).toHaveLength(0);
    expect(tracker.isEnabled()).toBe(false);
    expect(now).not.toHaveBeenCalled();
  });
});

describe("formatPerfReport", () => {
  it("contains total line, per-entry timeline (indented by depth), and sorted breakdown", () => {
    const restore = fakeClock([0, 1, 3, 10, 10, 14]);
    const tracker = createPerfTracker();
    tracker.start("a");
    tracker.start("b");
    tracker.end("b");
    tracker.end("a"); // a=10, b=2
    tracker.start("c");
    tracker.end("c"); // c=4
    restore();

    const out = formatPerfReport(tracker.report());

    // Total line: total = a(10) + c(4) = 14.
    expect(out).toContain("Total: 14.000ms");

    // Timeline: one line per entry, child "b" indented (depth 1 → 2 spaces).
    expect(out).toContain("Timeline:");
    const lines = out.split("\n");
    const bLine = lines.find((l) => l.includes("b:"));
    expect(bLine).toBeDefined();
    expect(bLine?.startsWith("  b:")).toBe(true); // 2-space indent for depth 1
    const aLine = lines.find((l) => l.trimStart().startsWith("a:"));
    expect(aLine?.startsWith("a:")).toBe(true); // depth 0, no indent

    // ms + percent rendered per entry.
    expect(aLine).toContain("ms");
    expect(aLine).toContain("%");

    // Breakdown sorted by descending totalMs: a(10) > c(4) > b(2).
    const breakdownIdx = out.indexOf("Breakdown by category:");
    const breakdownPart = out.slice(breakdownIdx);
    const aPos = breakdownPart.indexOf("a:");
    const cPos = breakdownPart.indexOf("c:");
    const bPos = breakdownPart.indexOf("b:");
    expect(aPos).toBeGreaterThanOrEqual(0);
    expect(aPos).toBeLessThan(cPos);
    expect(cPos).toBeLessThan(bPos);

    // Breakdown line format includes count and avg.
    expect(breakdownPart).toContain("1x");
    expect(breakdownPart).toContain("avg");
  });

  it("does not throw on an empty report (totalMs 0)", () => {
    const empty: PerfReport = { totalMs: 0, entries: [], breakdown: {} };
    expect(() => formatPerfReport(empty)).not.toThrow();
    const out = formatPerfReport(empty);
    expect(out).toContain("Total: 0.000ms");
    // Empty breakdown avoids the divide-by-zero in the breakdown percent.
    expect(out).toContain("Breakdown by category:");
  });
});

describe("noopTracker", () => {
  it("measure / measureAsync return the fn value", async () => {
    expect(noopTracker.measure("x", () => 7)).toBe(7);
    await expect(noopTracker.measureAsync("y", async () => "v")).resolves.toBe(
      "v"
    );
  });

  it("report is empty, entries empty, isEnabled false", () => {
    expect(noopTracker.report()).toEqual({
      totalMs: 0,
      entries: [],
      breakdown: {},
    });
    expect(noopTracker.entries()).toEqual([]);
    expect(noopTracker.isEnabled()).toBe(false);
  });

  it("start / end / reset are safe no-ops", () => {
    expect(() => {
      noopTracker.start("x");
      noopTracker.end("x");
      noopTracker.reset();
    }).not.toThrow();
    // Still records nothing.
    expect(noopTracker.entries()).toEqual([]);
  });
});
