/**
 * M2 — the execution-level differential over the corpus
 * (pattern-engine-ideal-state.md §12.2, §13.5): for every cell whose compile
 * dump is already equal (M1), the pattern executor and today's
 * OperationExecutor run the same payload on two simulated drivers with the
 * same script; the comparison is the statement trace (SQL, params, phase,
 * attribution, lifecycle) and the settled outcome.
 *
 * Dashboard like M1: always completes, prints per-class counts and the first
 * difference per payload; PATTERN_M2_STRICT=1 gates; PATTERN_M1_FILTER and
 * PATTERN_M1_REPORT apply.
 */
import { writeFileSync } from "node:fs";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { decodeRows, expectedShapeOf } from "@src/query-engine/pattern/decode";
import { execute } from "@src/query-engine/pattern/execute";
import type { Program } from "@src/query-engine/pattern/fragment";
import type { Pattern } from "@src/query-engine/pattern/pattern";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { isRecordSeries } from "@src/query-engine/write-engine/record-series";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import { type CorpusPayload, payloads } from "@tests/pattern/corpus/payloads";
import {
  type KnownWorld,
  oracleFor,
  type Substrate,
  selectAliases,
  sentinelFor,
} from "@tests/pattern/harness/dump";
import {
  CAPABILITY_PRESETS,
  type Row,
  type ScriptedStatement,
  SimulatedDriver,
} from "@tests/pattern/sim/simulated-driver";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import {
  errorOf,
  packCell,
  scheduleCell,
  schemaOf,
  WRITE_OPERATIONS,
} from "./chain";
import { runCell } from "./compile-cell";

const DIALECTS: readonly PlanningDialect[] = ["postgresql", "mysql", "sqlite"];
const SUBSTRATES: readonly Substrate[] = ["transaction", "batch"];
const WORLDS: readonly KnownWorld[] = ["found", "missing"];

/** Today's driver rows per (dialect, substrate). */
const PRESET = {
  postgresql: { transaction: "postgres", batch: "neonHttp" },
  mysql: { transaction: "mysql", batch: "planetscale" },
  sqlite: { transaction: "sqlite", batch: "d1" },
} as const;

type Settled =
  | { readonly status: "ok"; readonly value: unknown }
  | {
      readonly status: "error";
      readonly error: { name: string; message: string };
    };

type Outcome =
  | { readonly kind: "equal" }
  | { readonly kind: "not-compile-equal" }
  | { readonly kind: "series-skipped" }
  | { readonly kind: "trace"; readonly detail: string }
  | { readonly kind: "outcome"; readonly detail: string }
  | { readonly kind: "crash"; readonly detail: string };

interface CellResult {
  readonly payload: string;
  readonly dialect: PlanningDialect;
  readonly substrate: Substrate;
  readonly world: KnownWorld;
  readonly outcome: Outcome;
}

function settle<T>(promise: Promise<T>): Promise<Settled> {
  return promise.then(
    (value) => ({ status: "ok" as const, value }),
    (error: unknown) => ({ status: "error" as const, error: errorOf(error) })
  );
}

