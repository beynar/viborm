/**
 * `findUnique` batching: calls issued in the same tick share one read, and
 * every caller gets exactly what its own unbatched call returns.
 *
 * Each provider file hands in a driver that records the statements it sends
 * and can be told to fail some of them. The expected values are always the
 * unbatched answers, read one awaited call at a time (a lone call never
 * batches).
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NotFoundError } from "@errors";
import { s } from "@schema";
import { instrumentation } from "@src/instrumentation/exports";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

export interface RecordingDriver extends AnyDriver {
  /** Every provider statement sent, in order. */
  readonly statements: string[];
  /** When set, a statement it accepts fails before reaching the provider. */
  failWhen: ((statement: string) => boolean) | undefined;
}

const member = s
  .model({
    id: s.int().id().increment(),
    handle: s.string().unique(),
    org: s.string(),
    slug: s.string(),
    owner: s.string(),
    name: s.string(),
    meta: s.json().nullable(),
    notes: s.toMany(() => note),
  })
  .unique(["org", "slug"])
  .map("fub_members");
const note = s
  .model({
    id: s.string().id(),
    body: s.string(),
    memberId: s.int(),
    member: s
      .toOne(() => member)
      .fields("memberId")
      .references("id"),
  })
  .map("fub_notes");
/** A model whose key no result carries. */
const badge = s
  .model({ id: s.int().id(), label: s.string() })
  .omit({ id: true })
  .map("fub_badges");
const schema = { member, note, badge };

const MEMBERS = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  handle: `h${index + 1}`,
  org: index % 2 === 0 ? "even" : "odd",
  slug: `s${index + 1}`,
  owner: index < 6 ? "ann" : "bob",
  name: `member ${index + 1}`,
  // JSON whose own key is spelled `__proto__`: a copy must keep it an own key.
  ...(index === 1
    ? {
        meta: JSON.parse(
          '{"__proto__":{"polluted":1},"list":[1,{"x":2}]}'
        ) as never,
      }
    : {}),
}));
const NOTES = MEMBERS.flatMap((row) => [
  { id: `${row.id}-a`, body: `a of ${row.id}`, memberId: row.id },
  { id: `${row.id}-b`, body: `b of ${row.id}`, memberId: row.id },
]);

/** Settle every call, so a rejection is compared as a value. */
function settle(calls: readonly PromiseLike<unknown>[]) {
  return Promise.all(
    calls.map((call) =>
      Promise.resolve(call).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
    )
  );
}

/** The same calls, one awaited at a time: each runs alone, unbatched. */
async function alone(calls: readonly (() => PromiseLike<unknown>)[]) {
  const results: unknown[] = [];
  for (const call of calls) results.push(...(await settle([call()])));
  return results;
}

/**
 * What a rejection is, for comparison: class, message and meta, without the
 * correlation id every operation mints for itself.
 */
function failureOf(error: unknown) {
  if (!(error instanceof Error)) return error;
  const { correlationId: _, ...meta } =
    (error as { meta?: Record<string, unknown> }).meta ?? {};
  return { name: error.name, message: error.message, meta };
}

function correlationOf(error: unknown): unknown {
  return (error as { meta?: Record<string, unknown> }).meta?.correlationId;
}

function comparable(results: readonly unknown[]) {
  return results.map((result) =>
    result !== null && typeof result === "object" && "error" in result
      ? { error: failureOf(result.error) }
      : result
  );
}

const SELECT_STATEMENT = /^select/i;

function openClient(driver: AnyDriver) {
  return createClient({ schema, driver, findUniqueBatching: true });
}

