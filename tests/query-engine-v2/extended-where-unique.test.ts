import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { TransactionError } from "@errors";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { isSql } from "@sql";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";
import type { StatementStep } from "../../src/query-engine-v2/OperationFragment";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
import { UpsertOperation } from "../../src/query-engine-v2/UpsertOperation";
import {
  extendedWhereUniqueSchema,
  runExtendedWhereUniqueBehavior,
} from "./extended-where-unique-behavior";

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

// The whole extended-whereUnique surface on PGlite, both substrates. The driver
// matrix legs run the same module from tests/drivers/*.test.ts.
runExtendedWhereUniqueBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runExtendedWhereUniqueBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// STRUCTURAL: the create arm's racePin, and its deliberate absence.
//
// The behavior suite proves the V3001 surfaces. This proves WHY it is not
// retried: with an extended `where` the locate never established the "unique key
// K is free" premise a `racePin` claims, so the pin is withheld and the
// violation is classified as the genuine conflict it is. The plain-`where` arm
// is the falsification — it must still carry the pin, or the assertion above
// would pass for the wrong reason (a pin nobody ever attaches).
// ---------------------------------------------------------------------------

function buildUpsertSteps(where: Record<string, unknown>): StatementStep[] {
  const schemas = createSchemaRegistry(extendedWhereUniqueSchema);
  const engine = new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(extendedWhereUniqueSchema, schemas)
  );
  const operation = new UpsertOperation(
    engine,
    extendedWhereUniqueSchema.account,
    {
      where,
      create: { id: 9, email: "gone@x", status: "active", score: 0 },
      update: { score: { increment: 1 } },
      select: { id: true },
    }
  );
  // An empty locate result is the create arm — the exact branch under test.
  const fragment = operation.compile({
    [`${operation.planning().steps[0]!.id}.rows`]: [],
  });
  return fragment.steps.filter(
    (step): step is StatementStep => step.kind === "write"
  );
}

test("a PLAIN unique where pins the create arm as raceable", () => {
  const writes = buildUpsertSteps({ email: "gone@x" });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.racePin).toBeDefined();
  expect(writes[0]?.racePin?.fields).toEqual(["email"]);
});

test("an EXTENDED unique where withholds the create-arm racePin", () => {
  const writes = buildUpsertSteps({ email: "gone@x", status: "active" });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.racePin).toBeUndefined();
});

test("the withheld pin is about the FILTER, not the discriminator's shape", () => {
  // Same discriminator, filter smuggled through AND: still withheld.
  const writes = buildUpsertSteps({
    email: "gone@x",
    AND: [{ status: "active" }],
  });
  expect(writes[0]?.racePin).toBeUndefined();
});

// ---------------------------------------------------------------------------
// STRUCTURAL: the create arm's three identity sources, and their order.
//
// `UpsertOperation.createArmIdentity` decides from the CREATE DATA how the row it
// is about to INSERT will be addressed: a literal primary key, a COMPLETE unique
// constraint the create data carries, or — last — the identity a DB-generated
// `increment` PK forces the INSERT to CAPTURE. The behavior suite proves each
// source returns the created row; these tests prove WHICH source is taken, which
// is what the capture-free preference is about: only source (3) makes the
// statement carry an output, and only an operation carrying an `insertId` output
// is refused from a shared driver batch. The whole point is that the mainstream
// model never reaches it.
// ---------------------------------------------------------------------------

