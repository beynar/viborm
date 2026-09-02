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

/** Classify every step-level difference between the oracle and the program. */
export function diffSteps(
  phase: "planning" | "final",
  oracle: readonly DumpStep[],
  mine: readonly DumpStep[]
): StepDifference[] {
  const differences: StepDifference[] = [];
  const oracleIds = oracle.map((step) => step.id);
  const mineIds = mine.map((step) => step.id);
  for (const [position, step] of oracle.entries()) {
    const counterpart = mine[position];
    if (!counterpart) {
      differences.push({
        phase,
        position,
        id: step.id,
        kind:
          step.kind === "read"
            ? "untaken-arm read difference"
            : "byte special case",
        detail: "missing in the pattern program",
      });
      continue;
    }
    if (counterpart.id !== step.id) {
      differences.push({
        phase,
        position,
        id: step.id,
        kind: mineIds.includes(step.id)
          ? "order mismatch"
          : step.kind === "read"
            ? "untaken-arm read difference"
            : "byte special case",
        detail: `oracle '${step.id}' vs program '${counterpart.id}'`,
      });
      continue;
    }
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
  for (const [position, step] of mine.entries()) {
    if (position < oracle.length) continue;
    differences.push({
      phase,
      position,
      id: step.id,
      kind:
        step.kind === "read" && !oracleIds.includes(step.id)
          ? "untaken-arm read difference"
          : "byte special case",
      detail: "extra in the pattern program",
    });
  }
  return differences;
}
