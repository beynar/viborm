/**
 * Unit F — the execution-level differential scaffold (M2).
 *
 * The SAME K3 program runs through the pattern executor and, converted to
 * today's `OperationFragment` shape, through `OperationExecutor`, on two
 * simulated drivers with the same script. The comparison is the statement
 * log: SQL text, parameters, phase, attribution, lifecycle.
 *
 * What converts: a one-fragment program (matches → `planning()`, writes plus
 * the derived premise guards → `compile(known)`, with the matches' bindings
 * substituted as literals the way today's compilers embed planning outputs).
 * What does not convert, and why, is listed at the bottom.
 */
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { type Sql, sql } from "@sql";
import { execute } from "@src/query-engine/pattern/execute";
import { guardSteps } from "@src/query-engine/pattern/execute/batch";
import { lockForUpdate } from "@src/query-engine/pattern/execute/transaction";
import type { Program } from "@src/query-engine/pattern/fragment";
import {
  type ExecutableOperation,
  OperationExecutor,
} from "@src/query-engine/write-engine/OperationExecutor";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  ref,
  type StatementOutputSource,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import {
  CAPABILITY_PRESETS,
  mentions,
  rows,
  type SimulatedCapabilities,
  SimulatedDriver,
  type SimulatedScript,
  written,
} from "@tests/pattern/sim/simulated-driver";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import {
  connectProgram,
  levelledProgram,
  mergeOutcomeProgram,
  mergeProgram,
  singleStatementProgram,
} from "./fixtures";

const schema = { probe: s.model({ id: s.int().id() }).map("sim_probe") };
hydrateSchemaNames(schema);

type AnyDriverLike = ConstructorParameters<typeof QueryEngine>[0];

function todaysExecutor(driver: AnyDriverLike): OperationExecutor {
  return new OperationExecutor(
    new QueryEngine(
      driver,
      createModelRegistry(schema, createSchemaRegistry(schema))
    )
  );
}

// ---------------------------------------------------------------------------
// Program → ExecutableOperation
// ---------------------------------------------------------------------------

function substitute(
  statement: Sql,
  known: Readonly<Record<string, unknown>>,
  local: ReadonlySet<string>
): Sql {
  return new (statement.constructor as typeof Sql)(
    statement.strings,
    statement.values.map((value) => {
      if (!isOperationValueReference(value) || local.has(value.step))
        return value;
      const key = `${value.step}.${value.output}`;
      if (!(key in known)) {
        throw new Error(`differential: '${key}' was not bound by planning`);
      }
      return known[key] ?? null;
    })
  );
}

function substituteStep(
  step: StatementStep,
  known: Readonly<Record<string, unknown>>,
  local: ReadonlySet<string>,
  stripExpects: boolean
): StatementStep {
  const outputs = Object.fromEntries(
    Object.entries<StatementOutputSource>(step.outputs).map(
      ([name, source]) => {
        if (
          source.kind !== "consumedValue" ||
          source.source.kind !== "reference" ||
          local.has(source.source.reference.step)
        ) {
          return [name, source];
        }
        const key = `${source.source.reference.step}.${source.source.reference.output}`;
        return [
          name,
          {
            kind: "consumedValue",
            source: { kind: "literal", value: known[key] },
          },
        ];
      }
    )
  );
  const { expects, ...rest } = step;
  return {
    ...rest,
    ...(stripExpects || !expects ? {} : { expects }),
    statement: substitute(step.statement, known, local),
    outputs,
  };
}

