/**
 * K4 dump of a pattern-engine Program, in the harness's canonical form, so the
 * differential is a plain comparison of two `DumpStep[]`. The harness keeps
 * its canonicalizer private; this mirrors it exactly (refs as `{ref}`, sorted
 * keys, tagged Date / bigint / bytes) for the values a program carries.
 */

import type { Program } from "@src/query-engine/pattern/fragment";
import { fragmentSteps } from "@src/query-engine/pattern/pack";
import {
  isOperationValueReference,
  type OperationStep,
} from "@src/query-engine/write-engine/OperationFragment";
import type { PlanningDriver } from "@tests/fixtures/drivers/planning";
import type { DumpStep } from "@tests/pattern/harness/dump";

export function canonical(value: unknown): unknown {
  if (isOperationValueReference(value))
    return { ref: `${value.step}.${value.output}` };
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value instanceof Uint8Array)
    return { bytes: Buffer.from(value).toString("base64") };
  if (!(value && typeof value === "object")) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => [key, canonical(member)])
  );
}

export function dumpStep(
  driver: PlanningDriver,
  step: OperationStep,
  position: number
): DumpStep {
  if (step.kind === "guard") {
    const query = driver._prepare(step.premise.statement);
    return {
      position,
      id: step.id,
      kind: "guard",
      premise: {
        kind: step.premise.kind,
        sql: query.sql,
        params: canonical(query.params),
      },
      failure: canonical(step.failure),
    };
  }
  if (step.kind === "recordSeries") {
    return { position, id: step.id, kind: "recordSeries" };
  }
  const query = driver._prepare(step.statement);
  return {
    position,
    id: step.id,
    kind: step.kind,
    sql: query.sql,
    params: canonical(query.params),
    outputs: canonical(step.outputs),
    expects: canonical(step.expects ?? null),
    racePin: step.kind === "write" ? canonical(step.racePin ?? null) : null,
    onUniqueConflict:
      step.kind === "write" ? (step.onUniqueConflict ?? null) : null,
    model: step.model,
  };
}

export interface ProgramDump {
  readonly planning: readonly DumpStep[];
  readonly final: readonly DumpStep[];
  readonly outputs: unknown;
}

/** Planning = every fragment's match phase; final = guards then writes. */
export function dumpProgram(
  driver: PlanningDriver,
  program: Program
): ProgramDump {
  const planning = program.fragments.flatMap((fragment) =>
    fragment.matches.flat()
  );
  const final = program.fragments.flatMap((fragment) =>
    fragmentSteps(fragment)
  );
  return {
    planning: planning.map((step, index) => dumpStep(driver, step, index)),
    final: final.map((step, index) => dumpStep(driver, step, index)),
    outputs: canonical(program.outputs),
  };
}

export type DiffClass =
  | "order mismatch"
  | "byte special case"
  | "guard-shape special case"
  | "untaken-arm read difference";

export interface StepDifference {
  readonly phase: "planning" | "final";
  readonly position: number;
  readonly id: string;
  readonly kind: DiffClass;
  readonly detail: string;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Align two step lists by id (longest common subsequence) so one early
 * difference cannot make every later step look missing, then classify what the
 * alignment leaves: a step only the oracle has, a step only the program has, a
 * pair whose ids match but whose bytes do not, and a pair the alignment had to
 * reorder.
 */
function alignById(
  oracle: readonly DumpStep[],
  mine: readonly DumpStep[]
): { oracle?: DumpStep; mine?: DumpStep; position: number }[] {
  const rows = oracle.length;
  const columns = mine.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0)
  );
  for (let i = rows - 1; i >= 0; i--) {
    const row = table[i];
    if (!row) continue;
    for (let j = columns - 1; j >= 0; j--) {
      row[j] =
        oracle[i]?.id === mine[j]?.id
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const pairs: { oracle?: DumpStep; mine?: DumpStep; position: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (oracle[i]?.id === mine[j]?.id) {
      pairs.push({ oracle: oracle[i], mine: mine[j], position: i });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      pairs.push({ oracle: oracle[i], position: i });
      i++;
    } else {
      pairs.push({ mine: mine[j], position: i });
      j++;
    }
  }
  for (; i < rows; i++) pairs.push({ oracle: oracle[i], position: i });
  for (; j < columns; j++) pairs.push({ mine: mine[j], position: i });
  return pairs;
}

/** Classify every step-level difference between the oracle and the program. */
export function diffSteps(
  phase: "planning" | "final",
  oracle: readonly DumpStep[],
  mine: readonly DumpStep[]
): StepDifference[] {
  const differences: StepDifference[] = [];
  const mineIds = new Set(mine.map((step) => step.id));
  const oracleIds = new Set(oracle.map((step) => step.id));
  for (const pair of alignById(oracle, mine)) {
    const { position } = pair;
    if (pair.oracle && !pair.mine) {
      const step = pair.oracle;
      differences.push({
        phase,
        position,
        id: step.id,
        // A step the program emits elsewhere is an ORDER difference; one it
        // never emits is a missing statement — an untaken-arm read only when
        // it is a read.
        kind: mineIds.has(step.id)
          ? "order mismatch"
          : step.kind === "read"
            ? "untaken-arm read difference"
            : "byte special case",
        detail: mineIds.has(step.id)
          ? "emitted at another position"
          : "missing in the pattern program",
      });
      continue;
    }
    if (pair.mine && !pair.oracle) {
      const step = pair.mine;
      differences.push({
        phase,
        position,
        id: step.id,
        kind: oracleIds.has(step.id)
          ? "order mismatch"
          : step.kind === "read"
            ? "untaken-arm read difference"
            : "byte special case",
        detail: oracleIds.has(step.id)
          ? "emitted at another position"
          : "extra in the pattern program",
      });
      continue;
    }
    const step = pair.oracle;
    const counterpart = pair.mine;
    if (!(step && counterpart)) continue;
    if (step.kind === "guard") {
      if (!same(step.premise, counterpart.premise)) {
        differences.push({
          phase,
          position,
          id: step.id,
          kind: "guard-shape special case",
          detail: `premise ${JSON.stringify(step.premise)} vs ${JSON.stringify(counterpart.premise)}`,
        });
      } else if (!same(step.failure, counterpart.failure)) {
        differences.push({
          phase,
          position,
          id: step.id,
          kind: "guard-shape special case",
          detail: `failure ${JSON.stringify(step.failure)} vs ${JSON.stringify(counterpart.failure)}`,
        });
      }
      continue;
    }
    const fields: (keyof DumpStep)[] = [
      "kind",
      "sql",
      "params",
      "outputs",
      "expects",
      "racePin",
      "onUniqueConflict",
      "model",
    ];
    for (const field of fields) {
      if (same(step[field], counterpart[field])) continue;
      differences.push({
        phase,
        position,
        id: step.id,
        kind: "byte special case",
        detail: `${field}: ${JSON.stringify(canonical(step[field]))} vs ${JSON.stringify(canonical(counterpart[field]))}`,
      });
    }
  }
  return differences;
}