async function runExecution(
  payload: CorpusPayload,
  dialect: PlanningDialect,
  substrate: Substrate,
  world: KnownWorld
): Promise<Outcome> {
  const { schema, model } = schemaOf(payload);
  const oracle = oracleFor(schema, dialect, substrate);
  const capabilities = CAPABILITY_PRESETS[PRESET[dialect][substrate]];
  // Found world: every read finds one row carrying its select list with the
  // harness's typed sentinels; missing world: reads find nothing.
  // ponytail: no cell store yet — the script answers by select list only.
  const rows = (statement: ScriptedStatement): Row[] => {
    if (world === "missing") return [];
    const aliases = selectAliases(statement.sql);
    return [
      Object.fromEntries(
        aliases.map((alias, index) => [
          alias,
          sentinelFor(oracle, statement.model, alias, `sim.${index}`, 0),
        ])
      ),
    ];
  };
  const make = () =>
    new SimulatedDriver({ dialect, capabilities, script: { rows } });
  const mine = make();
  const theirs = make();
  const context = createOperationExecutionContext(
    payload.model,
    payload.operation
  );

  const todaysEngine = new QueryEngine(
    theirs as never,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  // Today's construction may refuse before any statement (validation, nested
  // dependency); that refusal is an outcome, compared like any other.
  let series = false;
  const todays = await settle(
    (async () => {
      const routed = constructRoutedOperation(
        todaysEngine,
        model,
        payload.operation,
        payload.args
      );
      if (!routed) throw new Error("not a routed operation");
      if (isRecordSeries(routed)) {
        series = true;
        return undefined;
      }
      return new OperationExecutor(todaysEngine).execute(routed, context);
    })()
  );
  if (series) return { kind: "series-skipped" };

  const myEngine = new QueryEngine(
    mine as never,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  // Today's executor returns the DECODED public result; the pattern engine
  // returns the program's outputs, which unit G decodes. Compare like with
  // like: decode ours, and hand the executor the projection's expected row
  // keys so a malformed provider row is refused on both sides.
  let pattern: Pattern | undefined;
  const ours = await settle(
    (async () => {
      const program = packCell(
        scheduleCell(payload, myEngine, dialect, substrate, (p) => {
          pattern = p;
        }),
        myEngine
      );
      const boundary = {
        adapter: myEngine.adapter,
        relations: myEngine.relations,
        driver: mine as never,
      };
      const outputs = await execute(program, mine as never, {
        execution: context,
        retry: false,
        expectedRows: expectedRowsOf(pattern, boundary, program),
      });
      return pattern
        ? decodeRows(pattern, terminalRows(outputs), boundary)
        : outputs;
    })()
  );

  const traceMine = mine.trace();
  const traceTheirs = theirs.trace();
  if (JSON.stringify(traceMine) !== JSON.stringify(traceTheirs)) {
    const at = traceMine.findIndex((line, i) => line !== traceTheirs[i]);
    return {
      kind: "trace",
      detail: `#${at}: today ${traceTheirs[at] ?? "<end>"} | mine ${traceMine[at] ?? "<end>"}`,
    };
  }
  if (JSON.stringify(ours) !== JSON.stringify(todays)) {
    return {
      kind: "outcome",
      detail: `today ${JSON.stringify(todays).slice(0, 160)} | mine ${JSON.stringify(ours).slice(0, 160)}`,
    };
  }
  return { kind: "equal" };
}

/** The rows the terminal read published, as `decodeRows` consumes them. */
function terminalRows(outputs: Readonly<Record<string, unknown>>): unknown {
  const values = Object.values(outputs);
  return values.length === 1 ? values[0] : outputs;
}

/** The projection's raw keys per published step, so a malformed row is refused. */
function expectedRowsOf(
  pattern: Pattern | undefined,
  boundary: Parameters<typeof expectedShapeOf>[1],
  program: Program
): Readonly<Record<string, readonly string[]>> | undefined {
  if (!pattern) return undefined;
  const keys = [...expectedShapeOf(pattern, boundary).rawKeys];
  if (keys.length === 0) return undefined;
  const expected: Record<string, readonly string[]> = {};
  for (const source of Object.values(program.outputs)) {
    for (const reference of Array.isArray(source) ? source : [source]) {
      expected[reference.step] = keys;
    }
  }
  return expected;
}

function summarize(results: readonly CellResult[]): string {
  const counts = new Map<string, number>();
  for (const { outcome } of results) {
    counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
  }
  const header = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, count]) => `${key}: ${count}`)
    .join("\n");
  const byPayload = new Map<string, string[]>();
  for (const r of results) {
    if (!("detail" in r.outcome)) continue;
    const lines = byPayload.get(r.payload) ?? [];
    lines.push(
      `${r.dialect}/${r.substrate}/${r.world}: ${r.outcome.kind} — ${r.outcome.detail.slice(0, 240)}`
    );
    byPayload.set(r.payload, lines);
  }
  const detail = [...byPayload.entries()]
    .map(
      ([name, lines]) => `${name}\n${lines.map((l) => `    ${l}`).join("\n")}`
    )
    .join("\n");
  return `${header}\n\n${detail}`;
}

describe("M2 execution-level differential over the corpus", () => {
  test("every compile-equal cell runs both engines on the simulated driver", async () => {
    const filter = process.env.PATTERN_M1_FILTER
      ? new RegExp(process.env.PATTERN_M1_FILTER)
      : undefined;
    const results: CellResult[] = [];
    for (const payload of payloads) {
      if (!WRITE_OPERATIONS.has(payload.operation)) continue;
      if (filter && !filter.test(payload.name)) continue;
      for (const dialect of DIALECTS) {
        for (const substrate of SUBSTRATES) {
          for (const world of WORLDS) {
            let outcome: Outcome;
            try {
              const compiled = runCell(payload, dialect, substrate, world);
              outcome =
                compiled.kind === "equal"
                  ? await runExecution(payload, dialect, substrate, world)
                  : { kind: "not-compile-equal" };
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
    console.log(`M2 differential — ${results.length} cells\n${text}`);
    if (process.env.PATTERN_M1_REPORT) {
      writeFileSync(
        `${process.env.PATTERN_M1_REPORT}.m2.json`,
        JSON.stringify(results, null, 2)
      );
    }
    expect(results.length).toBeGreaterThan(0);
    if (process.env.PATTERN_M2_STRICT) {
      expect(results.filter((r) => "detail" in r.outcome)).toEqual([]);
    }
  }, 600_000);
});
