/**
 * Performance Tracker
 *
 * Lightweight performance measurement utility for understanding
 * where time is spent in the query engine.
 *
 * Usage:
 *   const tracker = createPerfTracker();
 *   tracker.start('validation');
 *   // ... validation code
 *   tracker.end('validation');
 *   tracker.start('build');
 *   // ... build code
 *   tracker.end('build');
 *   console.log(tracker.report());
 */

export interface PerfEntry {
  /** Name/label for this measurement */
  name: string;
  /** Start time in nanoseconds (from performance.now()) */
  startNs: number;
  /** End time in nanoseconds */
  endNs: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Nested measurements */
  children: PerfEntry[];
  /** Parent measurement */
  parent?: PerfEntry;
}

export interface PerfReport {
  /** Total duration in milliseconds */
  totalMs: number;
  /** All entries in order */
  entries: PerfEntryReport[];
  /** Breakdown by category */
  breakdown: Record<string, { totalMs: number; count: number; avgMs: number }>;
}

export interface PerfEntryReport {
  name: string;
  durationMs: number;
  percent: number;
  depth: number;
}

export interface PerfTracker {
  /** Start a new measurement */
  start(name: string): void;
  /** End the current measurement */
  end(name: string): void;
  /** Wrap a sync function with measurement */
  measure<T>(name: string, fn: () => T): T;
  /** Wrap an async function with measurement */
  measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Get the performance report */
  report(): PerfReport;
  /** Get raw entries */
  entries(): PerfEntry[];
  /** Reset the tracker */
  reset(): void;
  /** Check if tracking is enabled */
  isEnabled(): boolean;
}

/**
 * Create a performance tracker instance
 */
export function createPerfTracker(enabled = true): PerfTracker {
  const rootEntries: PerfEntry[] = [];
  const activeStack: PerfEntry[] = [];
  const pendingStarts: Map<string, number> = new Map();

  function start(name: string): void {
    if (!enabled) return;

    const startNs = performance.now();
    pendingStarts.set(name, startNs);

    const entry: PerfEntry = {
      name,
      startNs,
      endNs: 0,
      durationMs: 0,
      children: [],
      parent: activeStack[activeStack.length - 1],
    };

    if (entry.parent) {
      entry.parent.children.push(entry);
    } else {
      rootEntries.push(entry);
    }

    activeStack.push(entry);
  }

  function end(name: string): void {
    if (!enabled) return;

    const endNs = performance.now();
    const entry = activeStack.pop();

    if (!entry || entry.name !== name) {
      console.warn(
        `PerfTracker: Mismatched end('${name}'), expected '${entry?.name ?? "none"}'`
      );
      return;
    }

    entry.endNs = endNs;
    entry.durationMs = endNs - entry.startNs;
    pendingStarts.delete(name);
  }

  function measure<T>(name: string, fn: () => T): T {
    if (!enabled) return fn();

    start(name);
    try {
      return fn();
    } finally {
      end(name);
    }
  }

  async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!enabled) return fn();

    start(name);
    try {
      return await fn();
    } finally {
      end(name);
    }
  }

  function collectEntries(
    entries: PerfEntry[],
    depth: number,
    result: PerfEntryReport[],
    totalMs: number
  ): void {
    for (const entry of entries) {
      result.push({
        name: entry.name,
        durationMs: entry.durationMs,
        percent: totalMs > 0 ? (entry.durationMs / totalMs) * 100 : 0,
        depth,
      });
      collectEntries(entry.children, depth + 1, result, totalMs);
    }
  }

  function report(): PerfReport {
    // Calculate total from root entries
    let totalMs = 0;
    for (const entry of rootEntries) {
      totalMs += entry.durationMs;
    }

    // Collect all entries with depth
    const entries: PerfEntryReport[] = [];
    collectEntries(rootEntries, 0, entries, totalMs);

    // Build breakdown by name
    const breakdown: Record<
      string,
      { totalMs: number; count: number; avgMs: number }
    > = {};

    function collectBreakdown(items: PerfEntry[]): void {
      for (const entry of items) {
        const existing = breakdown[entry.name];
        if (existing) {
          existing.totalMs += entry.durationMs;
          existing.count += 1;
          existing.avgMs = existing.totalMs / existing.count;
        } else {
          breakdown[entry.name] = {
            totalMs: entry.durationMs,
            count: 1,
            avgMs: entry.durationMs,
          };
        }
        collectBreakdown(entry.children);
      }
    }

    collectBreakdown(rootEntries);

    return { totalMs, entries, breakdown };
  }

  function getEntries(): PerfEntry[] {
    return rootEntries;
  }

  function reset(): void {
    rootEntries.length = 0;
    activeStack.length = 0;
    pendingStarts.clear();
  }

  function isEnabled(): boolean {
    return enabled;
  }

  return {
    start,
    end,
    measure,
    measureAsync,
    report,
    entries: getEntries,
    reset,
    isEnabled,
  };
}

/**
 * Format a perf report for console output
 */
export function formatPerfReport(report: PerfReport): string {
  const lines: string[] = [];

  lines.push(`\n=== Performance Report ===`);
  lines.push(`Total: ${report.totalMs.toFixed(3)}ms\n`);

  // Timeline view
  lines.push("Timeline:");
  for (const entry of report.entries) {
    const indent = "  ".repeat(entry.depth);
    const percent = entry.percent.toFixed(1).padStart(5);
    const duration = entry.durationMs.toFixed(3).padStart(8);
    lines.push(`${indent}${entry.name}: ${duration}ms (${percent}%)`);
  }

  // Breakdown view
  lines.push("\nBreakdown by category:");
  const sorted = Object.entries(report.breakdown).sort(
    ([, a], [, b]) => b.totalMs - a.totalMs
  );
  for (const [name, stats] of sorted) {
    const percent = ((stats.totalMs / report.totalMs) * 100).toFixed(1);
    lines.push(
      `  ${name}: ${stats.totalMs.toFixed(3)}ms total (${percent}%), ${stats.count}x, avg ${stats.avgMs.toFixed(3)}ms`
    );
  }

  return lines.join("\n");
}

/**
 * No-op tracker for when tracking is disabled
 */
export const noopTracker: PerfTracker = {
  start: () => {},
  end: () => {},
  measure: <T>(_name: string, fn: () => T) => fn(),
  measureAsync: <T>(_name: string, fn: () => Promise<T>) => fn(),
  report: () => ({ totalMs: 0, entries: [], breakdown: {} }),
  entries: () => [],
  reset: () => {},
  isEnabled: () => false,
};
