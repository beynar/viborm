/**
 * One M1 cell: the pattern engine's compile chain dumped in K4 form against
 * today's engine's dump, with every difference classified.
 */
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import type { CorpusPayload } from "@tests/pattern/corpus/payloads";
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
import { errorOf, packCell, scheduleCell, schemaOf } from "./chain";

export type Outcome =
  | { readonly kind: "equal" }
  | { readonly kind: "steps"; readonly differences: readonly StepDifference[] }
  | { readonly kind: "error-identity"; readonly detail: string }
  | { readonly kind: "crash"; readonly detail: string };

export interface CellResult {
  readonly payload: string;
  readonly dialect: PlanningDialect;
  readonly substrate: Substrate;
  readonly world: KnownWorld;
  readonly outcome: Outcome;
}

export function runCell(
  payload: CorpusPayload,
  dialect: PlanningDialect,
  substrate: Substrate,
  world: KnownWorld
): Outcome {
  const { schema, model } = schemaOf(payload);
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
  // A record series (ATOM §17) is dumped as capture + members + result reads;
  // the pattern engine schedules the same bulk payload as member fragments.
  // Both are flattened into one planning and one final sequence and compared
  // step by step — coarse, but every member difference still surfaces.
  const series = oracle.kind === "recordSeries";
  const oraclePlanning = series
    ? [
        ...oracle.planning,
        ...(oracle.members ?? []).flatMap((m) => m.planning),
        ...(oracle.resultReads ?? []).flatMap((m) => m.planning),
      ]
    : oracle.planning;
  const oracleFinal = series
    ? [
        ...(oracle.members ?? []).flatMap((m) => m.final),
        ...(oracle.resultReads ?? []).flatMap((m) => m.final),
      ]
    : oracle.final;
  const oracleError =
    oracle.error ??
    (oracle.members ?? []).find((m) => m.error)?.error ??
    (oracle.resultReads ?? []).find((m) => m.error)?.error;

  let mine: ReturnType<typeof dumpProgram> | undefined;
  let failure: { name: string; message: string } | undefined;
  try {
    const driver = planningDriver(dialect, substrate);
    const engine = engineFor(schema, driver);
    const scheduled = scheduleCell(payload, engine, dialect, substrate);
    const planned = packCell(scheduled, engine);
    const known = synthesizeKnown(
      oracleFor(schema, dialect, substrate),
      { steps: planned.fragments.flatMap((f) => f.matches.flat()) },
      world,
      payload.options?.capturedRoots ?? 1
    );
    mine = dumpProgram(driver, packCell(scheduled, engine, known));
  } catch (e) {
    failure = errorOf(e);
  }

  if (oracleError || failure) {
    const same =
      oracleError?.name === failure?.name &&
      oracleError?.message === failure?.message;
    if (same) return { kind: "equal" };
    return {
      kind: "error-identity",
      detail: `oracle ${oracleError ? `${oracleError.name}: ${oracleError.message}` : "ok"} vs mine ${failure ? `${failure.name}: ${failure.message}` : "ok"}`,
    };
  }
  if (!mine) return { kind: "crash", detail: "no program and no error" };
  const differences = [
    ...diffSteps("planning", oraclePlanning, mine.planning),
    ...diffSteps("final", oracleFinal, mine.final),
  ];
  return differences.length === 0
    ? { kind: "equal" }
    : { kind: "steps", differences };
}
