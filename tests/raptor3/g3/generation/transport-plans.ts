import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import type { AnyDriver, QueryResult } from "@drivers";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import type {
  DefaultObservation,
  OperationOutcome,
} from "../../harness/protocol";
import { Recorder } from "../../harness/recorder";
import {
  type ActorScript,
  type ExpectedStatement,
  type Reply,
  ScriptedTransport,
} from "../../transport/driver";
import type { G3GeneratedRecipe } from "./recipe";
import { recurrenceCompoundWorld } from "./recurrence-compound-world";
import { recurrenceOrdinaryWorld } from "./recurrence-ordinary-world";
import { recurrenceVariantWorld } from "./recurrence-variant-world";

// The generated transport plans drive the two candidate entries a public recipe
// reaches; the prepared-operation handle is exercised by its own unit checks.
type Candidate = Pick<
  ReturnType<typeof createCommandEngine>,
  "execute" | "prepareBatch"
>;

export interface TransportJob {
  readonly name: string;
  readonly script?: ActorScript;
  run(): Promise<unknown>;
  assert(outcome: OperationOutcome): void;
}

export interface TransportPlan {
  readonly schema: readonly unknown[];
  readonly expectedDefaults: readonly DefaultObservation[];
  jobs(driver: AnyDriver, admitted: () => void): TransportJob[];
}

function response(
  rows: unknown[],
  rowCount = rows.length
): QueryResult<unknown> {
  return { rows, rowCount };
}

function expectedStatements(
  action: ExpectedStatement["action"],
  count: number,
  firstParameter?: string
): ExpectedStatement[] {
  return Array.from({ length: count }, (_, index) => ({
    action,
    parameters:
      index === 0 && firstParameter !== undefined ? [firstParameter] : [],
  }));
}

function scriptedReply(options: {
  name: string;
  via: Reply["via"];
  statements: ExpectedStatement[];
  responses: QueryResult<unknown>[];
  fault: boolean;
  allowsChildContexts?: true;
}): Reply {
  return {
    name: options.name,
    via: options.via,
    statements: options.statements,
    committed: true,
    ...(options.allowsChildContexts ? { allowsChildContexts: true } : {}),
    ...(options.fault ? { injected: true } : {}),
    outcome: options.fault
      ? {
          kind: "failure",
          code: "57014",
          message: `${options.name}: injected provider failure`,
        }
      : { kind: "rows", responses: options.responses },
  };
}

function assertSettled(
  outcome: OperationOutcome,
  expected: unknown,
  shouldFail: boolean
) {
  if (shouldFail) {
    assert.equal(outcome.kind, "failure");
    return;
  }
  assert.deepEqual(outcome, { kind: "success", value: expected });
}

function trackedCandidate(
  schema: Schema,
  driver: AnyDriver,
  admitted: () => void
): Candidate {
  const candidate = createCommandEngine({ schema, driver });
  return {
    execute(...args) {
      admitted();
      return candidate.execute(...args);
    },
    prepareBatch(...args) {
      admitted();
      return candidate.prepareBatch(...args);
    },
  };
}

function presentation(recipe: Extract<G3GeneratedRecipe, { contract: "C08" }>) {
  return recipe.presentation === "count"
    ? {}
    : recipe.presentation === "select"
      ? { select: { id: true, code: true, score: true } }
      : { omit: { secret: true } };
}

function presentedRow(
  recipe: Extract<G3GeneratedRecipe, { contract: "C08" }>,
  row: {
    id: string;
    code: string;
    label: string;
    secret: string;
    score: number;
  }
) {
  if (recipe.presentation === "select")
    return { id: row.id, code: row.code, score: row.score };
  if (recipe.presentation === "omit") {
    const { secret: _secret, ...visible } = row;
    return visible;
  }
  return row;
}