const identitySchema = (() => {
  // Compound PK whose second member is DB-generated, plus a single-column unique.
  // A literal PK is impossible (the create data cannot carry `seq`), and the
  // captured-increment source does not apply either (it covers a SINGLE generated
  // PK — a compound one cannot be propagated). Before the unique-from-create-data
  // source existed this shape was REFUSED outright, though it had answered before
  // the read-back moved off the `where`. Its DDL is not portable across the driver
  // matrix (SQLite cannot AUTOINCREMENT a compound-PK member, MySQL needs the
  // AUTO_INCREMENT column first in a key), which is why this schema lives here —
  // compiled everywhere, and run against PostgreSQL only.
  const seat = s
    .model({
      tenantId: s.int(),
      seq: s.int().increment(),
      email: s.string().unique(),
      score: s.int(),
    })
    .id(["tenantId", "seq"])
    .map("ext_wu_seats");
  // The same compound generated PK with NO other unique: nothing in the create
  // data can name the inserted row, so this is the shape the refusal is FOR.
  const slot = s
    .model({
      tenantId: s.int(),
      seq: s.int().increment(),
      label: s.string(),
      score: s.int(),
    })
    .id(["tenantId", "seq"])
    .map("ext_wu_slots");
  // A compound unique (not the PK) alongside a generated PK: the create-data
  // source is complete only when the create data carries EVERY member.
  const badge = s
    .model({
      id: s.int().id().increment(),
      org: s.string(),
      slug: s.string(),
      score: s.int(),
    })
    .unique(["org", "slug"])
    .map("ext_wu_badges");
  // The same, but with a NULLABLE member — the create data can leave the compound
  // unique incomplete, either by omitting the member or by writing NULL into it.
  const tag = s
    .model({
      id: s.int().id().increment(),
      org: s.string(),
      region: s.string().nullable(),
      score: s.int(),
    })
    .unique(["org", "region"])
    .map("ext_wu_tags");
  // A NULLABLE unique: SQL does not equate NULLs, so `code: null` in the create
  // data names no row and must not be taken as an identity.
  const coupon = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique().nullable(),
      score: s.int(),
    })
    .map("ext_wu_coupons");
  return { badge, coupon, seat, slot, tag };
})();

hydrateSchemaNames(identitySchema);

/** Compile an upsert's CREATE arm (an empty locate result) and hand back its
 *  write step plus the terminal read that addresses the row it wrote. */
function compileCreateArm(
  model: Model<any>,
  args: { where: Record<string, unknown>; create: Record<string, unknown> }
): { write: StatementStep; terminal: StatementStep } {
  const schemas = createSchemaRegistry(identitySchema);
  const engine = new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(identitySchema, schemas)
  );
  const operation = new UpsertOperation(engine, model, {
    ...args,
    update: { score: { increment: 1 } },
    select: { score: true },
  });
  const fragment = operation.compile({
    [`${operation.planning().steps[0]!.id}.rows`]: [],
  });
  const statements = fragment.steps.filter(
    (step): step is StatementStep => step.kind !== "guard"
  );
  const write = statements.find((step) => step.kind === "write");
  const terminal = statements.find((step) => step.kind === "read");
  if (!(write && terminal)) {
    throw new Error(
      "create arm did not compile to a write plus a terminal read"
    );
  }
  return { write, terminal };
}

/** The SQL the terminal read runs, as text plus bound values. */
function terminalSql(step: StatementStep): { text: string; values: unknown[] } {
  const statement = step.statement;
  if (!isSql(statement)) throw new Error("terminal read is not one Sql");
  return { text: statement.toStatement("$n"), values: statement.values };
}

test("compound PK with a generated member reads back by the create-data unique", () => {
  // Finding 1: this shape ANSWERED before the read-back moved off the `where`,
  // then regressed to a typed refusal. It answers again — through an identity
  // derived from the create data, so it is not the old wrong-row read-back.
  const { write, terminal } = compileCreateArm(identitySchema.seat, {
    where: { email: "seat@x" },
    create: { tenantId: 4, email: "other@x", score: 1 },
  });
  // Capture-free: the INSERT produces nothing for a later step to consume.
  expect(write.outputs).toEqual({});
  const { text, values } = terminalSql(terminal);
  expect(text).toContain('"email"');
  // The value bound is the one the CREATE wrote, never the one the `where` names.
  expect(values).toContain("other@x");
  expect(values).not.toContain("seat@x");
});

test("a literal primary key outranks the create-data unique", () => {
  const { write, terminal } = compileCreateArm(identitySchema.seat, {
    where: { email: "seat@x" },
    create: { tenantId: 4, seq: 11, email: "other@x", score: 1 },
  });
  expect(write.outputs).toEqual({});
  const { text, values } = terminalSql(terminal);
  expect(text).toContain('"tenantId"');
  expect(text).toContain('"seq"');
  expect(values).toEqual(expect.arrayContaining([4, 11]));
});

test("the create-data unique outranks the captured increment PK", () => {
  // The mainstream model — single `increment` PK, unique in the create data. The
  // capture-free identity is preferred, so the INSERT carries no `insertId`
  // output and the operation stays mergeable into a shared driver batch.
  const { write, terminal } = compileCreateArm(identitySchema.badge, {
    where: { id: 999 },
    create: { org: "acme", slug: "gold", score: 1 },
  });
  expect(write.outputs).toEqual({});
  const { text, values } = terminalSql(terminal);
  expect(text).toContain('"org"');
  expect(text).toContain('"slug"');
  expect(values).toEqual(expect.arrayContaining(["acme", "gold"]));
});