function convert(
  program: Program,
  mode: "transaction" | "batch",
  driver: SimulatedDriver
): ExecutableOperation {
  const [fragment] = program.fragments;
  if (!fragment || program.fragments.length !== 1) {
    throw new Error("differential: only one-fragment programs convert");
  }
  if (
    fragment.premises.some(
      (bound) =>
        bound.premise.kind === "occupant" ||
        bound.premise.kind === "unreferenced"
    )
  ) {
    throw new Error(
      "differential: occupant/unreferenced premises have no OperationFragment spelling"
    );
  }
  const decisions = new Set(fragment.premises.map((bound) => bound.match.id));
  const planningSteps = fragment.matches
    .flat()
    .map((match) =>
      mode === "transaction" && decisions.has(match.id)
        ? { ...match, statement: lockForUpdate(driver, match.statement) }
        : match
    );
  const local = new Set(fragment.writes.map((step) => step.id));
  return {
    mode,
    planning: (): PlanningFragment => ({ steps: planningSteps }),
    compile: (known): OperationFragment => {
      const guards: OperationStep[] =
        mode === "batch"
          ? guardSteps(fragment.premises).map((guard) => ({
              ...guard,
              premise: {
                ...guard.premise,
                statement: substitute(guard.premise.statement, known, local),
              },
            }))
          : [];
      const writes = fragment.writes.map((step) =>
        step.kind === "read" || step.kind === "write"
          ? substituteStep(step, known, local, mode === "batch")
          : step
      );
      const outputs = Object.fromEntries(
        Object.entries(program.outputs).map(([name, source]) => [
          name,
          typeof source === "string"
            ? single(program, source)
            : source.map((id) => single(program, id)),
        ])
      );
      return { steps: [...guards, ...writes], outputs };
    },
    parse: <T>(outputs: Readonly<Record<string, unknown>>): T => outputs as T,
  };
}

function single(program: Program, stepId: string) {
  for (const fragment of program.fragments) {
    for (const step of [...fragment.matches.flat(), ...fragment.writes]) {
      if (
        step.id !== stepId ||
        step.kind === "guard" ||
        step.kind === "recordSeries"
      )
        continue;
      const [only] = Object.keys(step.outputs);
      if (!only)
        throw new Error(`differential: '${stepId}' declares no output`);
      return ref(stepId, only);
    }
  }
  throw new Error(`differential: '${stepId}' not found`);
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly program: () => Program;
  readonly capabilities: SimulatedCapabilities;
  readonly dialect: "postgresql" | "mysql" | "sqlite";
  readonly script: SimulatedScript;
}

async function both(testCase: Case) {
  const mine = new SimulatedDriver({
    dialect: testCase.dialect,
    capabilities: testCase.capabilities,
    script: testCase.script,
  });
  const theirs = new SimulatedDriver({
    dialect: testCase.dialect,
    capabilities: testCase.capabilities,
    script: testCase.script,
  });
  const program = testCase.program();
  const context = createOperationExecutionContext(
    program.model,
    program.operation
  );
  const mode = testCase.capabilities.supportsTransactions
    ? "transaction"
    : "batch";
  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ status: "ok" as const, value }),
      (error: unknown) => ({
        status: "error" as const,
        error: describeError(error),
      })
    );
  const ours = await settle(
    execute(program, mine, { execution: context, retry: false })
  );
  const todays = await settle(
    todaysExecutor(theirs).execute<Readonly<Record<string, unknown>>>(
      convert(program, mode, theirs),
      context
    )
  );
  return { ours, todays, mine, theirs };
}

function describeError(error: unknown) {
  const e = error as { name?: string; message?: string; code?: unknown };
  return { name: e?.name, message: e?.message, code: e?.code };
}

const authorFound: SimulatedScript = {
  respond: (statement) =>
    statement.kind === "read" ? rows({ id: "u1" }) : undefined,
};

