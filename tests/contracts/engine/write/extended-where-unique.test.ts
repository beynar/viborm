import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { isSql } from "@sql";
import type {
  ReadStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import {
  extendedWhereUniqueSchema,
  runExtendedWhereUniqueBehavior,
} from "@tests/contracts/engine/write/extended-where-unique-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";

// The whole extended-whereUnique surface on PGlite, both substrates. The driver
// matrix legs run the same module from tests/drivers/*.test.ts.
runExtendedWhereUniqueBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runExtendedWhereUniqueBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
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

function buildUpsertSteps(where: Record<string, unknown>): WriteStep[] {
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
    (step): step is WriteStep => step.kind === "write"
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
  // A literal PK is impossible because create omits `seq`; the complete unique is
  // deliberately preferred over generated-key capture because it is capture-free.
  // Its DDL is not portable across the driver matrix (SQLite cannot AUTOINCREMENT a
  // compound-PK member, MySQL needs the AUTO_INCREMENT column first in a key), so
  // this schema is compiled everywhere and run against PostgreSQL only.
  const seat = s
    .model({
      tenantId: s.int(),
      seq: s.int().increment(),
      email: s.string().unique(),
      score: s.int(),
    })
    .id(["tenantId", "seq"])
    .map("ext_wu_seats");
  // The same compound generated PK with no alternate unique. E6.2 absorbed the
  // one-generated-plus-one-literal shape through their complete row-key union;
  // residual-lift Package A generalizes the same publication owner to multiple
  // database-assigned members in `produced-compound-identity.test.ts`.
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
): { write: WriteStep; terminal: ReadStep } {
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
  const write = fragment.steps.find(
    (step): step is WriteStep => step.kind === "write"
  );
  const terminal = fragment.steps.find(
    (step): step is ReadStep => step.kind === "read"
  );
  if (!(write && terminal)) {
    throw new Error(
      "create arm did not compile to a write plus a terminal read"
    );
  }
  return { write, terminal };
}

/** The SQL the terminal read runs, as text plus bound values. */
function terminalSql(step: ReadStep): { text: string; values: unknown[] } {
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

test("a compound generated PK with no other unique reads back by the PRODUCED key", () => {
  // RETARGETED BY E6.2 (authorized test change: decline → accept-and-execute, same payload). This test read
  // "no identity source at all is a typed refusal, not a guess" and asserted the
  // throw on exactly these arguments. The premise was wrong, not the doctrine: the
  // create data spells `tenantId` and the INSERT produces `seq`, so the read-back
  // has a complete primary key whose every member comes from the write. Nothing is
  // guessed and nothing is re-derived from the `where` — the assertions below are
  // what pins that.
  const { write, terminal } = compileCreateArm(identitySchema.slot, {
    where: { tenantId_seq: { tenantId: 4, seq: 11 } },
    create: { tenantId: 9, label: "none", score: 1 },
  });
  expect(write.outputs).toEqual({
    id: { kind: "firstRowField", field: "seq" },
  });
  const { text, values } = terminalSql(terminal);
  expect(text).toContain('"tenantId"');
  expect(text).toContain('"seq"');
  // The literal member is the CREATE's `tenantId`, never the `where`'s; the
  // generated member is the capture, never the `where`'s `seq`.
  expect(values).toContain(9);
  expect(values).not.toContain(4);
  expect(values).not.toContain(11);
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
      // Seed without needing the generated compound row key as an immediate result.
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
  "BEHAVIOR: root create and upsert publish the produced compound identity",
  { timeout: 30_000 },
  async () => {
    // Package A gives the fresh-record owner the complete ordered row key. Root
    // create and probe-first upsert therefore publish the same generated member.
    const client = createClient({
      schema: identitySchema,
      driver: new PGliteDriver(),
    });
    await push(client, { force: true });
    try {
      expect(
        await client.slot.create({
          data: { tenantId: 1, label: "a", score: 1 },
          select: { tenantId: true, label: true },
        })
      ).toEqual({ tenantId: 1, label: "a" });
      expect(
        await client.slot.createMany({
          data: [{ tenantId: 1, label: "b", score: 2 }],
        })
      ).toEqual({ count: 1 });
      expect(
        await client.slot.findMany({ select: { tenantId: true, label: true } })
      ).toEqual([
        { tenantId: 1, label: "a" },
        { tenantId: 1, label: "b" },
      ]);
      // CREATE arm: the `where` names a `seq` no row holds. The seeded row shares
      // the create's `tenantId`, so a read-back re-derived from the spelled member
      // alone could answer with IT; the produced `seq` is what separates them.
      const made = await client.slot.upsert({
        where: { tenantId_seq: { tenantId: 1, seq: 99 } },
        create: { tenantId: 1, label: "c", score: 3 },
        update: { score: { increment: 1 } },
        select: { tenantId: true, seq: true, label: true, score: true },
      });
      expect(made.label).toBe("c");
      expect(made.tenantId).toBe(1);
      expect(made.seq).not.toBe(99);
      // The seeded row is untouched — the create arm answered with its OWN row.
      expect(
        await client.slot.findMany({
          orderBy: { seq: "asc" },
          select: { label: true, score: true },
        })
      ).toEqual([
        { label: "a", score: 1 },
        { label: "b", score: 2 },
        { label: "c", score: 3 },
      ]);
      // The create-arm identity is decided on the TAKEN arm only — a located row
      // still updates on the very same model.
      expect(
        await client.slot.upsert({
          where: { tenantId_seq: { tenantId: 1, seq: 2 } },
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
// The explicit array is one indivisible native batch. A scalar create arm now returns
// its public projection directly from INSERT, so no generated value crosses into a
// later statement and the arm can merge beside a sibling operation.
// ---------------------------------------------------------------------------

test(
  "$transaction([…]): a capture-needing create arm returns from its INSERT",
  { timeout: 30_000 },
  async () => {
    const client = createClient({
      schema: extendedWhereUniqueSchema,
      driver: new BatchOnlyPGliteDriver(),
    });
    await push(client, { force: true });
    try {
      const [created] = await client.$transaction([
        client.note.upsert({
          where: { id: 999 },
          create: { label: "captured", status: "fresh", score: 1 },
          update: { score: { increment: 1 } },
          select: { id: true, label: true, score: true },
        }),
      ]);
      expect(created).toMatchObject({ label: "captured", score: 1 });
      expect(created.id).not.toBe(999);
      const [updated] = await client.$transaction([
        client.note.upsert({
          where: { id: created.id },
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