function bulkTransportPlan(
  recipe: Extract<G3GeneratedRecipe, { contract: "C08" }>,
  recorder: Recorder,
  defaults: DefaultObservation[]
): TransportPlan {
  let defaultCount = 0;
  const record = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      label: s.string().default(() => {
        const observation = {
          name: "record.label",
          value: `g3-transport-default-${recipe.seed}-${++defaultCount}`,
        };
        defaults.push(observation);
        recorder.record({ kind: "default", observation });
        return observation.value;
      }),
      secret: s.string().default("private"),
      score: s.int().default(0),
    })
    .map("g3_transport_bulk_records");
  const schema = { record };
  const expectedDefaults = Array.from(
    {
      length:
        recipe.verb === "createMany"
          ? recipe.operations * Math.ceil(recipe.rowCount / 2)
          : 0,
    },
    (_, index) => ({
      name: "record.label",
      value: `g3-transport-default-${recipe.seed}-${index + 1}`,
    })
  );
  return {
    schema: [{ contract: "C08", table: "g3_transport_bulk_records" }],
    expectedDefaults,
    jobs(driver, admitted) {
      const candidate = trackedCandidate(schema, driver, admitted);
      return Array.from({ length: recipe.operations }, (_, operation) => {
        const name = `g3-c08-${recipe.seed}-${operation}`;
        const rows = Array.from({ length: recipe.rowCount }, (_, index) => ({
          id: `${name}-id-${index}`,
          code: `${name}-code-${index}`,
          ...(index % 2 === 0 ? {} : { label: `${name}-label-${index}` }),
          secret: `${name}-secret-${index}`,
          score: index,
        }));
        const completeRows = rows.map((row, index) => ({
          ...row,
          label:
            recipe.verb === "updateMany"
              ? `${name}-updated`
              : "label" in row && typeof row.label === "string"
                ? row.label
                : `g3-transport-default-${recipe.seed}-${
                    operation * Math.ceil(recipe.rowCount / 2) +
                    Math.floor(index / 2) +
                    1
                  }`,
        }));
        const affected =
          recipe.verb === "createMany"
            ? recipe.rowCount
            : Math.min(recipe.rowCount, recipe.limit);
        const returned = completeRows
          .slice(0, affected)
          .map((row) => presentedRow(recipe, row));
        const expected =
          recipe.presentation === "count" ? { count: affected } : returned;
        const fault = recipe.fault !== "none" && operation === 0;
        const action =
          recipe.verb === "createMany"
            ? "INSERT"
            : recipe.verb === "updateMany"
              ? "UPDATE"
              : "DELETE";
        const hasPhysicalWindow =
          recipe.verb === "createMany" || recipe.limit > 0;
        const script = hasPhysicalWindow
          ? {
              name,
              firstParameter: rows[0]!.id,
              replies: [
                scriptedReply({
                  name: `${name}:bulk`,
                  via: "execute",
                  statements: expectedStatements(action, 1, rows[0]!.id),
                  responses: [
                    response(
                      recipe.presentation === "count" ? [] : returned,
                      affected
                    ),
                  ],
                  fault,
                }),
              ],
            }
          : undefined;
        const args =
          recipe.verb === "createMany"
            ? { data: rows, ...presentation(recipe) }
            : recipe.verb === "updateMany"
              ? {
                  where: { id: { in: rows.map(({ id }) => id) } },
                  data: { label: `${name}-updated` },
                  limit: recipe.limit,
                  ...presentation(recipe),
                }
              : {
                  where: { id: { in: rows.map(({ id }) => id) } },
                  limit: recipe.limit,
                  ...presentation(recipe),
                };
        return {
          name,
          ...(script === undefined ? {} : { script }),
          run: () => candidate.execute("record", recipe.verb, args),
          assert: (outcome) => assertSettled(outcome, expected, fault),
        };
      });
    },
  };
}