const CAPTURED = { id: { kind: "firstRowField", field: "id" } };
const NO_UNIQUE_IDENTITY = /nor any complete unique constraint of the model/;

test("an INCOMPLETE compound unique is no identity — the capture is taken", () => {
  // Half a compound key is a filter, never an identity. `tag`'s `org_region`
  // unique is complete only when the create data carries BOTH members; omitting
  // the nullable one leaves it incomplete and the arm falls through to the
  // capture. The counter-case is the sibling test above: `badge`'s complete
  // `org_slug` IS taken, so this is not passing because compounds never count.
  const omitted = compileCreateArm(identitySchema.tag, {
    where: { id: 999 },
    create: { org: "acme", score: 1 },
  });
  expect(omitted.write.outputs).toEqual(CAPTURED);
});

test("a NULL member in the create data is no identity — the capture is taken", () => {
  // SQL unique constraints do not equate NULLs, so a unique whose create-data
  // value is NULL names no row. Taking it would make the terminal read match
  // nothing — and in batch mode, where the read carries no exactly-one-row
  // postcondition, that miss would be SILENT. Both the compound member and the
  // single-column unique are pinned.
  const compoundMember = compileCreateArm(identitySchema.tag, {
    where: { id: 999 },
    create: { org: "acme", region: null, score: 1 },
  });
  expect(compoundMember.write.outputs).toEqual(CAPTURED);
  const singleColumn = compileCreateArm(identitySchema.coupon, {
    where: { id: 999 },
    create: { code: null, score: 1 },
  });
  expect(singleColumn.write.outputs).toEqual(CAPTURED);
});

test("no identity source at all is a typed refusal, not a guess", () => {
  // The refusal that REMAINS: a compound generated PK and no other unique, so the
  // create data names no row. It is raised only when the create arm is TAKEN.
  expect(() =>
    compileCreateArm(identitySchema.slot, {
      where: { tenantId_seq: { tenantId: 4, seq: 11 } },
      create: { tenantId: 4, label: "none", score: 1 },
    })
  ).toThrow(UnsupportedOperationError);
  expect(() =>
    compileCreateArm(identitySchema.slot, {
      where: { tenantId_seq: { tenantId: 4, seq: 11 } },
      create: { tenantId: 4, label: "none", score: 1 },
    })
  ).toThrow(NO_UNIQUE_IDENTITY);
});

test(
  "BEHAVIOR: the compound-generated-PK model answers, and answers correctly",
  { timeout: 30_000 },
  async () => {
    // The compile-level witness above says which identity is taken; this says the
    // shape ANSWERS again end to end, on both arms, and that the answer is the
    // created row rather than the live one the `where` names. PostgreSQL is the
    // only dialect in the matrix whose DDL accepts an AUTO-generated compound-PK
    // member, so this leg is PGlite-only by necessity, not by convenience.
    const client = createClient({
      schema: identitySchema,
      driver: new PGliteDriver(),
    });
    await push(client, { force: true });
    try {
      // `create` cannot reach this model (mutation-identity refuses to propagate a
      // generated compound PK), so seed through `createMany`.
      await client.seat.createMany({
        data: [{ tenantId: 1, email: "seed@x", score: 7 }],
      });
      // CREATE arm: the discriminator names the seeded row, the filter excludes
      // it, and `create` writes a different unique. The created row must come back.
      expect(
        await client.seat.upsert({
          where: { email: "seed@x", score: { gt: 100 } },
          create: { tenantId: 4, email: "other@x", score: 1 },
          update: { score: { increment: 100 } },
          select: { tenantId: true, email: true, score: true },
        })
      ).toEqual({ tenantId: 4, email: "other@x", score: 1 });
      // The row the `where` named is untouched — no update ran on it.
      expect(
        await client.seat.findUnique({
          where: { email: "seed@x" },
          select: { tenantId: true, score: true },
        })
      ).toEqual({ tenantId: 1, score: 7 });
      // UPDATE arm: a matching `where` still locates and updates, so the create
      // arm is not passing by swallowing everything.
      expect(
        await client.seat.upsert({
          where: { email: "seed@x" },
          create: { tenantId: 9, email: "seed@x", score: 0 },
          update: { score: { increment: 5 } },
          select: { tenantId: true, email: true, score: true },
        })
      ).toEqual({ tenantId: 1, email: "seed@x", score: 12 });
      expect(await client.seat.count()).toBe(2);
    } finally {
      await client.$disconnect();
    }
  }
);

