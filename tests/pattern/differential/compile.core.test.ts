/**
 * M1 — the compile-level differential over the whole corpus
 * (pattern-engine-ideal-state.md §12.1, §13.5): every corpus payload × dialect
 * × substrate × world, constructed (C) → scheduled (D) → packed (E) → dumped in
 * K4 form and compared step by step with today's engine's dump.
 *
 * This is the dashboard, not a gate: it always runs to completion and prints
 * the four numbers per divergence class plus the per-payload detail (and
 * writes them as JSON to PATTERN_M1_REPORT when set). Set PATTERN_M1_STRICT=1
 * to make any divergence fail the run — the M1 exit criterion.
 * PATTERN_M1_FILTER=<regex> restricts the run to matching payload names.
 */
import { writeFileSync } from "node:fs";
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import { payloads } from "@tests/pattern/corpus/payloads";
import type { KnownWorld, Substrate } from "@tests/pattern/harness/dump";
import { describe, expect, test } from "vitest";
import { errorOf, WRITE_OPERATIONS } from "./chain";
import { type CellResult, type Outcome, runCell } from "./compile-cell";

const DIALECTS: readonly PlanningDialect[] = ["postgresql", "mysql", "sqlite"];
const SUBSTRATES: readonly Substrate[] = ["transaction", "batch"];
const WORLDS: readonly KnownWorld[] = ["found", "missing"];

function summarize(results: readonly CellResult[]): string {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const { outcome } of results) {
    bump(outcome.kind);
    if (outcome.kind === "steps") {
      for (const d of outcome.differences) bump(`  ${d.kind}`);
    }
  }
  const header = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, count]) => `${key}: ${count}`)
    .join("\n");
  const byPayload = new Map<string, string[]>();
  for (const r of results) {
    if (r.outcome.kind === "equal") continue;
    const line =
      r.outcome.kind === "steps"
        ? `${r.dialect}/${r.substrate}/${r.world}: ${r.outcome.differences.length} step diffs — ${r.outcome.differences[0]?.kind}: ${r.outcome.differences[0]?.detail.slice(0, 160)}`
        : `${r.dialect}/${r.substrate}/${r.world}: ${r.outcome.kind} — ${r.outcome.detail.slice(0, 200)}`;
    const lines = byPayload.get(r.payload) ?? [];
    lines.push(line);
    byPayload.set(r.payload, lines);
  }
  const detail = [...byPayload.entries()]
    .map(
      ([name, lines]) => `${name}\n${lines.map((l) => `    ${l}`).join("\n")}`
    )
    .join("\n");
  return `${header}\n\n${detail}`;
}

describe("M1 compile-level differential over the corpus", () => {
  test("every payload × dialect × substrate × world", () => {
    const results: CellResult[] = [];
    const filter = process.env.PATTERN_M1_FILTER
      ? new RegExp(process.env.PATTERN_M1_FILTER)
      : undefined;
    for (const payload of payloads) {
      if (!WRITE_OPERATIONS.has(payload.operation)) continue;
      if (filter && !filter.test(payload.name)) continue;
      for (const dialect of DIALECTS)
        for (const substrate of SUBSTRATES)
          for (const world of WORLDS) {
            let outcome: Outcome;
            try {
              outcome = runCell(payload, dialect, substrate, world);
            } catch (e) {
              outcome = { kind: "crash", detail: errorOf(e).message };
            }
            results.push({
              payload: payload.name,
              dialect,
              substrate,
              world,
              outcome,
            });
          }
    }
    const text = summarize(results);
    // eslint-disable-next-line no-console
    console.log(`M1 differential — ${results.length} cells\n${text}`);
    if (process.env.PATTERN_M1_REPORT) {
      writeFileSync(
        process.env.PATTERN_M1_REPORT,
        JSON.stringify(results, null, 2)
      );
    }
    expect(results.length).toBeGreaterThan(0);
    if (process.env.PATTERN_M1_STRICT) {
      expect(results.filter((r) => r.outcome.kind !== "equal")).toEqual([]);
    }
  }, 600_000);
});
