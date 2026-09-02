/**
 * M1 over GENERATED payloads (pattern-engine-ideal-state.md §13.3 unit B,
 * §13.5): a seeded corpus per schema goes through the same compile-level
 * differential as the hand-written corpus, and so does its SEMANTIC invalid
 * corpus — the mutants the parse boundary accepts, whose verdict is a §19
 * admit, OwnWrite legality, a packing refusal or an execution premise. Those
 * are the cells that compare REFUSALS rather than statements.
 *
 * Same dashboard contract: PATTERN_M1_STRICT=1 gates, PATTERN_M1_REPORT writes
 * `<path>.fuzz.json` and `<path>.invalid.json`, PATTERN_FUZZ_SEED /
 * PATTERN_FUZZ_COUNT size the corpus (default 20240902 / 60 per schema) and
 * PATTERN_FUZZ_INVALID_PER_STRATEGY caps mutants per strategy per schema
 * (default 5).
 */
import { writeFileSync } from "node:fs";
import type { Model } from "@schema/model";
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import type { CorpusPayload } from "@tests/pattern/corpus/payloads";
import { type SchemaName, schemas } from "@tests/pattern/corpus/schemas";
import {
  type GeneratedPayload,
  generateCorpus,
  validatePayload,
} from "@tests/pattern/generator/generate";
import {
  type InvalidPayload,
  mutate,
  type RefusalStage,
  SEMANTIC_STRATEGIES,
  type SemanticStrategy,
} from "@tests/pattern/generator/invalid";
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
const PER_STRATEGY = Number(process.env.PATTERN_FUZZ_INVALID_PER_STRATEGY ?? 5);

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

/** One semantic mutant, as a corpus cell plus the stage its label states. */
interface InvalidCell {
  readonly payload: CorpusPayload;
  readonly strategy: SemanticStrategy;
  readonly stage: RefusalStage;
}

interface StrategyTally {
  mutants: number;
  parseClean: number;
  cells: number;
  equal: number;
  errorIdentity: number;
  steps: number;
  crash: number;
}

const emptyTally = (): StrategyTally => ({
  mutants: 0,
  parseClean: 0,
  cells: 0,
  equal: 0,
  errorIdentity: 0,
  steps: 0,
  crash: 0,
});

/**
 * The semantic invalid corpus: every strategy applied to the same seeded
 * payloads, kept only when the parse boundary ACCEPTS the mutant (a mutant it
 * refuses is unit B's own contract, asserted there, and would compare two
 * identical `ValidationError`s here).
 */
function generatedInvalid(tally: Map<SemanticStrategy, StrategyTally>): {
  readonly cells: readonly InvalidCell[];
  readonly refusedByParse: number;
} {
  const cells: InvalidCell[] = [];
  let refusedByParse = 0;
  for (const name of Object.keys(schemas) as SchemaName[]) {
    const schema = schemas[name] as Record<string, Model<any>>;
    const registry = createSchemaRegistry(schema);
    const corpus = generateCorpus(schema, registry, SEED, COUNT);
    for (const strategy of SEMANTIC_STRATEGIES) {
      let kept = 0;
      for (const payload of corpus as readonly GeneratedPayload[]) {
        if (kept >= PER_STRATEGY) break;
        const mutant: InvalidPayload | undefined = mutate(
          strategy,
          payload,
          schema,
          registry
        );
        if (!mutant) continue;
        const counts = tally.get(strategy) ?? emptyTally();
        counts.mutants++;
        try {
          validatePayload(registry, schema, mutant.payload);
        } catch {
          refusedByParse++;
          tally.set(strategy, counts);
          continue;
        }
        counts.parseClean++;
        tally.set(strategy, counts);
        kept++;
        cells.push({
          strategy,
          stage: mutant.expect.stage,
          payload: {
            name: `fuzz-invalid:${strategy}:${name}:${payload.seed}:${payload.model}.${payload.operation}`,
            schema: name,
            model: mutant.payload.model,
            operation: mutant.payload.operation,
            args: mutant.payload.args,
          },
        });
      }
    }
  }
  return { cells, refusedByParse };
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

  test("semantic mutants × dialect × substrate × world", () => {
    const tally = new Map<SemanticStrategy, StrategyTally>();
    const { cells, refusedByParse } = generatedInvalid(tally);
    const results: CellResult[] = [];
    const byStrategy = new Map<string, SemanticStrategy>();
    for (const cell of cells) {
      byStrategy.set(cell.payload.name, cell.strategy);
      for (const dialect of DIALECTS) {
        for (const substrate of SUBSTRATES) {
          for (const world of WORLDS) {
            let outcome: Outcome;
            try {
              outcome = runCell(cell.payload, dialect, substrate, world);
            } catch (e) {
              outcome = { kind: "crash", detail: errorOf(e).message };
            }
            results.push({
              payload: cell.payload.name,
              dialect,
              substrate,
              world,
              outcome,
            });
          }
        }
      }
    }
    for (const result of results) {
      const strategy = byStrategy.get(result.payload);
      if (!strategy) continue;
      const counts = tally.get(strategy) ?? emptyTally();
      counts.cells++;
      if (result.outcome.kind === "equal") counts.equal++;
      if (result.outcome.kind === "error-identity") counts.errorIdentity++;
      if (result.outcome.kind === "steps") counts.steps++;
      if (result.outcome.kind === "crash") counts.crash++;
      tally.set(strategy, counts);
    }
    const perStrategy = SEMANTIC_STRATEGIES.map((strategy) => {
      const counts = tally.get(strategy) ?? emptyTally();
      return `  ${strategy}: mutants=${counts.mutants} parseClean=${counts.parseClean} cells=${counts.cells} equal=${counts.equal} error-identity=${counts.errorIdentity} steps=${counts.steps} crash=${counts.crash}`;
    }).join("\n");
    // eslint-disable-next-line no-console
    console.log(
      `M1 invalid differential — ${results.length} cells (${refusedByParse} mutants refused by the parse boundary)\n${perStrategy}\n${summarize(results)}`
    );
    if (process.env.PATTERN_M1_REPORT) {
      writeFileSync(
        `${process.env.PATTERN_M1_REPORT}.invalid.json`,
        JSON.stringify(
          results.map((result) => ({
            ...result,
            strategy: byStrategy.get(result.payload),
          })),
          null,
          2
        )
      );
    }
    expect(results.length).toBeGreaterThan(0);
    if (process.env.PATTERN_M1_STRICT) {
      expect(results.filter((r) => r.outcome.kind !== "equal")).toEqual([]);
    }
  }, 600_000);
});