function suppressionTransportPlan(
  recipe: Extract<G3GeneratedRecipe, { contract: "C09" }>
): TransportPlan {
  const author = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map("g3_transport_scope_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("g3_transport_scope_posts");
  const schema = { author, post };
  const primaryHasTransport = recipe.conflict === "root";
  const faultIndex =
    recipe.fault === "none" ? undefined : primaryHasTransport ? 0 : 1;
  return {
    schema: [{ contract: "C09", tables: 2 }],
    expectedDefaults: [],
    jobs(driver, admitted) {
      const candidate = trackedCandidate(schema, driver, admitted);
      return Array.from({ length: recipe.operations }, (_, operation) => {
        const name = `g3-c09-${recipe.seed}-${operation}`;
        const firstParameter = `${name}-post`;
        const fault = operation === faultIndex;
        if (operation === 0 && recipe.conflict === "descendant") {
          const args = {
            data: [
              {
                id: firstParameter,
                title: "nested-suppression-refusal",
                author: {
                  create: { id: `${name}-author`, name: `${name}-author` },
                },
              },
            ],
            skipDuplicates: true,
            select: { id: true },
          };
          return {
            name,
            run: () => candidate.execute("post", "createMany", args),
            assert(outcome) {
              assert.equal(outcome.kind, "failure");
              if (outcome.kind === "failure")
                assert.equal(outcome.failure.name, "TransactionError");
            },
          };
        }
        const rows =
          operation === 0
            ? [
                { id: `${name}-prefix`, title: "prefix", authorId: "owner" },
                { id: firstParameter, title: "duplicate", authorId: "owner" },
                { id: `${name}-suffix`, title: "suffix", authorId: "owner" },
              ]
            : [
                {
                  id: firstParameter,
                  title: `healthy-${operation}`,
                  authorId: "owner",
                },
              ];
        const returned =
          operation === 0
            ? [{ id: rows[0]!.id }, { id: rows[2]!.id }]
            : [{ id: rows[0]!.id }];
        const reply = scriptedReply({
          name: `${name}:scope`,
          via: "execute",
          statements: expectedStatements("INSERT", 1, firstParameter),
          responses: [response(returned, returned.length)],
          fault,
        });
        return {
          name,
          script: { name, firstParameter, replies: [reply] },
          run: () =>
            candidate.execute("post", "createMany", {
              data: rows,
              ...(operation === 0 ? { skipDuplicates: true } : {}),
              select: { id: true },
            }),
          assert: (outcome) => assertSettled(outcome, returned, fault),
        };
      });
    },
  };
}

function transactionArray(client: object, operations: readonly unknown[]) {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  const pending: unknown = Reflect.apply(transaction, client, [operations]);
  assert(pending instanceof Promise);
  return pending;
}

function transactionTransportPlan(
  recipe: Extract<G3GeneratedRecipe, { contract: "C10" }>
): TransportPlan {
  const record = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
    })
    .map("g3_transport_array_records");
  const schema = { record };
  return {
    schema: [{ contract: "C10", table: "g3_transport_array_records" }],
    expectedDefaults: [],
    jobs(driver, admitted) {
      const candidate = trackedCandidate(schema, driver, admitted);
      const reservePeer = recipe.actors === 2 ? 1 : 0;
      const reserveRecovery = recipe.fault === "none" ? 0 : 1;
      if (recipe.composition === "borrowed") {
        return Array.from({ length: recipe.operations }, (_, operation) => {
          const name = `g3-c10-borrowed-${recipe.seed}-${operation}`;
          const id = `${name}-id`;
          const expected = [{ id }];
          const fault = recipe.fault !== "none" && operation === 0;
          const reply = scriptedReply({
            name: `${name}:borrowed`,
            via: "execute",
            statements: expectedStatements("INSERT", 1, id),
            responses: [response(expected, 1)],
            fault,
          });
          return {
            name,
            script: { name, firstParameter: id, replies: [reply] },
            run: () =>
              candidate.execute(
                "record",
                "createMany",
                { data: [{ id, code: `${name}-code` }], select: { id: true } },
                { kind: "borrowed-transaction", driver }
              ),
            assert: (outcome) => assertSettled(outcome, expected, fault),
          };
        });
      }
      const memberCount = recipe.operations - reservePeer - reserveRecovery;
      assert(memberCount >= 1);
      const client = createClient({ schema, driver });
      const primaryName = `g3-c10-array-${recipe.seed}`;
      const memberIds = Array.from(
        { length: memberCount },
        (_, index) => `${primaryName}-member-${index}`
      );
      const primaryFault = recipe.fault !== "none";
      const primaryReply = scriptedReply({
        name: `${primaryName}:array`,
        via: "batch",
        statements: memberIds.flatMap((id) =>
          expectedStatements("INSERT", 1, id)
        ),
        responses: memberIds.map((id) => response([{ id }], 1)),
        fault: primaryFault,
        allowsChildContexts: true,
      });
      const members = memberIds.map((id, index) =>
        overrideTransactionOperation(client.record.findMany(), {
          prepare: () => undefined,
          prepareBatch: () =>
            candidate.prepareBatch("record", "createMany", {
              data: [{ id, code: `${primaryName}-code-${index}` }],
              select: { id: true },
            }),
        })
      );
      const jobs: TransportJob[] = [
        {
          name: primaryName,
          script: {
            name: primaryName,
            firstParameter: memberIds[0]!,
            replies: [primaryReply],
          },
          run: () => transactionArray(client, members),
          assert: (outcome) =>
            assertSettled(
              outcome,
              memberIds.map((id) => [{ id }]),
              primaryFault
            ),
        },
      ];
      for (let index = 0; index < reservePeer + reserveRecovery; index++) {
        const name = `g3-c10-array-${recipe.seed}-suffix-${index}`;
        const id = `${name}-id`;
        const expected = [{ id }];
        const reply = scriptedReply({
          name: `${name}:suffix`,
          via: "execute",
          statements: expectedStatements("INSERT", 1, id),
          responses: [response(expected, 1)],
          fault: false,
        });
        jobs.push({
          name,
          script: { name, firstParameter: id, replies: [reply] },
          run: () =>
            candidate.execute("record", "createMany", {
              data: [{ id, code: `${name}-code` }],
              select: { id: true },
            }),
          assert: (outcome) => assertSettled(outcome, expected, false),
        });
      }
      return jobs;
    },
  };
}

