import { ValidationError } from "@errors";
import type { RowsVerbs } from "@src/extensions/controls";
import type { CompiledPolicy } from "@src/rbac";
import { verbsOf } from "@src/rbac/compile";
import {
  createRbacAppClient,
  loadRbacSeed,
  type RbacAppClient,
  type RbacAppSubstrate,
} from "@tests/contracts/public-client/rbac-app-behavior";
import {
  actionsOf,
  createOracle,
  GOVERNED_MODELS,
  type GovernedModel,
  type OracleOptions,
  rowKey,
} from "@tests/package/fixtures/rbac-app/oracle";
import { schema } from "@tests/package/fixtures/rbac-app/schema";
import {
  type Actor,
  actors,
  LEVELS,
  seed,
} from "@tests/package/fixtures/rbac-app/seed";
import {
  Actor as ActorSchema,
  policy,
} from "@tests/types/rbac/acceptance-policy";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

/**
 * K5 against the oracle (plan §4.5, §3.3 D5/D6; §7 W-EV1..W-EV4 and
 * W-F1..W-F8): the compiled §1.1 policy as K3 declares it (`verbsOf`), and
 * beside it, per model, what K5 declares: `evidence: { as: "$access", names }`
 * with the model's actions (`ordered` where they are exactly the levels
 * chain) and `reads` as the policy compiled them (`collection.budget` at
 * `full`). A plain extension carries it, its actor an argument; no other
 * layer, so the oracle is read without tombstones.
 *
 * What a caller observes of a row at action `a` is `P(view) ∧ P(a)` (R2), so
 * a row's `$access` is the oracle's `access` for it, and `budget` is present
 * exactly where the oracle holds `full`. A `select` that names `budget` fails
 * on a row without it (OD-5); every operand the caller writes over `budget`
 * reads it as absent (NULL) there. The oracle never sees an engine result.
 */

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args: object): Promise<Row[]>;
  findFirst(args: object): Promise<Row | null>;
  findUnique(args: object): Promise<Row | null>;
  count(args: object): Promise<number>;
  aggregate(args: object): Promise<Row>;
  groupBy(args: object): Promise<Row[]>;
  update(args: object): Promise<Row>;
  create(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
}
type Client = Record<string, Delegate> & {
  $transaction<T>(body: (tx: Client) => Promise<T>): Promise<T>;
  $extends(definition: object): Client;
};

const KEY = "$access";
const MODE = "as";
const ROLLBACK = new Error("rolled back");

/** A model whose actions are exactly the levels chain reports its highest. */
const ordered = (model: GovernedModel) => {
  const actions = actionsOf(model);
  return (
    actions.length === LEVELS.length &&
    actions.every((action, index) => action === LEVELS[index])
  );
};

/** K3's entry per model, and K5's declarations beside it. */
export function evidenceVerbs(
  compiled: CompiledPolicy
): Record<string, RowsVerbs> {
  const verbs = verbsOf(compiled);
  for (const model of GOVERNED_MODELS) {
    const { reads } = compiled.models[model]!;
    verbs[model] = {
      ...verbs[model]!,
      evidence: {
        as: KEY,
        names: actionsOf(model),
        ...(ordered(model) && { ordered: true }),
      },
      ...(Object.keys(reads).length > 0 && { reads }),
    };
  }
  return verbs;
}

/** The plain extension carrying the compiled policy and K5's declarations. */
export const evidenceExtension = (compiled: CompiledPolicy) => ({
  name: "evidence",
  controls: { actor: { schema: ActorSchema, required: true } },
  rows: {
    control: MODE,
    default: "default",
    models: Object.fromEntries(
      GOVERNED_MODELS.map((model) => [model, { default: {} }])
    ),
    verbs: evidenceVerbs(compiled),
  },
});

const keyOf = (model: string) =>
  model === "teamMember" ? { teamId: true, userId: true } : { id: true };

/** The class of what `body` throws, or "ok". */
async function outcomeOf(body: () => Promise<unknown>) {
  try {
    await body();
    return { outcome: "ok" };
  } catch (error) {
    return {
      outcome: (error as Error).constructor.name,
      path: (error as ValidationError).issues?.[0]?.path,
    };
  }
}

