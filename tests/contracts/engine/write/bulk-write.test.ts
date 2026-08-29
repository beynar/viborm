import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { ValidationError } from "@errors";

import { describe, expect, test } from "vitest";
import {
  bulkWriteSchema,
  runBulkWriteBehavior,
} from "@tests/contracts/engine/write/bulk-write-behavior";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

// The bulk-write stragglers on PGlite, both substrates.
runBulkWriteBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runBulkWriteBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

// ---------------------------------------------------------------------------
// Dual-run oracle: identical payloads through the real Direct client and the
// Observed-observed proxy (tx + forced batch), FRESH instance per arm, asserting
// byte-identical persisted state + result + error class/message. The proof that
// both arms of every bulk family agree: `{ count }` and the implicit
// row-returning form reached by adding `select`.
// ---------------------------------------------------------------------------

type RoutedModel = Record<string, (args: Record<string, unknown>) => unknown>;

interface Scenario {
  name: string;
  seed?: (client: ReturnType<typeof makeClient>) => PromiseLike<unknown>;
  act: (client: Record<string, RoutedModel>) => unknown;
  observed: string;
  /**
   * Which implicit-returning arm this payload must take, asserted on the SHAPE
   * of the result in every arm. Parity alone cannot catch a discriminant that
   * drifts the same way in both — and the harness's copy of the discriminant did
   * drift, one wave behind production's `returnsRows`.
   */
  arm?: "rows" | "count";
}

function makeClient(db: PGlite) {
  return createClient({
    schema: bulkWriteSchema,
    driver: new PGliteDriver({ client: db }),
  });
}