function recurrenceFirstParameter(
  recipe: Extract<G3GeneratedRecipe, { contract: "C11" }>,
  operation: number
): string {
  if (recipe.shape === "compound") return `isbn-${recipe.seed}-${operation}`;
  if (recipe.shape === "variant") return `crate-${recipe.seed}-${operation}-0`;
  return `n-${recipe.seed}-${operation}-s0`;
}

function recurrenceSegment(
  name: string,
  statements: readonly ExpectedStatement[],
  expected: unknown | undefined,
  fault: boolean,
  via: "batch" | "execute" = "batch"
): Reply {
  return scriptedReply({
    name,
    via,
    statements: [...statements],
    responses: statements.map((statement, index) =>
      expected !== undefined && index === statements.length - 1
        ? response([expected], 1)
        : response([], statement.action === "SELECT" ? 0 : 1)
    ),
    fault,
  });
}

/**
 * The ORDINARY and REPEATED recurrence shapes' packaging: one dispatched unit.
 *
 * N5 derives it from the boundary rule rather than from the spelling of the
 * nesting. A member takes a segment of its own only where a LATER member must
 * OBSERVE an earlier one's row — a `connectOrCreate` probe, an ordered
 * observation, a produced identity — because a dispatch commits the whole
 * queue and D-51 admits a succession of segments only while the two routes
 * keep ONE result. The recurrence world's nodes spell every key and read
 * nothing (`recurrence-ordinary-world.ts`), so no member of either shape
 * observes another: `children: { create: [...] }` and
 * `children: { createMany: { data: [...] } }` package identically, at every
 * depth and fanout, and the terminal re-read rides the same batch behind the
 * writes.
 *
 * Per representative recipe, that is: `8019` (depth 2, fanout 2, ordinary) 7
 * INSERTs; `8023` (depth 2, fanout 2, repeated) the same 7; `8031` (depth 2,
 * fanout 0, repeated) 3; `8027` (depth 0, fanout 3, repeated) and `8611`
 * (depth 0, ordinary) the folded root `create` below. A faulted recipe carries
 * its fault on that one segment, because there is no earlier segment for it to
 * commit behind.
 */
function ordinaryRecurrenceReplies(
  recipe: Extract<G3GeneratedRecipe, { contract: "C11" }>,
  name: string,
  firstParameter: string,
  expected: unknown,
  fault: boolean
): Reply[] {
  const insertCount = recipe.depth + 1 + recipe.depth * recipe.fanout;
  // `insertCount === 1` (depth 0) is the scalar-only root `create`: it names no
  // relation, its projection is RETURNING-safe and the adapter has RETURNING,
  // so the candidate folds the write and the read into one statement and
  // publishes the row from the INSERT's own RETURNING — the shipped engine's
  // tape. There is no re-read left to script. A depth >= 1 recipe names a
  // relation, does not fold, and keeps the trailing SELECT.
  // (`g4/unit02/note.md` §P.4.7, §R2.5 — recorded root-`create` fold.)
  const folded = insertCount === 1;
  return [
    recurrenceSegment(
      `${name}:recurrence-0`,
      [
        ...expectedStatements("INSERT", insertCount, firstParameter),
        ...(folded ? [] : expectedStatements("SELECT", 1)),
      ],
      expected,
      fault,
      // D-7: the folded root `create` is the operation's ONLY statement, so it
      // needs no batch envelope and runs on the plain execute path — the
      // shipped `runStatementAtomic` transport. Every other segment here is a
      // record-series member and stays in its batch.
      folded ? "execute" : "batch"
    ),
  ];
}

