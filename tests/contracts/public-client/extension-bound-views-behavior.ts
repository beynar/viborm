/**
 * Bound views (RBAC plan K6, §4.6 as amended by spike F5 in §11.2), on one
 * substrate.
 *
 * A client factory's scope has `$bind(values)`: it admits values of the
 * calling extension's own controls once, fixes them, and returns a view of
 * the receiving client whose calls admit them as if passed. A control
 * declared `bound: true` is accepted only from there. The view keeps the
 * chain, its row binding and its scope; a transaction from it, a client
 * `$extends` derives from it and a cached read keep its values, and its
 * method factories run only for what it uses.
 *
 * The extension here is the shape `viborm/rbac` takes before its own unit
 * lands, over the RBAC acceptance fixture: a bound-only `actor`, and one rows
 * mode per actor selecting the rows the independent oracle (`oracle.ts`)
 * says that actor views, so a result that mixed two actors' rows would show.
 * Whether a policy selects those rows is the policy's witnesses' concern;
 * these pin the binding. Witness ids are the matrix's
 * (`tests/package/fixtures/rbac-app/witnesses.ts`, C6); the bound-only
 * placement is K6(b)'s.
 *
 * A substrate with no callback transaction (D1) runs every witness but the
 * interactive one, W-AS3, whose binding has nothing to carry there: its
 * refusal is pinned to be the base client's, and the array transaction
 * (W-AS4) is that substrate's only transaction.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import {
  ClientInitializationError,
  QueryError,
  ValidationError,
} from "@errors";
import { v } from "@src/validation";
import { failure } from "@tests/fixtures/failure";
import { createOracle } from "@tests/package/fixtures/rbac-app/oracle";
import { actors, seed } from "@tests/package/fixtures/rbac-app/seed";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  createRbacAppClient,
  loadRbacSeed,
  type RbacAppClient,
  type RbacAppSubstrate,
} from "./rbac-app-behavior";

export interface BoundViewsSubstrate extends RbacAppSubstrate {
  /** `false` where the driver declares no callback transaction (D1). */
  readonly callbackTransactions?: boolean;
}

const now = new Date();
const oracle = createOracle(seed);
/** Ten actors of the fixture: their pages and groups differ (checked below). */
const NAMES = Object.keys(actors).slice(0, 10);
type Where = Record<string, unknown>;
const NOTHING: Where = { id: { in: [] } };

/** One mode per actor: the rows of the model the oracle says it views. */
function modesOf(model: "page" | "pageGroup") {
  const modes: Record<string, { root: Where; related: Where }> = {
    nobody: { root: NOTHING, related: NOTHING },
  };
  for (const name of NAMES) {
    const view = {
      id: { in: oracle.rows(actors[name]!, model, "read", { now }) },
    };
    modes[name] = { root: view, related: view };
  }
  return modes;
}

/** `$as`, declared apart: inline, the factory's contextual type makes `Self` void. */
type RequestMethods = {
  $as<Self>(this: Self, name: string): Self;
};

let factoryRuns = 0;
const requests = {
  name: "requests",
  controls: {
    // Bound only, and required on the models `rows` names: never passed.
    actor: { oneOf: NAMES, bound: true, required: true },
    label: { schema: v.string() },
  },
  rows: {
    control: "as",
    default: "nobody",
    models: { page: modesOf("page"), pageGroup: modesOf("pageGroup") },
  },
  client: (scope: {
    $bind(values: Readonly<Record<string, unknown>>): unknown;
  }) => {
    factoryRuns += 1;
    const methods: RequestMethods = {
      $as: (name) => scope.$bind({ as: name, actor: name }) as never,
    };
    return methods;
  },
  model: {
    page: (delegate: { count(args?: object): Promise<number> }) => {
      factoryRuns += 1;
      return { visible: () => delegate.count() };
    },
  },
} as const;