export function runFindUniqueBatchingBehavior(provider: {
  readonly name: string;
  readonly createDriver: () => RecordingDriver;
}): void {
  describe(`findUnique batching (${provider.name})`, () => {
    let driver: RecordingDriver;
    let db: ReturnType<typeof openClient>;

    /** Run calls in one tick and count the statements they sent. */
    async function inOneTick(calls: readonly (() => PromiseLike<unknown>)[]) {
      driver.statements.length = 0;
      const results = await settle(calls.map((call) => call()));
      return { results, statements: driver.statements.length };
    }

    let bindLimit: number | undefined;

    beforeAll(async () => {
      driver = provider.createDriver();
      bindLimit = driver.maxBindParametersPerStatement;
      db = openClient(driver);
      await syncLiveSchema(db);
      await db.member.createMany({ data: MEMBERS });
      await db.note.createMany({ data: NOTES });
      await db.badge.createMany({
        data: [
          { id: 1, label: "first" },
          { id: 2, label: "second" },
        ],
      });
    });
    beforeEach(() => {
      driver.failWhen = undefined;
      Object.defineProperty(driver, "maxBindParametersPerStatement", {
        value: bindLimit,
        configurable: true,
        writable: true,
      });
    });
    afterAll(async () => {
      await db.$disconnect();
    });

    test("calls in one tick share one statement; each caller gets its own row, duplicates included", async () => {
      const ids = [7, 2, 11, 2, 5, 1, 7, 12];
      const calls = ids.map(
        (id) => () =>
          db.member.findUnique({ where: { id }, include: { notes: true } })
      );
      const batched = await inOneTick(calls);
      expect(batched.statements).toBe(1);
      expect(batched.results).toEqual(await alone(calls));
      type Row = { id: number; name: string; meta: object; notes: unknown[] };
      const rows = batched.results.map(
        (result) => (result as { value: Row }).value
      );
      expect(rows.map((row) => row.id)).toEqual(ids);
      // A duplicate key is its own result, as it would be unbatched.
      expect(rows[3]).not.toBe(rows[1]);
      expect(rows[3]!.notes).not.toBe(rows[1]!.notes);
      rows[1]!.name = "changed by the first caller";
      expect(rows[3]!.name).toBe("member 2");
      expect(Object.hasOwn(rows[3]!.meta, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(rows[3]!.meta)).toBe(Object.prototype);
    });

    test("a missing integer key answers null inside the batch; a missing string key and findUniqueOrThrow answer from their own call", async () => {
      const byId = [3, 404, 4, 405].map(
        (id) => () => db.member.findUnique({ where: { id } })
      );
      const ids = await inOneTick(byId);
      expect(ids.statements).toBe(1);
      expect(ids.results).toEqual(await alone(byId));

      const byHandle = ["h3", "nobody", "h4"].map(
        (handle) => () => db.member.findUnique({ where: { handle } })
      );
      const handles = await inOneTick(byHandle);
      expect(handles.statements).toBe(2);
      expect(handles.results).toEqual(await alone(byHandle));

      const orThrow = [
        () => db.member.findUniqueOrThrow({ where: { id: 3 } }),
        () => db.member.findUniqueOrThrow({ where: { id: 406 } }),
        () => db.member.findUnique({ where: { id: 4 } }),
      ];
      const thrown = await inOneTick(orThrow);
      expect(thrown.statements).toBe(2);
      const missing = thrown.results[1] as { error: unknown };
      expect(missing.error).toBeInstanceOf(NotFoundError);
      expect(comparable(thrown.results)).toEqual(
        comparable(await alone(orThrow))
      );
    });

    test("a projection without the key reads it for dispatch and hands back exactly the projection", async () => {
      const selected = [9, 10, 9].map(
        (id) => () =>
          db.member.findUnique({
            where: { id },
            select: { name: true, notes: { select: { body: true } } },
          })
      );
      const select = await inOneTick(selected);
      expect(select.statements).toBe(1);
      const expected = await alone(selected);
      expect(select.results).toEqual(expected);
      expect(
        select.results.map((result) =>
          Object.keys((result as { value: object }).value)
        )
      ).toEqual(
        expected.map((result) =>
          Object.keys((result as { value: object }).value)
        )
      );

      const omitted = ["h1", "h6"].map(
        (handle) => () =>
          db.member.findUnique({ where: { handle }, omit: { handle: true } })
      );
      const omit = await inOneTick(omitted);
      expect(omit.statements).toBe(1);
      expect(omit.results).toEqual(await alone(omitted));
      expect(omit.results[0]).not.toHaveProperty("value.handle");
    });

    test("a key the model hides from every result is never batched", async () => {
      const calls = [1, 2, 3].map(
        (id) => () => db.badge.findUnique({ where: { id } })
      );
      const batched = await inOneTick(calls);
      expect(batched.statements).toBe(3);
      expect(batched.results).toEqual(await alone(calls));
      expect(batched.results).toEqual([
        { value: { label: "first" } },
        { value: { label: "second" } },
        { value: null },
      ]);
    });

    test("a key both selected and omitted is still read for dispatch, and still left out", async () => {
      const keyed = [
        ...[1, 2, 404].map(
          (id) => () =>
            db.member.findUnique({
              where: { id },
              select: { id: true, name: true },
              omit: { id: true },
            })
        ),
        ...["h3", "h4"].map(
          (handle) => () =>
            db.member.findUnique({
              where: { handle },
              select: { handle: true, name: true },
              omit: { handle: true },
            })
        ),
        ...[
          { org: "even", slug: "s5" },
          { org: "odd", slug: "s6" },
        ].map(
          (org_slug) => () =>
            db.member.findUnique({
              where: { org_slug },
              select: { org: true, slug: true, name: true },
              omit: { org: true, slug: true },
            })
        ),
      ];
      const batched = await inOneTick(keyed);
      // One read per key shape; nothing answered from its own call.
      expect(batched.statements).toBe(3);
      expect(batched.results).toEqual(await alone(keyed));
      expect(batched.results).toEqual([
        { value: { name: "member 1" } },
        { value: { name: "member 2" } },
        { value: null },
        { value: { name: "member 3" } },
        { value: { name: "member 4" } },
        { value: { name: "member 5" } },
        { value: { name: "member 6" } },
      ]);
    });

    test("a compound unique key batches as one statement", async () => {
      const calls = [
        { org: "even", slug: "s1" },
        { org: "odd", slug: "s2" },
        { org: "odd", slug: "s1" },
        { org: "even", slug: "s5" },
      ].map((org_slug) => () => db.member.findUnique({ where: { org_slug } }));
      const batched = await inOneTick(calls);
      // The absent pair has string members: it answers from its own call.
      expect(batched.statements).toBe(2);
      expect(batched.results).toEqual(await alone(calls));
    });

    test("different projections, keys or extra conditions are never merged", async () => {
      const calls = [
        () => db.member.findUnique({ where: { id: 1 } }),
        () => db.member.findUnique({ where: { id: 2 } }),
        () =>
          db.member.findUnique({ where: { id: 3 }, select: { name: true } }),
        () =>
          db.member.findUnique({ where: { id: 4 }, select: { name: true } }),
        () => db.member.findUnique({ where: { handle: "h5" } }),
        () => db.member.findUnique({ where: { id: 6, name: "member 6" } }),
        () => db.member.findUnique({ where: { id: 7, name: "not 7" } }),
      ];
      const batched = await inOneTick(calls);
      // {1,2} and {3,4} are two reads; h5, and both extra conditions, alone.
      expect(batched.statements).toBe(5);
      expect(batched.results).toEqual(await alone(calls));
    });

    test("operations inside a transaction are never merged, with each other or with the root", async () => {
      driver.statements.length = 0;
      const [inside, outside] = await Promise.all([
        db.$transaction(async (tx) =>
          Promise.all(
            [1, 2, 3].map((id) => tx.member.findUnique({ where: { id } }))
          )
        ),
        Promise.all(
          [1, 2, 3].map((id) => db.member.findUnique({ where: { id } }))
        ),
      ]);
      const reads = driver.statements.filter((statement) =>
        SELECT_STATEMENT.test(statement.trim())
      );
      expect(reads).toHaveLength(4);
      expect(inside.map((row) => row?.id)).toEqual([1, 2, 3]);
      expect(outside.map((row) => row?.id)).toEqual([1, 2, 3]);

      const array = await db.$transaction([
        db.member.findUnique({ where: { id: 8 } }),
        db.member.findUnique({ where: { id: 9 } }),
      ]);
      expect(array.map((row) => row?.id)).toEqual([8, 9]);
    });

    // Both providers run a callback transaction on their one connection. A
    // call on the ORIGINATING client inside that callback is refused; joined to
    // a batch led from outside, its read queued behind the transaction that
    // waited for it, and the client hung for good (1.4.0).
    test("the originating client inside its own callback transaction is refused, never merged", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = db.$transaction(async (tx) => {
        await tx.member.findFirst();
        await gate;
        return db.member.findUnique({ where: { id: 2 } });
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const outside = db.member.findUnique({ where: { id: 1 } });
      release();
      const hung = Symbol("hung");
      const settled = await Promise.race([
        Promise.allSettled([outside, transaction]),
        new Promise<typeof hung>((resolve) =>
          setTimeout(() => resolve(hung), 5000)
        ),
      ]);
      expect(settled).not.toBe(hung);
      const [read, refused] = settled as PromiseSettledResult<unknown>[];
      expect(read).toMatchObject({ status: "fulfilled", value: { id: 1 } });
      expect(refused).toMatchObject({
        status: "rejected",
        reason: { name: "TransactionError" },
      });
      expect(await db.member.count()).toBe(MEMBERS.length);
    });

    test("a failed merged read sends each caller to its own call: its own row, or its own error", async () => {
      const calls = [1, 2, 3].map(
        (id) => () => db.member.findUnique({ where: { id } })
      );
      const expected = await alone(calls);
      // The one statement a lone call sends; anything else is the merged read.
      const lone = (await inOneTick([calls[0]!])).statements;
      expect(lone).toBe(1);
      const own = driver.statements[0];
      let failures = 0;
      driver.failWhen = (statement) => {
        const merged = statement !== own;
        if (merged) failures += 1;
        return merged;
      };
      const recovered = await inOneTick(calls);
      expect(failures).toBe(1);
      expect(recovered.statements).toBe(4);
      expect(recovered.results).toEqual(expected);

      driver.failWhen = () => true;
      const failed = await inOneTick(calls);
      expect(failed.statements).toBe(4);
      const errors = failed.results.map(
        (result) => (result as { error: unknown }).error
      );
      expect(errors.every((error) => error instanceof Error)).toBe(true);
      // Each caller's error is its own, attributed to its own operation.
      expect(new Set(errors).size).toBe(3);
      expect(new Set(errors.map(correlationOf)).size).toBe(3);
      expect(comparable(failed.results)).toEqual(
        comparable(await alone(calls))
      );
    });

    // Every caller of a failed shared read runs alone and answers, so the
    // shared read's failure is nobody's error: no error log for it.
    test("a recovered shared read logs no error", async () => {
      const errors: unknown[] = [];
      const logged = db.$extends(
        instrumentation({ logging: { error: (event) => errors.push(event) } })
      );
      const calls = [1, 2, 3].map(
        (id) => () => logged.member.findUnique({ where: { id } })
      );
      const lone = (await inOneTick([calls[0]!])).statements;
      expect(lone).toBe(1);
      const own = driver.statements[0];
      driver.failWhen = (statement) => statement !== own;
      const recovered = await inOneTick(calls);
      expect(recovered.statements).toBe(4);
      expect(
        recovered.results.map(
          (result) => (result as { value: { id: number } }).value.id
        )
      ).toEqual([1, 2, 3]);
      expect(errors).toEqual([]);
    });

    test("a client without findUniqueBatching sends one read per call", async () => {
      const plain = createClient({ schema, driver });
      const { statements } = await inOneTick(
        [1, 2, 3].map((id) => () => plain.member.findUnique({ where: { id } }))
      );
      expect(statements).toBe(3);
    });

    test("query interceptors and observers still see one operation per call", async () => {
      const intercepted: unknown[] = [];
      let observed = 0;
      const extended = db
        .$extends({
          name: "intercept-find-unique",
          query: {
            member: {
              async findUnique({ input, proceed }) {
                const result = await proceed();
                intercepted.push([
                  (input as { where: unknown }).where,
                  (result as { id: number } | null)?.id ?? null,
                ]);
                return result;
              },
            },
          },
        })
        .$extends({
          name: "observe-operations",
          observe: async (unit, proceed) => {
            if (unit.kind === "operation") observed += 1;
            return proceed();
          },
        });
      const calls = [4, 404, 5].map(
        (id) => () => extended.member.findUnique({ where: { id } })
      );
      const batched = await inOneTick(calls);
      expect(batched.statements).toBe(1);
      expect(observed).toBe(3);
      // One answer per call; the order calls finish in is not the contract
      // (the leader starts the batch, so it settles after its members).
      expect(intercepted).toHaveLength(3);
      expect(intercepted).toEqual(
        expect.arrayContaining([
          [{ id: 4 }, 4],
          [{ id: 404 }, null],
          [{ id: 5 }, 5],
        ])
      );
      expect(batched.results).toEqual(await alone(calls));
    });

    test("a statement transform sees every call's own statement", async () => {
      const transformed = db.$extends({
        name: "statement-transform",
        statement: ({ statement }) => statement,
      });
      const calls = [1, 2, 3].map(
        (id) => () => transformed.member.findUnique({ where: { id } })
      );
      const batched = await inOneTick(calls);
      expect(batched.statements).toBe(3);
      expect(batched.results).toEqual(await alone(calls));
    });

    test("permissions filter each call as they do unbatched, and two actors never share a read", async () => {
      const policy = permissions({
        actor: v.object({ userId: v.string() }),
        models: { member: { read: { owner: { actor: "userId" } } } },
      });
      const guarded = (policy as unknown as (base: unknown) => unknown)(db) as {
        $as(actor: { userId: string }): typeof db;
      };
      const ann = guarded.$as({ userId: "ann" });
      const bob = guarded.$as({ userId: "bob" });
      const calls = [
        () => ann.member.findUnique({ where: { id: 1 } }),
        () => ann.member.findUnique({ where: { id: 9 } }),
        () => ann.member.findUniqueOrThrow({ where: { id: 10 } }),
        () => bob.member.findUnique({ where: { id: 1 } }),
        () => bob.member.findUnique({ where: { id: 9 } }),
        () => ann.member.findUnique({ where: { id: 2 } }),
      ];
      const batched = await inOneTick(calls);
      // ann's four calls share one read and bob's two another; the hidden
      // row ann asked to throw for answers from its own call.
      expect(batched.statements).toBe(3);
      expect(comparable(batched.results)).toEqual(
        comparable(await alone(calls))
      );
      expect(
        batched.results.map((result) =>
          "error" in result
            ? result.error
            : ((result.value as { id: number } | null)?.id ?? null)
        )
      ).toEqual([1, null, expect.any(NotFoundError), null, 9, 2]);
    });

    test("calls whose own controls pick different rows are never merged", async () => {
      const scoped = db.$extends({
        name: "owner-scope",
        rows: {
          control: "scope",
          default: "ann",
          models: { member: { ann: { root: { owner: "ann" } }, all: {} } },
        },
      });
      const calls = [
        () => scoped.member.findUnique({ where: { id: 1 } }),
        () => scoped.member.findUnique({ where: { id: 9 } }),
        () => scoped.member.findUnique({ where: { id: 1 }, scope: "all" }),
        () => scoped.member.findUnique({ where: { id: 9 }, scope: "all" }),
      ];
      const batched = await inOneTick(calls);
      expect(batched.statements).toBe(2);
      expect(batched.results).toEqual(await alone(calls));
      expect(
        batched.results.map(
          (result) => (result as { value: { id: number } | null }).value?.id
        )
      ).toEqual([1, undefined, 1, 9]);
    });

    test("a merged read over the driver's bind budget is split, each part one statement", async () => {
      // A compound key binds each of its members, on every dialect.
      const calls = MEMBERS.map(
        ({ org, slug }) =>
          () =>
            db.member.findUnique({ where: { org_slug: { org, slug } } })
      );
      const whole = await inOneTick(calls);
      expect(whole.statements).toBe(1);
      Object.defineProperty(driver, "maxBindParametersPerStatement", {
        value: 5,
        configurable: true,
        writable: true,
      });
      const split = await inOneTick(calls);
      expect(split.statements).toBeGreaterThan(1);
      expect(split.statements).toBeLessThan(calls.length);
      expect(split.results).toEqual(whole.results);
      expect(split.results).toEqual(await alone(calls));
    });
  });
}