async function dump(client: ReturnType<typeof makeClient>) {
  const [gadgets, tickets] = await Promise.all([
    client.gadget.findMany({ orderBy: { id: "asc" } }),
    client.ticket.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { gadgets, tickets };
}

type ArmKind = "direct" | "observed-tx" | "observed-batch";

async function runArm(
  family: PGliteSchemaFamily<typeof bulkWriteSchema>,
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const client = makeClient(family.database);
  await scenario.seed?.(client);

  let result: unknown;
  let error: { name: string; message: string } | undefined;
  let operations: { boundary: "direct" | "production"; operation: string }[] =
    [];
  try {
    if (kind === "direct") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "observed-tx"
          ? new PGliteDriver({ client: family.database })
          : new BatchOnlyPGliteDriver({ client: family.database });
      const observed = observeClientOperations({
        schema: bulkWriteSchema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch (thrown) {
    if (!(thrown instanceof Error)) throw thrown;
    error = { name: thrown.name, message: thrown.message };
  }
  const state = await dump(client);
  return { result, error, state, operations };
}

const scenarios: Scenario[] = [
  {
    name: "updateMany with a filter",
    observed: "updateMany",
    seed: (c) =>
      c.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "A", qty: 1 },
          { id: "g2", code: "c2", name: "B", qty: 9 },
        ],
      }),
    act: (c) =>
      c.gadget!.updateMany!({
        where: { qty: { lt: 5 } },
        data: { name: "Updated", qty: { increment: 1 } },
      }),
  },
  {
    name: "deleteMany with a filter",
    observed: "deleteMany",
    seed: (c) =>
      c.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "A", qty: 1 },
          { id: "g2", code: "c2", name: "B", qty: 9 },
          { id: "g3", code: "c3", name: "C", qty: 2 },
        ],
      }),
    act: (c) => c.gadget!.deleteMany!({ where: { qty: { lt: 5 } } }),
  },
  {
    name: "deleteMany with select returns the deleted rows",
    observed: "deleteMany",
    seed: (c) =>
      c.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "A", qty: 1 },
          { id: "g2", code: "c2", name: "B", qty: 9 },
          { id: "g3", code: "c3", name: "C", qty: 2 },
        ],
      }),
    act: (c) =>
      c.gadget!.deleteMany!({
        where: { qty: { lt: 5 } },
        select: { id: true, name: true },
      }),
  },
  {
    name: "createMany with select (string PK) returns created rows",
    observed: "createMany",
    act: (c) =>
      c.gadget!.createMany!({
        data: [
          { id: "g1", code: "c1", name: "Alpha" },
          { id: "g2", code: "c2", name: "Beta", qty: 5 },
        ],
        select: { id: true, code: true, name: true, qty: true },
      }),
  },
  {
    name: "createMany with select (increment PK) preserves order",
    observed: "createMany",
    act: (c) =>
      c.ticket!.createMany!({
        data: [{ label: "one" }, { label: "two" }, { label: "three" }],
        select: { id: true, label: true },
      }),
  },
  {
    name: "createMany without select returns { count }",
    observed: "createMany",
    act: (c) =>
      c.gadget!.createMany!({
        data: [
          { id: "g1", code: "c1", name: "Alpha" },
          { id: "g2", code: "c2", name: "Beta", qty: 5 },
        ],
      }),
  },
  {
    name: "updateMany with select returns updated rows",
    observed: "updateMany",
    seed: (c) =>
      c.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "A", qty: 1 },
          { id: "g2", code: "c2", name: "B", qty: 2 },
          { id: "g3", code: "c3", name: "C", qty: 10 },
        ],
      }),
    act: (c) =>
      c.gadget!.updateMany!({
        where: { qty: { lt: 5 } },
        data: { qty: { increment: 100 } },
        select: { id: true, qty: true },
      }),
  },
  {
    name: "updateMany with select matching nothing returns []",
    observed: "updateMany",
    seed: (c) => c.gadget.create({ data: { id: "g1", code: "c1", name: "A" } }),
    act: (c) =>
      c.gadget!.updateMany!({
        where: { name: "Nope" },
        data: { qty: 1 },
        select: { id: true },
      }),
  },
  // `omit` is the OTHER spelling of the row-returning discriminant (W5 —
  // `returnsRows` is `select` OR `omit`, because `omit` desugars to a
  // projection). It had no scenario here, and that is exactly why the harness
  // could keep discriminating on `select` alone: production answered rows while
  // the proxy answered `{ count }`, and nothing compared them.
  {
    name: "deleteMany with omit returns the deleted rows",
    observed: "deleteMany",
    arm: "rows",
    seed: (c) =>
      c.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "A", qty: 1 },
          { id: "g2", code: "c2", name: "B", qty: 9 },
        ],
      }),
    act: (c) =>
      c.gadget!.deleteMany!({
        where: { qty: { lt: 5 } },
        omit: { code: true },
      }),
  },
  {
    name: "updateMany with omit returns the updated rows",
    observed: "updateMany",
    arm: "rows",
    seed: (c) =>
      c.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "A", qty: 1 },
          { id: "g2", code: "c2", name: "B", qty: 9 },
        ],
      }),
    act: (c) =>
      c.gadget!.updateMany!({
        where: { qty: { lt: 5 } },
        data: { qty: { increment: 100 } },
        omit: { name: true },
      }),
  },
  {
    name: "createMany with omit returns the created rows",
    observed: "createMany",
    arm: "rows",
    act: (c) =>
      c.gadget!.createMany!({
        data: [
          { id: "g1", code: "c1", name: "Alpha" },
          { id: "g2", code: "c2", name: "Beta", qty: 5 },
        ],
        omit: { qty: true },
      }),
  },
  {
    name: "deleteMany with omit: undefined takes the count arm",
    observed: "deleteMany",
    arm: "count",
    seed: (c) =>
      c.gadget.createMany({
        data: [{ id: "g1", code: "c1", name: "A", qty: 1 }],
      }),
    act: (c) =>
      c.gadget!.deleteMany!({ where: { qty: { lt: 5 } }, omit: undefined }),
  },
];

/**
 * The REMOVAL, pinned at runtime (maintainer decision D-1). The typed client
 * cannot spell `createManyAndReturn` (see
 * tests/client/implicit-returning-types.test.ts); an untyped caller that reaches
 * for it must get a LOUD, named error — not `undefined is not a function`, and
 * never a silent no-op, because the model proxy answers every property with a
 * callable child.
 */
describe("the removed *AndReturn method names (runtime)", () => {
  for (const removed of ["createManyAndReturn", "updateManyAndReturn"]) {
    test(`${removed} fails with a clear unknown-operation error`, async () => {
      const db = new PGlite();
      const client = makeClient(db);
      await syncLiveSchema(client);
      try {
        const untyped = client as unknown as Record<string, RoutedModel>;
        // The proxy still hands back a function — that is exactly why the error
        // has to come from the boundary, and has to name the operation.
        expect(typeof untyped.gadget?.[removed]).toBe("function");
        await expect(
          untyped.gadget?.[removed]?.({
            data: [{ id: "g1", code: "c1", name: "A" }],
          }) as Promise<unknown>
        ).rejects.toThrow(`Unknown operation '${removed}' on model 'gadget'`);
      } finally {
        await client.$disconnect();
      }
    });
  }
});