/** What one actor must read: its pages, each with its group or `null`. */
const expectations = new Map(
  NAMES.map((name) => {
    const actor = actors[name]!;
    const pages = new Set(oracle.rows(actor, "page", "read", { now }));
    const groups = new Set(oracle.rows(actor, "pageGroup", "read", { now }));
    return [
      name,
      seed.page
        .filter((page) => pages.has(page.id))
        .map((page) => ({
          id: page.id,
          group:
            page.groupId !== null && groups.has(page.groupId)
              ? page.groupId
              : null,
        })),
    ];
  })
);
const expected = (name: string) => expectations.get(name)!;

type PageRow = { id: string; group: { id: string } | null };
const observed = (rows: readonly PageRow[]) =>
  rows
    .map((row) => ({ id: row.id, group: row.group?.id ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
const sorted = (rows: ReturnType<typeof expected>) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

const extend = (client: RbacAppClient) => client.$extends(requests);
const pagesWithGroups = {
  select: { id: true, group: { select: { id: true } } },
} as const;

export function runBoundViewsBehavior(substrate: BoundViewsSubstrate): void {
  const callbackTransactions = substrate.callbackTransactions ?? true;
  const timeout = substrate.timeout ?? 120_000;
  let base: RbacAppClient;
  let db: ReturnType<typeof extend>;

  describe(`${substrate.name}: bound views`, () => {
    beforeAll(async () => {
      base = createRbacAppClient(substrate.createDriver());
      await substrate.prepare(base);
      await loadRbacSeed(base);
      db = extend(base);
    }, timeout);

    afterAll(async () => {
      await base?.$disconnect();
      await substrate.release?.();
    }, timeout);

    // PGlite answers in microtasks: a macrotask turn between tests keeps the
    // worker's RPC alive on long runs (see rbac-compiled-policy-behavior.ts).
    afterEach(() => new Promise((resolve) => setTimeout(resolve, 0)));

    test("the fixture's actors read differing pages: an interleaving that mixed them would show", () => {
      const answers = new Set(
        NAMES.map((name) => JSON.stringify(expected(name)))
      );
      expect(answers.size).toBeGreaterThan(5);
    });

    test(
      "W-AS1: a bound view builds no chain and no row binding, and runs no factory it does not use",
      async () => {
        // The definition's rows are read when a chain binds them, and only then.
        let rowsReads = 0;
        const models = { ...requests.rows.models };
        const counted = Object.defineProperty({}, "page", {
          enumerable: true,
          get: () => {
            rowsReads += 1;
            return models.page;
          },
        });
        Object.defineProperty(counted, "pageGroup", {
          enumerable: true,
          value: models.pageGroup,
        });
        const chained = base.$extends({
          ...requests,
          rows: { ...requests.rows, models: counted as typeof models },
        });
        const applied = rowsReads;
        expect(applied).toBeGreaterThan(0);
        factoryRuns = 0;
        const first = chained.$as(NAMES[0]!);
        const again = chained.$as(NAMES[0]!);
        const other = chained.$as(NAMES[1]!);
        expect(factoryRuns).toBe(0);
        expect(first).not.toBe(again);
        expect(first.$driver).toBe(chained.$driver);
        expect(first.$schema).toBe(chained.$schema);
        for (const view of [first, again, other]) {
          await view.page.findMany(pagesWithGroups);
          await view.pageGroup.count();
        }
        // A model's factories run when that model is first read on a view.
        expect(factoryRuns).toBe(3);
        await first.page.visible();
        await first.page.visible();
        expect(factoryRuns).toBe(3);
        expect(rowsReads).toBe(applied);
      },
      timeout
    );

    test(
      "W-AS2: 1,000 interleaved requests under Promise.all, with includes, transactions, array transactions, $extends and rebinding, never mix",
      async () => {
        const derived = db.$extends({ name: "later", client: () => ({}) });
        // Without a callback transaction, the array form is the only one.
        const inTransaction = (call: typeof db) =>
          callbackTransactions
            ? call.$transaction((tx) => tx.page.findMany(pagesWithGroups))
            : call
                .$transaction([call.page.findMany(pagesWithGroups)])
                .then(([rows]) => rows);
        const run = async (index: number) => {
          const name = NAMES[index % NAMES.length]!;
          const call = db.$as(name);
          switch (index % 5) {
            case 0:
              return [name, await call.page.findMany(pagesWithGroups)] as const;
            case 1:
              return [name, await inTransaction(call)] as const;
            case 2: {
              const otherName = NAMES[(index + 3) % NAMES.length]!;
              const [mine, theirs] = await db.$transaction([
                call.page.findMany(pagesWithGroups),
                db.$as(otherName).page.findMany(pagesWithGroups),
              ]);
              expect(observed(theirs)).toEqual(sorted(expected(otherName)));
              return [name, mine] as const;
            }
            case 3:
              return [
                name,
                await derived.$as(name).page.findMany(pagesWithGroups),
              ] as const;
            default:
              return [
                name,
                await db
                  .$as(NAMES[(index + 1) % NAMES.length]!)
                  .$as(name)
                  .page.findMany(pagesWithGroups),
              ] as const;
          }
        };
        const results = await Promise.all(
          Array.from({ length: 1000 }, (_, index) => run(index))
        );
        let mixed = 0;
        for (const [name, rows] of results) {
          if (
            JSON.stringify(observed(rows)) !==
            JSON.stringify(sorted(expected(name)))
          )
            mixed += 1;
        }
        expect(mixed).toBe(0);
      },
      timeout
    );

    test("K6(b): a bound-only control is refused as an argument, bound view or not, and required without a binding, creates included", async () => {
      const call = db.$as(NAMES[0]!);
      // Never read from the arguments: unbound, the call lacks it; bound, the
      // key is left to core validation, which knows no such key.
      const pass = (client: typeof db) =>
        Reflect.apply(client.page.findMany, undefined, [{ actor: NAMES[0] }]);
      await expect(pass(db)).rejects.toBeInstanceOf(ValidationError);
      await expect(pass(db)).rejects.toThrow('Control "actor" is required');
      await expect(pass(call)).rejects.toBeInstanceOf(ValidationError);
      await expect(pass(call)).rejects.toThrow("actor: Unknown key: actor");
      await expect(db.page.findMany()).rejects.toThrow(
        'Control "actor" is required'
      );
      await expect(
        db.page.create({
          data: {
            id: "never",
            title: "never",
            organizationId: "org-1",
            ownerId: seed.user[0]!.id,
            position: 0,
          },
        })
      ).rejects.toThrow('Control "actor" is required');
      expect(await base.page.count({ where: { id: "never" } })).toBe(0);
    });

    if (callbackTransactions)
      test("W-AS3: an interactive transaction and its savepoints keep the binding; tx.$as rebinds inside the transaction", async () => {
        const [first, second] = NAMES as [string, string];
        await db.$as(first).$transaction(async (tx) => {
          expect(observed(await tx.page.findMany(pagesWithGroups))).toEqual(
            sorted(expected(first))
          );
          await tx.$transaction(async (nested) => {
            expect(
              observed(await nested.page.findMany(pagesWithGroups))
            ).toEqual(sorted(expected(first)));
          });
          const rebound = tx.$as(second);
          expect(
            observed(await rebound.page.findMany(pagesWithGroups))
          ).toEqual(sorted(expected(second)));
          // Still the transaction's connection: its write rolls back with it.
          await expect(
            rebound.$transaction(async (inner) => {
              await inner.pageGroup.updateMany({ data: { icon: "renamed" } });
              throw new Error("roll back");
            })
          ).rejects.toThrow("roll back");
        });
        expect(await base.pageGroup.count({ where: { icon: "renamed" } })).toBe(
          0
        );
      });
    else
      test("W-AS3 (no callback transaction here): a bound view's interactive transaction is refused exactly as the base client's is, and its array transaction keeps the binding", async () => {
        const [first, second] = NAMES as [string, string];
        const refused = (await failure(
          db.$as(first).$transaction(async (tx) => tx.page.count())
        )) as Error;
        const plain = (await failure(
          base.$transaction(async (tx) => tx.page.count())
        )) as Error;
        expect(refused.constructor).toBe(plain.constructor);
        expect(refused.message).toBe(plain.message);
        const call = db.$as(first);
        const [mine, rebound] = await call.$transaction([
          call.page.findMany(pagesWithGroups),
          call.$as(second).page.findMany(pagesWithGroups),
        ]);
        expect(observed(mine)).toEqual(sorted(expected(first)));
        expect(observed(rebound)).toEqual(sorted(expected(second)));
      });

    test("W-AS4, W-AS5, W-AS7: a client $extends derives from a bound view keeps its values; array-transaction members keep their own; a cached read is keyed per binding", async () => {
      const [first, second] = NAMES as [string, string];
      const derived = db
        .$as(first)
        .$extends({ name: "derived", client: () => ({}) });
      expect(observed(await derived.page.findMany(pagesWithGroups))).toEqual(
        sorted(expected(first))
      );
      expect(await derived.page.visible()).toBe(expected(first).length);
      const [mine, theirs, unbound] = await db.$transaction([
        db.$as(first).page.findMany(pagesWithGroups),
        db.$as(second).page.findMany(pagesWithGroups),
        db.organization.count(),
      ]);
      expect(observed(mine)).toEqual(sorted(expected(first)));
      expect(observed(theirs)).toEqual(sorted(expected(second)));
      expect(unbound).toBe(seed.organization.length);

      const cached = db.$extends(cache({ driver: new MemoryCache() }));
      const reads = async (name: string) =>
        observed(
          await cached
            .$as(name)
            .$withCache({ ttl: 60_000 })
            .page.findMany(pagesWithGroups)
        );
      expect(await reads(first)).toEqual(sorted(expected(first)));
      expect(await reads(second)).toEqual(sorted(expected(second)));
      expect(await reads(first)).toEqual(sorted(expected(first)));
    });

    test("W-AS6: $bind admits only the calling extension's own controls, each through its declaration", () => {
      const binder = {
        name: "binder",
        controls: {
          mine: { schema: v.string() },
          hostile: {
            schema: {
              "~standard": {
                version: 1,
                vendor: "test",
                validate: () => {
                  throw new Error("boom");
                },
              },
            },
          },
        },
        client: (scope: {
          $bind(values: Readonly<Record<string, unknown>>): unknown;
        }) => ({
          $with: (values: Readonly<Record<string, unknown>>) =>
            scope.$bind(values),
        }),
      } as const;
      const bound = db.$extends(binder);
      expect(() => bound.$with({ actor: NAMES[0] })).toThrow(
        ClientInitializationError
      );
      expect(() => bound.$with({ actor: NAMES[0] })).toThrow(
        'Extension "binder" binds control "actor", which it does not declare.'
      );
      expect(() => bound.$with({ nowhere: 1 })).toThrow(
        'binds control "nowhere"'
      );
      expect(() => bound.$with({ mine: 1 })).toThrow(ValidationError);
      expect(() => bound.$with({ mine: 1 })).toThrow(
        "Validation failed for $bind"
      );
      expect(() => bound.$with({ hostile: 1 })).toThrow(QueryError);
      expect(() => bound.$with({ hostile: 1 })).toThrow(
        'Extension "binder" control "hostile" validator for $bind threw.'
      );
      expect(bound.$with({ mine: "ok" })).toBeTypeOf("object");
      // The other extension binds its own: the same values are refused here.
      expect(() => db.$as("not-an-actor")).toThrow(ValidationError);
    });
  });
}
