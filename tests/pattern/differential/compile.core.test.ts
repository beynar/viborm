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
import type { Model } from "@schema/model";
import {
  constructPattern,
  type DeferredRefusal,
  type WriteOperation,
} from "@src/query-engine/pattern/construct";
import { StepIds } from "@src/query-engine/pattern/ids";
import { pack } from "@src/query-engine/pattern/pack";
import { schedule } from "@src/query-engine/pattern/schedule";
import { parseValidated } from "@src/query-engine/write-engine/parse-boundary";
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import { type CorpusPayload, payloads } from "@tests/pattern/corpus/payloads";
import { schemas } from "@tests/pattern/corpus/schemas";
import {
  type Dump,
  dumpOperation,
  engineFor,
  type KnownWorld,
  oracleFor,
  planningDriver,
  type Substrate,
  synthesizeKnown,
} from "@tests/pattern/harness/dump";
import {
  diffSteps,
  dumpProgram,
  type StepDifference,
} from "@tests/pattern/pack/program-dump";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const WRITE_OPERATIONS = new Set<string>([
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "createManyAndReturn",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
  "deleteManyAndReturn",
]);
const DIALECTS: readonly PlanningDialect[] = ["postgresql", "mysql", "sqlite"];
const SUBSTRATES: readonly Substrate[] = ["transaction", "batch"];
const WORLDS: readonly KnownWorld[] = ["found", "missing"];

type Outcome =
  | { readonly kind: "equal" }
  | { readonly kind: "series-skipped" }
  | { readonly kind: "steps"; readonly differences: readonly StepDifference[] }
  | { readonly kind: "error-identity"; readonly detail: string }
  | { readonly kind: "crash"; readonly detail: string };

interface CellResult {
  readonly payload: string;
  readonly dialect: PlanningDialect;
  readonly substrate: Substrate;
  readonly world: KnownWorld;
  readonly outcome: Outcome;
}

function raise(refusal: DeferredRefusal): never {
  // ponytail: name + message is what the differential compares; the exact
  // class (and code) is a packing concern the raiser owns.
  const error = new Error(refusal.message);
  error.name = refusal.error;
  throw error;
}

function errorOf(e: unknown): { name: string; message: string } {
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: "unknown", message: String(e) };
}

function runCell(
  payload: CorpusPayload,
  dialect: PlanningDialect,
  substrate: Substrate,
  world: KnownWorld
): Outcome {
  const schema = schemas[payload.schema] as Record<string, Model<any>>;
  const model = schema[payload.model] as Model<any>;
  const oracle: Dump = dumpOperation(
    schema,
    model,
    payload.model,
    payload.operation,
    payload.args,
    dialect,
    substrate,
    world,
    payload.options
  );
  if (oracle.kind === "recordSeries") return { kind: "series-skipped" };

  let mine: ReturnType<typeof dumpProgram> | undefined;
  let failure: { name: string; message: string } | undefined;
  try {
    const registry = createSchemaRegistry(schema);
    const args = parseValidated(
      Reflect.get(registry.getModelSchemas(model).args, payload.operation),
      payload.args,
      payload.operation as never,
      ""
    ) as Record<string, unknown>;
    const driver = planningDriver(dialect, substrate);
    const engine = engineFor(schema, driver);
    const { pattern, deferredRefusals } = constructPattern({
      index: engine.relations,
      model,
      operation: payload.operation as WriteOperation,
      validatedArgs: args,
    });
    const scheduled = schedule(
      pattern,
      {
        bindsGeneratedKey: dialect === "mysql" ? "insertId" : "returning",
        supportsTransactions: substrate === "transaction",
      },
      deferredRefusals.map((refusal) => () => raise(refusal))
    );
    const planned = pack(scheduled, engine, new StepIds());
    const known = synthesizeKnown(
      oracleFor(schema, dialect, substrate),
      { steps: planned.fragments.flatMap((f) => f.matches.flat()) },
      world
    );
    mine = dumpProgram(driver, pack(scheduled, engine, new StepIds(), known));
  } catch (e) {
    failure = errorOf(e);
  }

  if (oracle.error || failure) {
    const same =
      oracle.error?.name === failure?.name &&
      oracle.error?.message === failure?.message;
    if (same) return { kind: "equal" };
    return {
      kind: "error-identity",
      detail: `oracle ${oracle.error ? `${oracle.error.name}: ${oracle.error.message}` : "ok"} vs mine ${failure ? `${failure.name}: ${failure.message}` : "ok"}`,
    };
  }
  if (!mine) return { kind: "crash", detail: "no program and no error" };
  const differences = [
    ...diffSteps("planning", oracle.planning, mine.planning),
    ...diffSteps("final", oracle.final, mine.final),
  ];
  return differences.length === 0
    ? { kind: "equal" }
    : { kind: "steps", differences };
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
  const byPayload = new Map<string, string[]>();
  for (const r of results) {
    if (r.outcome.kind === "equal" || r.outcome.kind === "series-skipped")
      continue;
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
      expect(
        results.filter(
          (r) =>
            r.outcome.kind !== "equal" && r.outcome.kind !== "series-skipped"
        )
      ).toEqual([]);
    }
  }, 600_000);
});