/**
 * The other half of the removal: a name the client REFUSES to route must never
 * appear in an error the client itself produces. `ValidationError` used to be
 * built from the INTERNAL operation token, so the very same client answered
 *
 *   createMany({ data, select: { nope: true } })
 *     -> "Validation failed for createManyAndReturn: Unknown key: nope"
 *   createManyAndReturn({ data })
 *     -> "Unknown operation 'createManyAndReturn' on model 'gadget'"
 *
 * — telling a caller to fix an operation it says does not exist. The pre-existing
 * regexes could not see it (`/Validation failed for createMany/` is a substring
 * of the wrong string), so these assertions are anchored on the colon AND assert
 * the absence of the internal token.
 *
 * The presence of `select` is the ONLY difference between the two arms, so each
 * family is asserted twice: the row arm (which goes through
 * ManyAndReturnOperation) and the `{ count }` arm, which must report the same
 * name.
 */
describe("a validation error names the operation the caller spelled", () => {
  const badPayloads: {
    family: "createMany" | "updateMany" | "deleteMany";
    withSelect: Record<string, unknown>;
    withoutSelect: Record<string, unknown>;
  }[] = [
    {
      family: "createMany",
      withSelect: {
        data: [{ id: "g1", code: "c1", name: "A" }],
        select: { nope: true },
      },
      withoutSelect: { data: [{ id: "g1", code: "c1", nope: "A" }] },
    },
    {
      family: "updateMany",
      withSelect: { where: {}, data: { nope: 1 }, select: { id: true } },
      withoutSelect: { where: {}, data: { nope: 1 } },
    },
    {
      family: "deleteMany",
      withSelect: { where: {}, select: { nope: true } },
      withoutSelect: { where: { nope: true } },
    },
  ];

  for (const { family, withSelect, withoutSelect } of badPayloads) {
    for (const [arm, payload] of [
      ["rows (select present)", withSelect],
      ["count (select absent)", withoutSelect],
    ] as const) {
      test(`${family} — ${arm}`, async () => {
        const db = new PGlite();
        const client = makeClient(db);
        await syncLiveSchema(client);
        try {
          const untyped = client as unknown as Record<string, RoutedModel>;
          let thrown: unknown;
          try {
            await (untyped.gadget?.[family]?.(payload) as Promise<unknown>);
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(ValidationError);
          const error = thrown as ValidationError;
          expect(error.message).toContain(`Validation failed for ${family}:`);
          expect(error.message).not.toContain("AndReturn");
          // The programmatic surface agrees with the prose, and `meta` — which
          // is what a logger or an error-reporting sink reads — agrees with both.
          expect(error.operation).toBe(family);
          expect(error.meta.operation).toBe(family);
        } finally {
          await client.$disconnect();
        }
      });
    }
  }
});

/**
 * The RUNTIME half of "`select: undefined` is an absent select". The type-level
 * half lives in tests/client/implicit-returning-types.test.ts, and for a while
 * that was the ONLY half: `createMany`/`updateMany` actually threw
 * "Validation failed … Expected object" on the spelling their own doc comments
 * promised took the `{ count }` arm, while `deleteMany` — whose args schema is
 * fully partial rather than `atLeast` — honored it. Three families, one
 * documented surface, two answers. Fixed in the object primitive so the rule is
 * the schema library's, not each operation's.
 */
const CREATE_MANY_VALIDATION_FAILURE = /Validation failed for createMany/;
const DELETE_MANY_VALIDATION_FAILURE = /Validation failed for deleteMany/;

describe("an explicitly-absent select takes the count arm (runtime)", () => {
  test("all three bulk families agree on select: undefined", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    try {
      const created = await client.gadget.createMany({
        data: [
          { id: "g1", code: "c1", name: "A" },
          { id: "g2", code: "c2", name: "B" },
        ],
        select: undefined,
      });
      expect(created).toEqual({ count: 2 });

      const updated = await client.gadget.updateMany({
        where: { name: "A" },
        data: { name: "A2" },
        select: undefined,
      });
      expect(updated).toEqual({ count: 1 });

      const deleted = await client.gadget.deleteMany({
        where: { name: "B" },
        select: undefined,
      });
      expect(deleted).toEqual({ count: 1 });

      // …and the count arm really ran: nothing was projected away, and the
      // writes landed.
      expect(await client.gadget.findMany({ orderBy: { id: "asc" } })).toEqual([
        { id: "g1", code: "c1", name: "A2", qty: 0 },
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  test("a present select still returns rows on all three", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    try {
      // The control: the discriminant is the VALUE, so the same key spelled
      // with a real select must still take the row arm.
      expect(
        await client.gadget.createMany({
          data: [{ id: "g1", code: "c1", name: "A" }],
          select: { id: true },
        })
      ).toEqual([{ id: "g1" }]);
      expect(
        await client.gadget.updateMany({
          where: { id: "g1" },
          data: { name: "A2" },
          select: { name: true },
        })
      ).toEqual([{ name: "A2" }]);
      expect(
        await client.gadget.deleteMany({
          where: { id: "g1" },
          select: { code: true },
        })
      ).toEqual([{ code: "c1" }]);
    } finally {
      await client.$disconnect();
    }
  });

  test("a malformed select still rejects rather than falling back to count", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    try {
      // Fail closed: "undefined is absent" must not become "anything falsy is
      // absent", and a garbage select must not silently degrade to `{ count }`.
      const untyped = client as unknown as Record<string, RoutedModel>;
      await expect(
        untyped.gadget?.createMany?.({
          data: [{ id: "g1", code: "c1", name: "A" }],
          select: "nope",
        }) as Promise<unknown>
      ).rejects.toThrow(CREATE_MANY_VALIDATION_FAILURE);
      await expect(
        untyped.gadget?.deleteMany?.({
          where: { id: "g1" },
          select: null,
        }) as Promise<unknown>
      ).rejects.toThrow(DELETE_MANY_VALIDATION_FAILURE);
    } finally {
      await client.$disconnect();
    }
  });
});

describe("write boundary bulk-write dual-run oracle (both substrates)", () => {
  const getFamily = usePGliteSchemaFamily(bulkWriteSchema);
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const family = getFamily();
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      // Routing proof: the whole tree ran on Observed in both Observed arms.
      for (const arm of [tx, batch]) {
        expect(arm.operations).toHaveLength(1);
        expect(arm.operations[0]).toMatchObject({
          operation: scenario.observed,
          boundary: "production",
        });
      }

      expect(tx.error).toEqual(direct.error);
      expect(batch.error).toEqual(direct.error);
      expect(tx.result).toEqual(direct.result);
      expect(batch.result).toEqual(direct.result);
      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);

      // The arm itself, where the scenario names it. Equality between arms is
      // not enough on its own: it proves they agree, not that they agree with
      // the documented discriminant.
      if (scenario.arm) {
        for (const arm of [direct, tx, batch]) {
          if (scenario.arm === "rows") {
            expect(Array.isArray(arm.result)).toBe(true);
          } else {
            expect(arm.result).toEqual({
              count: (arm.result as { count: number }).count,
            });
            expect(Array.isArray(arm.result)).toBe(false);
          }
        }
      }
    });
  }
});

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;
const CALLS_CREATE_CLIENT = /createClient\(\{ schema, driver \}\)/;
const IMPORTS_CLIENT_MODULE = /@src\/client\/client/;
const IMPORTS_ROUTING_MODULE = /write-boundary\/routing/;
/** `args.select === undefined` / `args.omit === undefined` — the copy's shape. */
const OWN_RETURNING_DISCRIMINANT = /args\.(?:select|omit)\s*===/;