function variantRecurrenceReplies(
  recipe: Extract<G3GeneratedRecipe, { contract: "C11" }>,
  name: string,
  firstParameter: string,
  expected: unknown,
  fault: boolean
): Reply[] {
  const insertCount = (recipe.depth + 1) * (1 + 2 * (recipe.fanout + 1));
  return [
    recurrenceSegment(
      `${name}:recurrence-0`,
      [
        ...expectedStatements("INSERT", insertCount, firstParameter),
        ...expectedStatements("SELECT", 1),
      ],
      expected,
      fault
    ),
  ];
}

function compoundRecurrenceReplies(
  recipe: Extract<G3GeneratedRecipe, { contract: "C11" }>,
  name: string,
  firstParameter: string,
  expected: unknown,
  fault: boolean,
  operation: number
): Reply[] {
  const lookup: Reply = {
    name: `${name}:lookup`,
    via: "execute",
    statements: [{ action: "SELECT", parameters: [firstParameter] }],
    committed: false,
    outcome: {
      kind: "rows",
      responses: [
        response(
          [
            {
              region: `old-r-${operation}`,
              code: `old-c-${operation}`,
              isbn: firstParameter,
              title: "before",
            },
          ],
          1
        ),
      ],
    },
  };
  const chapterCount = recipe.depth + 1 + recipe.depth * recipe.fanout;
  const mutationStatements = [
    ...expectedStatements("SELECT", 2),
    ...expectedStatements("UPDATE", 1),
    ...expectedStatements("INSERT", chapterCount),
    ...expectedStatements("SELECT", 1),
  ];
  const mutation = scriptedReply({
    name: `${name}:recurrence-0`,
    via: "batch",
    statements: mutationStatements,
    responses: mutationStatements.map((statement, index) =>
      index <= 1
        ? response([{ __viborm_assert__: 1 }], 1)
        : index === mutationStatements.length - 1
          ? response([expected], 1)
          : response([], statement.action === "SELECT" ? 0 : 1)
    ),
    fault,
  });
  return [lookup, mutation];
}

function recurrenceTransportPlan(
  recipe: Extract<G3GeneratedRecipe, { contract: "C11" }>
): TransportPlan {
  const world =
    recipe.shape === "compound"
      ? recurrenceCompoundWorld(recipe)
      : recipe.shape === "variant"
        ? recurrenceVariantWorld(recipe)
        : recurrenceOrdinaryWorld(recipe, recipe.shape === "repeated");
  return {
    schema: [
      {
        contract: "C11",
        shape: recipe.shape,
        depth: recipe.depth,
        fanout: recipe.fanout,
      },
    ],
    expectedDefaults: [],
    jobs(driver, admitted) {
      const candidate = trackedCandidate(world.schema, driver, admitted);
      return Array.from({ length: recipe.operations }, (_, operation) => {
        const name = `g3-c11-${recipe.seed}-${operation}`;
        const publicOperation = world.operations[operation];
        assert(publicOperation, "G3 recurrence operation is missing");
        const firstParameter = recurrenceFirstParameter(recipe, operation);
        const fault = recipe.fault !== "none" && operation === 0;
        const replies: Reply[] =
          recipe.shape === "compound"
            ? compoundRecurrenceReplies(
                recipe,
                name,
                firstParameter,
                publicOperation.expected,
                fault,
                operation
              )
            : recipe.shape === "variant"
              ? variantRecurrenceReplies(
                  recipe,
                  name,
                  firstParameter,
                  publicOperation.expected,
                  fault
                )
              : ordinaryRecurrenceReplies(
                  recipe,
                  name,
                  firstParameter,
                  publicOperation.expected,
                  fault
                );
        return {
          name,
          script: { name, firstParameter, replies },
          run: () =>
            candidate.execute(
              publicOperation.model,
              publicOperation.operation,
              publicOperation.args
            ),
          assert: (outcome) =>
            assertSettled(outcome, publicOperation.expected, fault),
        };
      });
    },
  };
}

export function transportPlan(
  recipe: G3GeneratedRecipe,
  recorder: Recorder,
  defaults: DefaultObservation[]
): TransportPlan {
  if (recipe.contract === "C08")
    return bulkTransportPlan(recipe, recorder, defaults);
  if (recipe.contract === "C09") return suppressionTransportPlan(recipe);
  if (recipe.contract === "C10") return transactionTransportPlan(recipe);
  return recurrenceTransportPlan(recipe);
}
