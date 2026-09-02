/**
 * M1 over GENERATED payloads (pattern-engine-ideal-state.md §13.3 unit B,
 * §13.5): a seeded corpus per schema goes through the same compile-level
 * differential as the hand-written corpus. Same dashboard contract:
 * PATTERN_M1_STRICT=1 gates, PATTERN_M1_REPORT writes `<path>.fuzz.json`,
 * PATTERN_FUZZ_SEED / PATTERN_FUZZ_COUNT size the corpus (default 20240902 / 60
 * per schema).
 */
import { writeFileSync } from "node:fs";
import type { Model } from "@schema/model";
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import type { CorpusPayload } from "@tests/pattern/corpus/payloads";
import { type SchemaName, schemas } from "@tests/pattern/corpus/schemas";
import { generateCorpus } from "@tests/pattern/generator/generate";
import type { KnownWorld, Substrate } from "@tests/pattern/harness/dump";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { errorOf, WRITE_OPERATIONS } from "./chain";
import { type CellResult, type Outcome, runCell } from "./compile-cell";

const DIALECTS: readonly PlanningDialect[] = ["postgresql", "mysql", "sqlite"];
const SUBSTRATES: readonly Substrate[] = ["transaction", "batch"];
const WORLDS: readonly KnownWorld[] = ["found", "missing"];
const SEED = Number(process.env.PATTERN_FUZZ_SEED ?? 20_240_902);
const COUNT = Number(process.env.PATTERN_FUZZ_COUNT ?? 60);

function generated(): CorpusPayload[] {
  const out: CorpusPayload[] = [];
  for (const name of Object.keys(schemas) as SchemaName[]) {
    const schema = schemas[name] as Record<string, Model<any>>;
    const registry = createSchemaRegistry(schema);
    for (const payload of generateCorpus(schema, registry, SEED, COUNT)) {
      if (!WRITE_OPERATIONS.has(payload.operation)) continue;
      out.push({
        name: `fuzz:${name}:${payload.seed}:${payload.model}.${payload.operation}`,
        schema: name,
        model: payload.model,
        operation: payload.operation,
        args: payload.args,
      });
    }
  }
  return out;
}

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
  const firsts = new Map<string, string>();
  for (const r of results) {
    if (r.outcome.kind === "equal" || firsts.has(r.payload)) continue;
    firsts.set(
      r.payload,
      r.outcome.kind === "steps"
        ? `${r.outcome.differences[0]?.kind}: ${r.outcome.differences[0]?.detail.slice(0, 140)}`
        : `${r.outcome.kind}: ${r.outcome.detail.slice(0, 160)}`
    );
  }
  const detail = [...firsts.entries()]
    .map(([name, line]) => `${name}\n    ${line}`)
    .join("\n");
  return `${header}\n\n${detail}`;
}

describe("M1 compile-level differential over generated payloads", () => {
  test("seeded corpus × dialect × substrate × world", () => {
    const results: CellResult[] = [];
    for (const payload of generated()) {
      for (const dialect of DIALECTS) {
        for (const substrate of SUBSTRATES) {
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
      }
    }
    const text = summarize(results);
    // eslint-disable-next-line no-console
    console.log(`M1 fuzz differential — ${results.length} cells\n${text}`);
    if (process.env.PATTERN_M1_REPORT) {
      writeFileSync(
        `${process.env.PATTERN_M1_REPORT}.fuzz.json`,
        JSON.stringify(results, null, 2)
      );
    }
    expect(results.length).toBeGreaterThan(0);
    if (process.env.PATTERN_M1_STRICT) {
      expect(results.filter((r) => r.outcome.kind !== "equal")).toEqual([]);
    }
  }, 600_000);
});