/**
 * The harness must not own an arm-selection rule at all.
 *
 * The `omit` scenarios above catch today's drift; this catches the NEXT one,
 * which will have the same shape. The removed proxy carried its own operation
 * construction copy, which drifted when `omit` joined the discriminant.
 *
 * So the rule is structural, not behavioural: the oracle harness reaches the
 * production `createClient` seam and names no routing module or arm class.
 * Reintroduce the copy and this goes red before any scenario has to.
 */
describe("the oracle harness observes the production client seam", () => {
  // Comments stripped: the rule is about the CODE, and the comment above
  // `observeClientOperations` quotes the discriminant it no longer spells.
  const harness = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "operation-observer.ts"),
    "utf8"
  )
    .replace(BLOCK_COMMENT, "")
    .replace(LINE_COMMENT, "");

  test("it constructs through createClient", () => {
    expect(harness).toMatch(CALLS_CREATE_CLIENT);
    expect(harness).toMatch(IMPORTS_CLIENT_MODULE);
    expect(harness).not.toMatch(IMPORTS_ROUTING_MODULE);
  });

  test("it names no arm class and spells no discriminant of its own", () => {
    for (const armClass of [
      "ManyAndReturnOperation",
      "BulkCountOperation",
      "CreateManyOperation",
    ]) {
      expect(harness).not.toContain(armClass);
    }
    expect(harness).not.toMatch(OWN_RETURNING_DISCRIMINANT);
  });
});