const cases: Case[] = [
  {
    name: "connect on pg / transaction",
    program: connectProgram,
    capabilities: CAPABILITY_PRESETS.postgres,
    dialect: "postgresql",
    script: authorFound,
  },
  {
    name: "connect on sqlite / transaction",
    program: connectProgram,
    capabilities: CAPABILITY_PRESETS.sqlite,
    dialect: "sqlite",
    script: authorFound,
  },
  {
    name: "connect on neon-http / batch",
    program: connectProgram,
    capabilities: CAPABILITY_PRESETS.neonHttp,
    dialect: "postgresql",
    script: authorFound,
  },
  {
    name: "connect on planetscale / batch",
    program: connectProgram,
    capabilities: CAPABILITY_PRESETS.planetscale,
    dialect: "mysql",
    script: authorFound,
  },
  {
    name: "connect target missing / transaction",
    program: connectProgram,
    capabilities: CAPABILITY_PRESETS.postgres,
    dialect: "postgresql",
    script: {},
  },
  {
    name: "connect target missing / batch",
    program: connectProgram,
    capabilities: CAPABILITY_PRESETS.neonHttp,
    dialect: "postgresql",
    script: {},
  },
  {
    name: "write postcondition fails / transaction",
    program: connectProgram,
    capabilities: CAPABILITY_PRESETS.postgres,
    dialect: "postgresql",
    script: {
      respond: (statement) =>
        statement.kind === "read" ? rows({ id: "u1" }) : written(0),
    },
  },
  {
    name: "levelled matches / batch",
    program: levelledProgram,
    capabilities: CAPABILITY_PRESETS.neonHttp,
    dialect: "postgresql",
    script: {
      respond: (statement) =>
        statement.kind === "read"
          ? rows({ id: `${statement.index}` })
          : undefined,
    },
  },
  {
    name: "levelled matches / transaction",
    program: levelledProgram,
    capabilities: CAPABILITY_PRESETS.postgres,
    dialect: "postgresql",
    script: {
      respond: (statement) =>
        statement.kind === "read"
          ? rows({ id: `${statement.index}` })
          : undefined,
    },
  },
  {
    name: "statement-atomic / transaction driver",
    program: singleStatementProgram,
    capabilities: CAPABILITY_PRESETS.postgres,
    dialect: "postgresql",
    script: {},
  },
  {
    name: "statement-atomic / batch driver",
    program: singleStatementProgram,
    capabilities: CAPABILITY_PRESETS.d1,
    dialect: "sqlite",
    script: {},
  },
  {
    name: "merge missing arm, pinned insert loses / transaction",
    program: () => mergeProgram("missing"),
    capabilities: CAPABILITY_PRESETS.postgres,
    dialect: "postgresql",
    script: {
      respond: (statement) =>
        statement.kind === "read"
          ? rows()
          : {
              fault: {
                error: "unique",
                table: "sim_users",
                constraint: "sim_users_email_key",
              },
            },
    },
  },
  {
    name: "merge found arm / batch",
    program: () => mergeProgram("found"),
    capabilities: CAPABILITY_PRESETS.neonHttp,
    dialect: "postgresql",
    script: authorFound,
  },
  {
    name: "guard aborts / batch",
    program: connectProgram,
    capabilities: CAPABILITY_PRESETS.neonHttp,
    dialect: "postgresql",
    script: {
      respond: (statement) =>
        statement.kind === "read"
          ? rows({ id: "u1" })
          : statement.kind === "guard"
            ? { fault: { error: "assertion" } }
            : undefined,
    },
  },
];

describe("execution-level differential (one-fragment programs)", () => {
  test.each(
    cases.map((testCase) => [testCase.name, testCase] as const)
  )("%s", async (_name, testCase) => {
    const { ours, todays, mine, theirs } = await both(testCase);
    expect(mine.trace()).toEqual(theirs.trace());
    expect(ours).toEqual(todays);
  });

  test("a merge-outcome (multi-fragment) program has no OperationFragment spelling here", () => {
    const driver = new SimulatedDriver();
    expect(() => convert(mergeOutcomeProgram(), "transaction", driver)).toThrow(
      "only one-fragment programs convert"
    );
  });

  test("the conversion refuses what has no spelling in OperationFragment", () => {
    const program = connectProgram();
    const [fragment] = program.fragments;
    const occupant: Program = {
      ...program,
      fragments: [
        {
          ...fragment!,
          premises: [
            {
              premise: {
                kind: "occupant",
                row: 1,
                occupant: 2,
                raceable: false,
              },
              match: fragment!.matches[0]![0]!,
            },
          ],
        },
      ],
    };
    expect(() => convert(occupant, "batch", new SimulatedDriver())).toThrow(
      "no OperationFragment spelling"
    );
    expect(mentions({ sql: sql`x`.strings.join("") } as never, "x")).toBe(true);
  });
});
