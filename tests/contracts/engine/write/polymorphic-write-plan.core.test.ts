import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  type AnyDriver,
  Driver,
  type QueryExecutionContext,
  type QueryResult,
} from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { UniqueConstraintError } from "@errors";
import { variantCarrier } from "@query-engine/context";
import { JunctionStatements } from "@query-engine/JunctionStatements";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { isVariantRowCarrier } from "@query-engine/types";
import { s } from "@schema";
import { bindPolymorphicCollectionMember } from "@src/query-engine/builders/polymorphic-collection-mutation";
import { selectVariantRow } from "@src/query-engine/builders/polymorphic-relation";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import type {
  OperationFragment,
  PlanningFragment,
  StatementStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import {
  isRetryableRace,
  markRaceIfPinned,
} from "@src/query-engine/write-engine/race-retry";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";

const INVALID_POLYMORPHIC_TARGET =
  /Validation failed|Unknown polymorphic target/;

const collectionPlanSchema = (() => {
  const post = s.model({ id: s.int().id(), title: s.string() });
  const clip = s.model({
    id: s.int().id(),
    title: s.string(),
    // SINGULAR inverse: `clip` may hang on at most one board, which is the
    // shape the slot-replacement transfer exists for.
    board: s.toOne(() => board),
  });
  const board = s.model({
    id: s.int().id(),
    label: s.string(),
    items: s.toMany(
      { post: () => post, clip: () => clip },
      { values: { post: "plan.post.v1", clip: "plan.clip.v1" } }
    ),
  });
  return { post, clip, board };
})();

prepareSchema(collectionPlanSchema);

function collectionUpdate(
  driver: AnyDriver,
  data: Record<string, unknown>
): UpdateOperation {
  const registry = createSchemaRegistry(collectionPlanSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(collectionPlanSchema, registry)
  );
  return new UpdateOperation(engine, collectionPlanSchema.board, {
    where: { id: 1 },
    data,
    select: { id: true },
  });
}

test("collection step ids are VARIANT-QUALIFIED, so no `#N` suffix appears", () => {
  // The carrier's name is `items.post` / `items.clip`, not `items`. A shared
  // `items` name across variants would allocate `items.find`, `items.find#1`,
  // `items.find#2` — ids whose meaning depends on emission order. This is the
  // pin that says the qualification is a decision, not an accident.
  const operation = collectionUpdate(new PGliteDriver(), {
    items: {
      connect: [
        { type: "post", where: { id: 10 } },
        { type: "clip", where: { id: 20 } },
      ],
    },
  });
  const planned = ids(operation.planning());
  expect(planned).toContain("post.find");
  expect(planned).toContain("clip.find");
  expect(planned.filter((id) => id.includes("#"))).toEqual([]);
});

test("the batch singular transfer compiles NO write postcondition", () => {
  // `OperationExecutor.compileToEntries` fails closed on a postcondition it
  // cannot enforce in batch mode, and §9.4 adds no batch-postcondition
  // mechanism for this feature. So the transfer's ONLY enforcement on this
  // substrate is its in-batch premises plus the target-side UNIQUE — this is a
  // PLAN-level assertion of that, not a behavioral one.
  const operation = collectionUpdate(new BatchOnlyPGliteDriver(), {
    items: { connect: [{ type: "clip", where: { id: 20 } }] },
  });
  const planning = operation.planning();
  const known: Record<string, unknown> = {};
  for (const step of planning.steps) {
    known[`${step.id}.rows`] =
      step.id === "board.find" ? [{ id: 1 }] : [{ id: 20 }];
  }
  // The owner capture answers "someone else holds it", which is the arm that
  // WRITES — a vacate followed by an insert. Neither may carry `expects`.
  const capture = planning.steps.find((step) =>
    step.id.endsWith(".slot.owners")
  );
  if (!capture) throw new Error("expected a singular-slot owner capture");
  known[`${capture.id}.rows`] = [{ boardId: 2 }];
  const compiled = operation.compile(known);
  for (const step of compiled.steps) {
    if (step.kind === "write") expect(step.expects).toBeUndefined();
  }
});

test("the collection `set` barrier sits BETWEEN the guards and the writes", () => {
  // §4's order, spelled by the coordinator rather than inherited from the
  // root's bucketing: every leaf's captured-fact guards, then ONE clear per
  // configured member table in declaration order, then every leaf's writes.
  const operation = collectionUpdate(new BatchOnlyPGliteDriver(), {
    items: { set: [{ type: "post", where: { id: 10 } }] },
  });
  const planning = operation.planning();
  const known: Record<string, unknown> = {};
  for (const step of planning.steps) {
    known[`${step.id}.rows`] =
      step.id === "board.find" ? [{ id: 1 }] : [{ id: 10 }];
  }
  const steps = operation.compile(known).steps;
  const clears = steps
    .map((step, index) => ({ id: step.id, kind: step.kind, index }))
    .filter((step) => step.id.endsWith(".set.clear"));
  // BOTH configured variants clear — including `clip`, which this payload never
  // mentions — and each clears exactly once.
  expect(clears).toHaveLength(2);
  expect(new Set(clears.map((clear) => clear.id)).size).toBe(2);
  // THE BARRIER POSITION, as three ordered facts: every guard precedes the
  // first clear, every clear precedes the first membership INSERT, and the
  // clears are contiguous. Asserting only "guards come first" would stay green
  // for a plan that cleared AFTER refilling — which is the exact regression.
  const lastGuard = steps.map((step) => step.kind).lastIndexOf("guard");
  const firstClear = clears[0]!.index;
  const lastClear = clears.at(-1)!.index;
  const firstInsert = steps.findIndex(
    (step) => step.kind === "write" && !step.id.endsWith(".set.clear")
  );
  expect(lastGuard).toBeLessThan(firstClear);
  expect(lastClear).toBeLessThan(firstInsert);
  expect(lastClear - firstClear).toBe(clears.length - 1);
});

/**
 * The SINGULAR COLLECTION INVERSE's own plan, read from the VARIANT end
 * (`clip.board`). Every row below is a shape claim the behavioural matrix cannot
 * make: two lowerings can leave one well-formed database in the same state and
 * still differ in what they would do to a malformed or concurrently-moving one.
 */
function inverseUpdate(
  driver: AnyDriver,
  data: Record<string, unknown>
): UpdateOperation {
  const registry = createSchemaRegistry(collectionPlanSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(collectionPlanSchema, registry)
  );
  return new UpdateOperation(engine, collectionPlanSchema.clip, {
    where: { id: 20 },
    data,
    select: { id: true },
  });
}

/** Every planning read answered: the root locate, then the owner probes. */
function inversePlanning(
  operation: UpdateOperation,
  ownerRows: readonly Record<string, unknown>[]
): Record<string, unknown> {
  const known: Record<string, unknown> = {};
  for (const step of operation.planning().steps) {
    known[`${step.id}.rows`] =
      step.id === "clip.locate" ? [{ id: 20 }] : ownerRows;
  }
  return known;
}

/** A compiler-only MySQL carrier: the test observes planned steps, never a server. */
class MySqlPlanDriver extends Driver<null, null> {
  readonly adapter = new MySQLAdapter();

  constructor() {
    super("mysql", "singular-member-junction-plan");
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(_client: null): Promise<void> {
    // This compiler-only driver owns no client.
  }

  protected async execute<T>(
    _client: null,
    _statement: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(
    client: null,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, statement, params ?? [], context);
  }

  protected async transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    return execute(null);
  }
}

function emptySlotPlanning(
  operation: UpdateOperation
): Record<string, unknown> {
  const known: Record<string, unknown> = {};
  for (const step of operation.planning().steps) {
    known[`${step.id}.rows`] = step.id.endsWith(".slot.owners")
      ? []
      : [{ id: 1 }];
  }
  return known;
}

function junctionInsert(fragment: OperationFragment): WriteStep {
  const inserts = fragment.steps.filter(
    (step): step is WriteStep =>
      step.kind === "write" &&
      step.statement.toStatement("?").includes("INSERT INTO `board_items_clip`")
  );
  const [insert] = inserts;
  if (!insert || inserts.length !== 1) {
    throw new Error("expected exactly one singular member junction insert");
  }
  return insert;
}

test("a MySQL singular member insert surfaces a different-owner collision", () => {
  const direct = collectionUpdate(new MySqlPlanDriver(), {
    items: { connect: [{ type: "clip", where: { id: 20 } }] },
  });
  const inverse = inverseUpdate(new MySqlPlanDriver(), {
    board: { connect: { id: 1 } },
  });
  const inserts = [
    junctionInsert(direct.compile(emptySlotPlanning(direct))),
    junctionInsert(inverse.compile(emptySlotPlanning(inverse))),
  ];
  const membershipPin = {
    fields: ["boardId", "clipId"],
    table: "board_items_clip",
    columns: ["boardId", "clipId"],
    constraints: ["board_items_clip_pkey", "PRIMARY"],
  };

  for (const insert of inserts) {
    // A no-op MySQL duplicate update would make the target-side UNIQUE disappear
    // as a successful reconnect. The plain INSERT lets that occupancy conflict
    // reach the pin classifier instead.
    expect(insert.statement.toStatement("?")).not.toContain(
      "ON DUPLICATE KEY UPDATE"
    );
    expect(insert.racePin).toEqual(membershipPin);
    const pin = insert.racePin;
    if (!pin) throw new Error("expected a membership-primary-key race pin");

    const exactDuplicate = new UniqueConstraintError("exact membership", {
      meta: {
        table: "board_items_clip",
        columns: ["boardId", "clipId"],
      },
    });
    markRaceIfPinned(exactDuplicate, pin);
    expect(isRetryableRace(exactDuplicate)).toBe(true);

    // A synchronized second adopter has the same target but a different owner.
    // Its target-side UNIQUE must surface, so the routed retry cannot report two
    // successful adopters from the same observed-empty slot.
    const occupiedTarget = new UniqueConstraintError("occupied target", {
      meta: { table: "board_items_clip", columns: ["clipId"] },
    });
    markRaceIfPinned(occupiedTarget, pin);
    expect(isRetryableRace(occupiedTarget)).toBe(false);
  }
});

test("a MySQL exact-membership no-op checks only the membership key", () => {
  const adapter = new MySQLAdapter();
  const scope = scopeFor(adapter, collectionPlanSchema.board);
  const relation = variantCarrier(scope, "items");
  if (!relation || isVariantRowCarrier(relation)) {
    throw new Error("expected the direct polymorphic collection");
  }
  const member = relation.edge.members.find(
    (candidate) => candidate.variant === "clip"
  );
  if (!member) throw new Error("expected the singular clip member");
  const junction = bindPolymorphicCollectionMember(scope, relation, member);
  const materialized = new JunctionStatements(
    scope,
    false
  ).materializeJunctionInsert(
    junction,
    { parentValue: { id: 1 }, targetValue: { id: 20 } },
    "exactMembershipNoop"
  );

  const statement = materialized.statement.toStatement("?");
  expect(statement).toContain(
    "LEFT JOIN `board_items_clip` AS `__viborm_junction_membership`"
  );
  expect(statement).toContain(
    "ON (`__viborm_junction_membership`.`boardId` = ? AND `__viborm_junction_membership`.`clipId` IN (`__viborm_junction_target`.`id`))"
  );
  expect(statement).toContain(
    "`__viborm_junction_membership`.`boardId` IS NULL"
  );
  expect(statement).not.toContain("NOT EXISTS");
  expect(statement).toContain("FROM `clip` AS `__viborm_junction_target`");
  expect(statement).toContain("`__viborm_junction_target`.`id` = ?");
  expect(statement).not.toContain("ON DUPLICATE KEY UPDATE");
  expect(materialized.racePin).toEqual({
    fields: ["boardId", "clipId"],
    table: "board_items_clip",
    columns: ["boardId", "clipId"],
    constraints: ["board_items_clip_pkey", "PRIMARY"],
  });
});

test("the singular inverse `delete` scopes to ONE captured owner, never a connected set", () => {
  // H5. The dead junction lowering turned `delete: true` into
  // `{kind: "deleteMany", filters: [{}]}`, whose `compileDeleteMany` takes the
  // whole CONNECTED SET over the empty filter and deletes it through
  // `membership.target.model` — in this reversed orientation, the polymorphic
  // OWNER. On a well-formed member table the connected set has one element, so
  // NO state assertion can tell the two apart; the SQL can.
  const operation = inverseUpdate(new PGliteDriver(), {
    board: { delete: true },
  });
  const compiled = operation.compile(inversePlanning(operation, [{ id: 2 }]));
  const ownerDelete = compiled.steps.find((step) => step.id === "board.delete");
  if (!ownerDelete || ownerDelete.kind !== "write") {
    throw new Error("expected one owner delete");
  }
  const prepared = new PGliteDriver()._prepare(ownerDelete.statement);
  // ONE row, addressed by its captured row key — not `IN (…)` over a set, and
  // not a correlated subquery over the membership.
  expect(prepared.sql).toBe(
    'DELETE FROM "board" WHERE "board"."id" = $1 RETURNING "id" AS "id", "label" AS "label"'
  );
  expect(prepared.params).toEqual([2]);
  // …and exactly one owner delete exists, so a second captured row could not
  // quietly ride along.
  expect(
    compiled.steps.filter((step) => step.id.startsWith("board.delete"))
  ).toHaveLength(1);

  // The MEMBER row goes by the variant side alone — a singular slot names no
  // selector, so nothing scopes this delete to a particular owner.
  const memberDelete = compiled.steps.find(
    (step) => step.id === "board.junction.delete"
  );
  if (!memberDelete || memberDelete.kind !== "write") {
    throw new Error("expected one member delete");
  }
  const memberSql = new PGliteDriver()._prepare(memberDelete.statement);
  expect(memberSql.sql).toBe(
    'DELETE FROM "board_items_clip" WHERE "clipId" = $1'
  );
  expect(memberSql.params).toEqual([20]);
});

test("`disconnect: true` is ONE member-row delete and no probe at all", () => {
  const operation = inverseUpdate(new PGliteDriver(), {
    board: { disconnect: true },
  });
  // No membership probe: a singular slot needs no selector, so there is nothing
  // to resolve before the delete. Only the root locate plans.
  expect(operation.planning().steps.map((step) => step.id)).toEqual([
    "clip.locate",
  ]);
  const compiled = operation.compile(inversePlanning(operation, []));
  expect(
    compiled.steps
      .filter((step) => step.id.startsWith("board."))
      .map((s) => s.id)
  ).toEqual(["board.junction.delete"]);
});

test("a composed payload lowers vacate, then supplier, then modify", () => {
  // H2. `RELATION_MUTATION_KEYS` lists `update` third and `connect` ninth, so
  // the PARSED entry order is (disconnect, update, connect). The Part reads the
  // order from `classifyToOneComposition` — the same owner `OwnWriteRelation`
  // reads — so the emitted steps are the canonical order instead.
  const operation = inverseUpdate(new PGliteDriver(), {
    board: {
      disconnect: true,
      connect: { id: 2 },
      update: { label: "supplied" },
    },
  });
  const compiled = operation.compile(inversePlanning(operation, [{ id: 2 }]));
  const emitted = compiled.steps
    .map((step) => step.id)
    .filter((id) => id.startsWith("board."));
  expect(emitted).toEqual([
    "board.junction.delete",
    "board.junction.insert",
    "board.update",
  ]);
});

const polymorphicPlanSchema = (() => {
  const author = s.model({
    id: s.int().id(),
    name: s.string(),
    comments: s.toMany(() => comment),
  });
  const post = s.model({ id: s.int().id(), title: s.string() });
  const video = s.model({ id: s.int().id(), title: s.string() });
  const comment = s.model({
    id: s.int().id(),
    body: s.string(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    primary: s
      .toOne(
        { post: () => post, video: () => video },
        { values: { post: "primary.post.v1", video: "primary.video.v1" } }
      )
      .optional(),
    secondary: s
      .toOne(
        { post: () => post, video: () => video },
        {
          values: {
            post: "secondary.post.v1",
            video: "secondary.video.v1",
          },
        }
      )
      .optional(),
  });
  return { author, post, video, comment };
})();

prepareSchema(polymorphicPlanSchema);

function ids(fragment: PlanningFragment | OperationFragment): string[] {
  return fragment.steps.map((step) => step.id);
}

function statement(
  fragment: PlanningFragment | OperationFragment,
  id: string
): StatementStep {
  const step = fragment.steps.find((candidate) => candidate.id === id);
  if (!step || step.kind === "guard" || step.kind === "recordSeries") {
    throw new Error(`Expected statement '${id}'.`);
  }
  return step;
}

test("collection order is ordinary-then-polymorphic, NOT payload key order", () => {
  // The parsed relation collection groups every ordinary relation before every
  // polymorphic one, each bucket in payload key order. This payload spells the
  // polymorphic fields FIRST; the plan must still open with the ordinary
  // author.find. A collector that switched to raw payload order would emit
  // post.find before author.find and rename the duplicate suffix.
  const driver = new BatchOnlyPGliteDriver();
  const registry = createSchemaRegistry(polymorphicPlanSchema);
  const args = {
    data: {
      id: 1,
      body: "ordered",
      primary: { connect: { type: "post", where: { id: 10 } } },
      author: { connect: { id: 10 } },
      secondary: { connect: { type: "post", where: { id: 11 } } },
    },
    select: { id: true },
  };
  const engine = new QueryEngine(
    driver,
    createModelRegistry(polymorphicPlanSchema, registry)
  );
  const operation = new CreateOperation(
    engine,
    polymorphicPlanSchema.comment,
    args
  );

  expect(ids(operation.planning())).toEqual([
    "author.find",
    "post.find",
    "post.find#1",
  ]);
});

test("two same-target polymorphic fields preserve ordered steps and root pairs", () => {
  const driver = new BatchOnlyPGliteDriver();
  const registry = createSchemaRegistry(polymorphicPlanSchema);
  const args = {
    data: {
      id: 1,
      body: "ordered",
      author: { connect: { id: 10 } },
      primary: { connect: { type: "post", where: { id: 10 } } },
      secondary: { connect: { type: "post", where: { id: 11 } } },
    },
    select: { id: true },
  };
  const engine = new QueryEngine(
    driver,
    createModelRegistry(polymorphicPlanSchema, registry)
  );
  const operation = new CreateOperation(
    engine,
    polymorphicPlanSchema.comment,
    args
  );

  const planning = operation.planning();
  expect(ids(planning)).toEqual(["author.find", "post.find", "post.find#1"]);
  const compiled = operation.compile({
    "author.find.rows": [{ id: 10 }],
    "post.find.rows": [{ id: 10 }],
    "post.find#1.rows": [{ id: 11 }],
  });
  expect(ids(compiled)).toEqual([
    "author.guard.exists",
    "post.guard.exists",
    "post.guard.exists#1",
    "comment.create",
    "comment.select",
  ]);

  const prepared = new PGliteDriver()._prepare(
    statement(compiled, "comment.create").statement
  );
  expect(prepared.sql).toBe(
    'INSERT INTO "comment" ("id", "body", "authorId", "primary_type", "primary_id", "secondary_type", "secondary_id") VALUES ($1, $2, CAST($3 AS INTEGER), $4, CAST($5 AS INTEGER), $6, CAST($7 AS INTEGER))'
  );
  expect(prepared.params).toEqual([
    1,
    "ordered",
    10,
    "primary.post.v1",
    10,
    "secondary.post.v1",
    11,
  ]);
});

test("the direct polymorphic target boundary refuses at construction, eagerly", () => {
  // §6.1.4's boundary: resolvePolymorphicEdge answers at program construction,
  // for every polymorphic payload — INCLUDING an upsert arm execution never
  // takes. Both pins here are timing pins: no execution, no driver round trip.
  const scope = scopeFor(new PostgresAdapter(), polymorphicPlanSchema.comment);
  const info = variantCarrier(scope, "primary");
  // Package C widened the scope to carry both stored descriptors; the row-held
  // edge resolver stays row-held-only, so the arm is named at the call.
  if (!(info && isVariantRowCarrier(info))) {
    throw new Error("expected row-held polymorphic relation info for primary");
  }
  // The engine boundary owns this sentence; the validation layer refuses the
  // public spelling earlier, so this message is an internal contract.
  expect(() => selectVariantRow(info, "bogus")).toThrow(
    "Unknown polymorphic target 'bogus' for relation 'primary'."
  );

  // Public timing half: a malformed polymorphic envelope on the UPDATE arm of
  // an upsert refuses at construction even though no arm has been selected.
  const registry = createSchemaRegistry(polymorphicPlanSchema);
  const engine = new QueryEngine(
    new BatchOnlyPGliteDriver(),
    createModelRegistry(polymorphicPlanSchema, registry)
  );
  expect(() => {
    const operation = new UpsertOperation(
      engine,
      polymorphicPlanSchema.comment,
      {
        where: { id: 1 },
        create: { id: 1, body: "b", author: { connect: { id: 10 } } },
        update: {
          primary: { connect: { type: "bogus", where: { id: 10 } } },
        },
      }
    );
    operation.planning();
  }).toThrow(INVALID_POLYMORPHIC_TARGET);
});

test("a tree carrying a direct-polymorphic create arm DECLINES the CTE fold", () => {
  // The fold's order-insensitivity claim was measured for ordinary FK arms
  // only. A polymorphic-storage create arm stays unclassified, so the tree
  // keeps its multi-statement shape — statement count is a pinned surface.
  const registry = createSchemaRegistry(polymorphicPlanSchema);
  const engine = new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(polymorphicPlanSchema, registry)
  );
  const operation = new CreateOperation(engine, polymorphicPlanSchema.author, {
    data: {
      id: 5,
      name: "n",
      comments: {
        create: {
          id: 6,
          body: "b",
          primary: { create: { type: "post", data: { id: 7, title: "t" } } },
        },
      },
    },
    select: { id: true },
  });
  expect(ids(operation.planning())).toEqual([]);
  const compiled = operation.compile({});
  expect(ids(compiled)).toEqual([
    "author.create",
    "post.create",
    "comment.create",
    "author.select",
  ]);
});