export interface EvidenceSubstrate extends RbacAppSubstrate {
  /** Run the read-gated field witnesses (W-F1..W-F8); default true. */
  readonly fields?: boolean;
}

export function runRbacEvidenceBehavior(substrate: EvidenceSubstrate): void {
  const oracle = createOracle(seed);
  const judged = substrate.actors ?? Object.keys(actors);
  const timeout = substrate.timeout ?? 120_000;
  const now = new Date();
  const options: OracleOptions = { now, tombstones: false };
  const access = (actor: Actor, model: GovernedModel) =>
    oracle.access(actor, model, options);
  /** What a row's `$access` reads for one held action list. */
  const evidenceOf = (model: GovernedModel, held: readonly string[]) =>
    ordered(model)
      ? (oracle.highestLevel(held) ?? null)
      : Object.fromEntries(
          actionsOf(model).map((action) => [action, held.includes(action)])
        );
  /** The collections an actor holds at full: where `budget` is present. */
  const full = (actor: Actor) =>
    new Set(oracle.rows(actor, "collection", "full", options));
  const collections = new Map(seed.collection.map((row) => [row.id, row]));

  describe(`${substrate.name}: K5 evidence and read-gated fields against the oracle`, () => {
    let base: RbacAppClient;
    let db: Client;
    const statements: string[] = [];
    const call = (name: string): Record<string, Delegate> => {
      const actor = actors[name]!;
      return Object.fromEntries(
        GOVERNED_MODELS.map((model) => {
          const delegate = db[model]!;
          const bound = (method: keyof Delegate) => (args: object) =>
            (delegate[method] as (args: object) => Promise<unknown>)({
              ...args,
              actor,
            });
          return [
            model,
            Object.fromEntries(
              (
                [
                  "findMany",
                  "findFirst",
                  "findUnique",
                  "count",
                  "aggregate",
                  "groupBy",
                  "update",
                  "create",
                  "delete",
                ] as const
              ).map((method) => [method, bound(method)])
            ) as unknown as Delegate,
          ];
        })
      );
    };
    /** What `body` returns, rolled back (or followed by `restore`). */
    const rolledBack = async <T>(body: (tx: Client) => Promise<T>) => {
      if (substrate.restore)
        try {
          return await body(db);
        } finally {
          await substrate.restore(base);
        }
      let result: T | undefined;
      try {
        await db.$transaction(async (tx) => {
          result = await body(tx);
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) throw error;
      }
      return result as T;
    };
    /** The actors holding `full` on some visible collection and not on another. */
    const mixed = () =>
      judged.filter((name) => {
        const actor = actors[name]!;
        const visible = oracle.rows(actor, "collection", "view", options);
        const held = full(actor);
        return (
          visible.some((id) => held.has(id)) &&
          visible.some((id) => !held.has(id))
        );
      });

    beforeAll(async () => {
      base = createRbacAppClient(substrate.createDriver());
      await substrate.prepare(base);
      await loadRbacSeed(base);
      db = (base as unknown as Client)
        .$extends(evidenceExtension(policy.compile(schema)))
        .$extends({
          name: "meter",
          statement: (context: { statement: unknown }) => {
            statements.push("statement");
            return context.statement;
          },
        });
    }, timeout);

    afterAll(async () => {
      await base?.$disconnect();
      await substrate.release?.();
    }, timeout);

    // PGlite answers in microtasks (see rbac-compiled-policy-behavior.ts).
    afterEach(() => new Promise((resolve) => setImmediate(resolve)));

    for (const name of judged) {
      test(
        `W-EV1, W-EV3, W-F6: ${name}'s $access on every row of every model is the oracle's, the highest level where ordered; no row dropped`,
        async () => {
          const actor = actors[name]!;
          const as = call(name);
          for (const model of GOVERNED_MODELS) {
            const rows = await as[model]!.findMany({
              select: { ...keyOf(model), [KEY]: true },
            });
            const expected = access(actor, model);
            expect(
              rows.map((row) => rowKey(model, row)).sort(),
              `${name} ${model}`
            ).toEqual([...expected.keys()].sort());
            for (const row of rows)
              expect(
                row[KEY],
                `${name} ${model} ${rowKey(model, row)}`
              ).toEqual(evidenceOf(model, expected.get(rowKey(model, row))!));
          }
        },
        timeout
      );
    }

    test(
      "W-EV2: $access two levels below the root documents, through select and include, is the oracle's on every visible child",
      async () => {
        for (const name of judged) {
          const actor = actors[name]!;
          const expected = access(actor, "document");
          const childrenOf = (id: string) =>
            seed.document
              .filter((d) => d.parentId === id && expected.has(d.id))
              .map((d) => d.id)
              .sort();
          const check = (rows: Row[], depth: number, where: string) => {
            for (const row of rows) {
              const id = row.id as string;
              expect(row[KEY], `${where} ${id}`).toEqual(
                evidenceOf("document", expected.get(id)!)
              );
              if (depth === 0) continue;
              const children = row.children as Row[];
              expect(
                children.map((child) => child.id).sort(),
                `${where} ${id} children`
              ).toEqual(childrenOf(id));
              check(children, depth - 1, where);
            }
          };
          const as = call(name);
          const roots = [...expected.keys()].filter(
            (id) => seed.document.find((d) => d.id === id)!.parentId === null
          );
          const selected = await as.document!.findMany({
            where: { parentId: null },
            select: {
              id: true,
              [KEY]: true,
              children: {
                select: {
                  id: true,
                  [KEY]: true,
                  children: { select: { id: true, [KEY]: true } },
                },
              },
            },
          });
          expect(selected.map((row) => row.id).sort(), name).toEqual(
            roots.sort()
          );
          check(selected, 2, `${name} select`);
          const included = await as.document!.findMany({
            where: { parentId: null },
            include: {
              [KEY]: true,
              children: {
                include: {
                  [KEY]: true,
                  children: { include: { [KEY]: true } },
                },
              },
            },
          });
          check(included, 2, `${name} include`);
          expect(included[0]?.title ?? null).not.toBeUndefined();
        }
      },
      timeout
    );

    test(
      "W-EV3: a list of names reports those only; ordered, the highest of them",
      async () => {
        for (const name of judged) {
          const actor = actors[name]!;
          const as = call(name);
          const pages = access(actor, "page");
          for (const row of await as.page!.findMany({
            select: { id: true, [KEY]: ["view", "edit"] },
          })) {
            const held = pages.get(row.id as string)!;
            expect(row[KEY], `${name} ${row.id}`).toEqual(
              oracle.highestLevel(held.filter((a) => a !== "full")) ?? null
            );
          }
          const documents = access(actor, "document");
          for (const row of await as.document!.findMany({
            select: { id: true, [KEY]: ["share", "export"] },
          })) {
            const held = documents.get(row.id as string)!;
            expect(row[KEY], `${name} ${row.id}`).toEqual({
              share: held.includes("share"),
              export: held.includes("export"),
            });
          }
        }
        expect(
          await outcomeOf(() =>
            call(judged[0]!).page!.findMany({ select: { [KEY]: ["owner"] } })
          )
        ).toEqual({ outcome: ValidationError.name, path: `select.${KEY}` });
      },
      timeout
    );

    test(
      "W-EV4: $access at three depths, on many rows, and a read-gated field are one statement",
      async () => {
        const as = call(judged[0]!);
        statements.length = 0;
        await as.document!.findMany({
          include: {
            [KEY]: true,
            children: {
              include: { [KEY]: true, children: { include: { [KEY]: true } } },
            },
          },
        });
        expect(statements).toHaveLength(1);
        statements.length = 0;
        await as.organization!.findMany({
          include: { [KEY]: true, collections: true },
        });
        expect(statements).toHaveLength(1);
      },
      timeout
    );

    test(
      "W-EV1, write: a write's returned row carries $access computed at its capture, the oracle's",
      async () => {
        let judgedWrites = 0;
        for (const name of judged.slice(0, 3)) {
          const actor = actors[name]!;
          const editable = oracle.rows(actor, "document", "edit", options);
          const id = editable[0];
          if (id === undefined) continue;
          judgedWrites += 1;
          const row = await rolledBack((tx) =>
            tx.document!.update({
              where: { id },
              data: { title: `renamed ${id}` },
              select: { id: true, title: true, [KEY]: true },
              actor,
            } as object)
          );
          expect(row, `${name} ${id}`).toEqual({
            id,
            title: `renamed ${id}`,
            [KEY]: evidenceOf("document", access(actor, "document").get(id)!),
          });
        }
        expect(judgedWrites).toBeGreaterThan(0);
      },
      timeout
    );

    if (substrate.fields !== false) {
      for (const name of judged) {
        test(
          `W-F1, W-F2, W-F5, W-F6: ${name}'s budget is present exactly at full, at the root and nested, and no row is dropped`,
          async () => {
            const actor = actors[name]!;
            const held = full(actor);
            const visible = oracle.rows(actor, "collection", "view", options);
            const as = call(name);
            const check = (rows: Row[], where: string) => {
              for (const row of rows) {
                const id = row.id as string;
                if (held.has(id))
                  expect(row.budget, `${where} ${id}`).toBe(
                    collections.get(id)!.budget
                  );
                else expect("budget" in row, `${where} ${id}`).toBe(false);
                expect(row.name, `${where} ${id}`).toBe(
                  collections.get(id)!.name
                );
              }
            };
            const rows = await as.collection!.findMany({});
            expect(rows.map((row) => row.id).sort(), name).toEqual(visible);
            check(rows, `${name} root`);
            // `omit` of another field leaves budget to its gate.
            check(
              await as.collection!.findMany({ omit: { status: true } }),
              `${name} omit`
            );
            const organizations = await as.organization!.findMany({
              include: { collections: true },
            });
            for (const organization of organizations) {
              const nested = organization.collections as Row[];
              expect(
                nested.map((row) => row.id).sort(),
                `${name} ${organization.id}`
              ).toEqual(
                visible.filter(
                  (id) =>
                    collections.get(id)!.organizationId === organization.id
                )
              );
              check(nested, `${name} nested`);
            }
          },
          timeout
        );
      }

      test(
        "W-F3: a select naming budget fails at its path where a returned row lacks full, after the read; omit naming it false is a selection too",
        async () => {
          for (const name of judged) {
            const actor = actors[name]!;
            const visible = oracle.rows(actor, "collection", "view", options);
            const held = full(actor);
            const lacking = visible.some((id) => !held.has(id));
            const as = call(name);
            const selected = await outcomeOf(() =>
              as.collection!.findMany({ select: { id: true, budget: true } })
            );
            expect(selected, name).toEqual(
              lacking
                ? { outcome: ValidationError.name, path: "select.budget" }
                : { outcome: "ok" }
            );
            expect(
              await outcomeOf(() =>
                as.collection!.findMany({ omit: { budget: false } })
              ),
              name
            ).toEqual(
              lacking
                ? { outcome: ValidationError.name, path: "select.budget" }
                : { outcome: "ok" }
            );
            // Narrowed to the rows held at full, the same select succeeds.
            const at = [...held].filter((id) => visible.includes(id));
            const rows = await as.collection!.findMany({
              where: { id: { in: at } },
              select: { id: true, budget: true },
            });
            expect(rows.map((row) => row.id).sort(), name).toEqual(at.sort());
            const nested = await outcomeOf(() =>
              as.organization!.findMany({
                include: {
                  collections: { select: { id: true, budget: true } },
                },
              })
            );
            expect(nested.outcome === "ok", name).toBe(!lacking);
            if (lacking)
              expect(nested.path).toBe("include.collections.select.budget");
          }
        },
        timeout
      );

      test(
        "W-F4: where, orderBy, distinct, count, aggregate and groupBy read budget as absent on rows without full",
        async () => {
          for (const name of judged) {
            const actor = actors[name]!;
            const visible = oracle.rows(actor, "collection", "view", options);
            const held = full(actor);
            const known = visible.filter((id) => held.has(id));
            const budget = (id: string) => collections.get(id)!.budget;
            const as = call(name);
            const ids = (rows: Row[]) => rows.map((row) => row.id as string);
            expect(
              ids(
                await as.collection!.findMany({
                  where: { budget: { gt: 0 } },
                  select: { id: true },
                })
              ).sort(),
              `${name} where`
            ).toEqual(known.filter((id) => budget(id) > 0).sort());
            expect(
              ids(
                await as.collection!.findMany({
                  where: { NOT: { budget: { gt: 0 } } },
                  select: { id: true },
                })
              ).sort(),
              `${name} NOT`
            ).toEqual(known.filter((id) => !(budget(id) > 0)).sort());
            const ordered = ids(
              await as.collection!.findMany({
                orderBy: [{ budget: "desc" }, { id: "asc" }],
                select: { id: true },
              })
            );
            const expectedOrder = [
              // NULL sorts first descending (the engine's default nulls).
              ...visible.filter((id) => !held.has(id)).sort(),
              ...known.sort(
                (x, y) => budget(y) - budget(x) || (x < y ? -1 : 1)
              ),
            ];
            expect(ordered, `${name} orderBy`).toEqual(expectedOrder);
            expect(
              await as.collection!.count({ where: { budget: { gte: 0 } } }),
              `${name} count`
            ).toBe(known.length);
            const aggregate = await as.collection!.aggregate({
              _sum: { budget: true },
              _count: { budget: true, _all: true },
              _max: { budget: true },
            });
            expect(aggregate, `${name} aggregate`).toEqual({
              _sum: {
                budget: known.length
                  ? known.reduce((sum, id) => sum + budget(id), 0)
                  : null,
              },
              _count: { budget: known.length, _all: visible.length },
              _max: {
                budget: known.length ? Math.max(...known.map(budget)) : null,
              },
            });
            const paged = await as.collection!.aggregate({
              _count: { budget: true },
              orderBy: { id: "asc" },
              take: 5,
            });
            expect(paged, `${name} paged aggregate`).toEqual({
              _count: {
                budget: [...visible]
                  .sort()
                  .slice(0, 5)
                  .filter((id) => held.has(id)).length,
              },
            });
            const groups = await as.collection!.groupBy({
              by: ["budget"],
              _count: { _all: true },
              orderBy: { budget: "asc" },
            });
            const expectedGroups = new Map<number | null, number>();
            for (const id of visible) {
              const value = held.has(id) ? budget(id) : null;
              expectedGroups.set(value, (expectedGroups.get(value) ?? 0) + 1);
            }
            expect(
              new Map(
                groups.map((group) => [
                  group.budget as number | null,
                  (group._count as { _all: number })._all,
                ])
              ),
              `${name} groupBy`
            ).toEqual(expectedGroups);
            const distinct = await as.collection!.findMany({
              distinct: ["budget"],
              select: { id: true },
              orderBy: { id: "asc" },
            });
            expect(
              new Set(
                ids(distinct).map((id) => (held.has(id) ? budget(id) : null))
              ),
              `${name} distinct`
            ).toEqual(
              new Set(visible.map((id) => (held.has(id) ? budget(id) : null)))
            );
            expect(distinct.length, `${name} distinct`).toBe(
              new Set(visible.map((id) => (held.has(id) ? budget(id) : null)))
                .size
            );
          }
        },
        timeout
      );

      test(
        "W-F7: a write's result carries budget only at full, and its $access is the oracle's; a select of budget fails there",
        async () => {
          const writes = { lacking: 0, holding: 0 };
          for (const name of judged) {
            const actor = actors[name]!;
            const editable = oracle.rows(actor, "collection", "edit", options);
            const held = full(actor);
            if (editable.length === 0) continue;
            const lacking = editable.find((id) => !held.has(id));
            const holding = editable.find((id) => held.has(id));
            for (const id of [lacking, holding]) {
              if (id === undefined) continue;
              writes[held.has(id) ? "holding" : "lacking"] += 1;
              const row = await rolledBack((tx) =>
                tx.collection!.update({
                  where: { id },
                  data: { name: `renamed ${id}` },
                  include: { [KEY]: true },
                  actor,
                } as object)
              );
              expect(row.name, `${name} ${id}`).toBe(`renamed ${id}`);
              expect("budget" in row, `${name} ${id}`).toBe(held.has(id));
              expect(row[KEY], `${name} ${id}`).toEqual(
                evidenceOf("collection", access(actor, "collection").get(id)!)
              );
              const explicit = await rolledBack((tx) =>
                outcomeOf(() =>
                  tx.collection!.update({
                    where: { id },
                    data: { name: `renamed ${id}` },
                    select: { id: true, budget: true },
                    actor,
                  } as object)
                )
              );
              expect(explicit, `${name} ${id}`).toEqual(
                held.has(id)
                  ? { outcome: "ok" }
                  : { outcome: ValidationError.name, path: "select.budget" }
              );
            }
          }
          expect(writes.lacking).toBeGreaterThan(0);
          expect(writes.holding).toBeGreaterThan(0);
        },
        timeout
      );

      test(
        "W-F8: a unique lookup's filter half, a relation filter and a relation order read budget as absent without full",
        async () => {
          for (const name of judged) {
            const actor = actors[name]!;
            const visible = oracle.rows(actor, "collection", "view", options);
            const held = full(actor);
            const as = call(name);
            for (const id of visible) {
              const value = collections.get(id)!.budget;
              const found = await as.collection!.findUnique({
                where: { id, budget: value },
                select: { id: true },
              });
              expect(found?.id ?? null, `${name} ${id}`).toBe(
                held.has(id) ? id : null
              );
            }
            const organizations = await as.organization!.findMany({
              where: { collections: { some: { budget: { gt: 0 } } } },
              select: { id: true },
            });
            const orgs = oracle.rows(actor, "organization", "view", options);
            expect(
              organizations.map((row) => row.id).sort(),
              `${name} some`
            ).toEqual(
              orgs.filter((org) =>
                visible.some(
                  (id) =>
                    held.has(id) &&
                    collections.get(id)!.organizationId === org &&
                    collections.get(id)!.budget > 0
                )
              )
            );
            const grants = await as.accessGrant!.findMany({
              where: { collectionId: { not: null } },
              orderBy: [{ collection: { budget: "desc" } }, { id: "asc" }],
              select: { id: true, collectionId: true },
            });
            // A grant's collection reads its budget only where it is held at
            // full (and visible); elsewhere the order key is absent.
            const keyOf = (row: Row) => {
              const id = row.collectionId as string;
              return visible.includes(id) && held.has(id)
                ? collections.get(id)!.budget
                : null;
            };
            const keys = grants.map(keyOf);
            const sorted = [...keys].sort((x, y) =>
              x === null ? (y === null ? 0 : -1) : y === null ? 1 : y - x
            );
            expect(keys, `${name} relation order`).toEqual(sorted);
          }
        },
        timeout
      );

      test("the judged actors meet every side: a row with budget and one without, an actor whose select of budget fails and one whose succeeds", () => {
        const sides = { present: 0, absent: 0, refused: 0, admitted: 0 };
        for (const name of judged) {
          const actor = actors[name]!;
          const visible = oracle.rows(actor, "collection", "view", options);
          const held = full(actor);
          sides.present += visible.filter((id) => held.has(id)).length;
          sides.absent += visible.filter((id) => !held.has(id)).length;
          if (visible.some((id) => !held.has(id))) sides.refused += 1;
          else sides.admitted += 1;
        }
        expect(sides.present).toBeGreaterThan(0);
        expect(sides.absent).toBeGreaterThan(0);
        expect(sides.refused).toBeGreaterThan(0);
        expect(sides.admitted).toBeGreaterThan(0);
        expect(mixed().length).toBeGreaterThan(0);
      });
    }
  });
}