test(
  "BEHAVIOR: the remaining refusal is typed, and its model is already write-capped",
  { timeout: 30_000 },
  async () => {
    // `slot` is the shape the refusal is FOR: a generated compound PK with no
    // other unique. The honest cost is bounded — a single-row `create` on it is
    // ALREADY refused further upstream, by mutation-identity's generated-compound
    // -PK guard, while `createMany` and reads work. So the upsert refusal narrows
    // a model that was never writable through the single-row create path either.
    const client = createClient({
      schema: identitySchema,
      driver: new PGliteDriver(),
    });
    await push(client, { force: true });
    try {
      const createRejection = await client.slot
        .create({ data: { tenantId: 1, label: "a", score: 1 } })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect((createRejection as Error).message).toContain(
        "Nested create cannot propagate generated compound primary keys"
      );
      expect(
        await client.slot.createMany({
          data: [{ tenantId: 1, label: "b", score: 2 }],
        })
      ).toEqual({ count: 1 });
      expect(
        await client.slot.findMany({ select: { tenantId: true, label: true } })
      ).toEqual([{ tenantId: 1, label: "b" }]);
      const upsertRejection = await client.slot
        .upsert({
          where: { tenantId_seq: { tenantId: 1, seq: 99 } },
          create: { tenantId: 1, label: "c", score: 3 },
          update: { score: { increment: 1 } },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(upsertRejection).toBeInstanceOf(UnsupportedOperationError);
      expect((upsertRejection as Error).message).toContain(
        "nor any complete unique constraint of the model"
      );
      // The refusal fires only when the create arm is TAKEN — a located row still
      // updates on the very same model.
      expect(
        await client.slot.upsert({
          where: { tenantId_seq: { tenantId: 1, seq: 1 } },
          create: { tenantId: 1, label: "c", score: 3 },
          update: { score: { increment: 1 } },
          select: { label: true, score: true },
        })
      ).toEqual({ label: "b", score: 3 });
    } finally {
      await client.$disconnect();
    }
  }
);

// ---------------------------------------------------------------------------
// THE SHARED-BATCH SEAM: `$transaction([…])` on a batch-only driver.
//
// The shared merge cannot isolate an operation's `insertId` scratch, so the one
// remaining capture-needing shape is refused there — typed, and only when the
// create arm is taken. The behavior suite proves the capture-free shapes merge on
// both substrates; this proves the refusal is still a refusal, and still narrow.
// ---------------------------------------------------------------------------

test(
  "$transaction([…]): a capture-needing create arm is refused, typed",
  { timeout: 30_000 },
  async () => {
    const client = createClient({
      schema: extendedWhereUniqueSchema,
      driver: new BatchOnlyPGliteDriver(),
    });
    await push(client, { force: true });
    try {
      const rejection = await client
        .$transaction([
          client.note.upsert({
            where: { id: 999 },
            create: { label: "captured", status: "fresh", score: 1 },
            update: { score: { increment: 1 } },
            select: { label: true },
          }),
        ])
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(rejection).toBeInstanceOf(TransactionError);
      expect((rejection as Error).message).toContain(
        "cannot merge an insertId-scratch operation into a shared driver batch"
      );
      // The same operation on its OWN atomic unit is unaffected — the refusal is
      // about the shared merge, not about the capture.
      expect(
        await client.note.upsert({
          where: { id: 999 },
          create: { label: "captured", status: "fresh", score: 1 },
          update: { score: { increment: 1 } },
          select: { label: true, score: true },
        })
      ).toEqual({ label: "captured", score: 1 });
      // …and the UPDATE arm of the very same call merges fine: it never captures.
      // The row the direct call above created is now live, so this locates it.
      const [updated] = await client.$transaction([
        client.note.upsert({
          where: { id: 1 },
          create: { label: "captured", status: "fresh", score: 1 },
          update: { score: { increment: 1 } },
          select: { label: true, score: true },
        }),
      ]);
      expect(updated).toEqual({ label: "captured", score: 2 });
    } finally {
      await client.$disconnect();
    }
  }
);
