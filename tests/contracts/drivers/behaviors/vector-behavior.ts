import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { Sql, sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const COSINE_INDEX = "vector_behavior_neighbours_cosine";
const L2_INDEX = "vector_behavior_neighbours_l2";
// The `.rawIndex()` texts above, as a test that cannot push them states them.
const POSTGRES_INDEXES = [
  `CREATE INDEX IF NOT EXISTS "${COSINE_INDEX}" ON "vector_behavior_neighbours" USING hnsw ("embedding" vector_cosine_ops)`,
  `CREATE INDEX IF NOT EXISTS "${L2_INDEX}" ON "vector_behavior_neighbours" USING hnsw ("embedding" vector_l2_ops)`,
];
const SURREAL_INDEX = `DEFINE INDEX IF NOT EXISTS ${COSINE_INDEX} ON vector_behavior_neighbours FIELDS embedding HNSW DIMENSION 3 DIST COSINE`;

const schema = (() => {
  const collection = s
    .model({
      id: s.string().id(),
      docs: s.toMany(() => doc),
      neighbours: s.toMany(() => neighbour),
    })
    .map("vector_behavior_collections");

  const doc = s
    .model({
      id: s.string().id(),
      collectionId: s.string(),
      collection: s
        .toOne(() => collection)
        .fields("collectionId")
        .references("id"),
      embedding: s.vector().dimension(3),
    })
    .map("vector_behavior_docs");

  // A missing and a zero vector beside the others: an index skips them.
  const neighbour = s
    .model({
      id: s.string().id(),
      group: s.string(),
      collectionId: s.string(),
      collection: s
        .toOne(() => collection)
        .fields("collectionId")
        .references("id"),
      embedding: s.vector().dimension(3).nullable(),
    })
    .rawIndex(COSINE_INDEX, {
      pg: "CREATE INDEX {name} ON {table} USING hnsw ({embedding} vector_cosine_ops)",
      surrealdb:
        "DEFINE INDEX {name} ON {table} FIELDS {embedding} HNSW DIMENSION 3 DIST COSINE",
    })
    .rawIndex(L2_INDEX, {
      pg: "CREATE INDEX {name} ON {table} USING hnsw ({embedding} vector_l2_ops)",
    })
    .map("vector_behavior_neighbours");

  return { collection, doc, neighbour };
})();

type VectorClientConfig = VibORMConfig<typeof schema>;

type VectorClient = VibORMClient<VectorClientConfig>;

export interface VectorBehaviorOptions {
  driverName: string;
  enabled: boolean;
  createDriver: () => AnyDriver;
}

export function runVectorBehavior({
  driverName,
  enabled,
  createDriver,
}: VectorBehaviorOptions) {
  const describeIf = enabled ? describe : describe.skip;

  describeIf(`${driverName} vector distance ordering`, () => {
    let client: VectorClient | undefined;
    let driver: AnyDriver | undefined;
    /** What the client sent, as the driver received it to execute. */
    const sent: { text: string; params: unknown[] }[] = [];

    // One database for the file: each test reseeds its rows.
    beforeAll(async () => {
      driver = createDriver();
      await driver._executeRaw("CREATE EXTENSION IF NOT EXISTS vector");
      client = createClient({ schema, driver });
      await syncLiveSchema(client);
      // Every driver executes a client's statement through its `execute`.
      const hooked = driver as unknown as {
        execute: (client: unknown, text: string, params: unknown[]) => unknown;
      };
      const execute = hooked.execute.bind(driver);
      hooked.execute = (provider, text, params) => {
        sent.push({ text, params });
        return execute(provider, text, params);
      };
      for (const statement of driver.dialect === "surrealql"
        ? [SURREAL_INDEX]
        : POSTGRES_INDEXES)
        await driver._executeRaw(statement);
    });

    beforeEach(async () => {
      const active = requireDriver(driver);
      await active._executeRaw('DELETE FROM "vector_behavior_neighbours"');
      await active._executeRaw('DELETE FROM "vector_behavior_docs"');
      await active._executeRaw('DELETE FROM "vector_behavior_collections"');
      await seedVectorDocs(active);
      await requireClient(client).neighbour.createMany({
        data: NEIGHBOURS.map(([id, group, embedding]) => ({
          id,
          group,
          collectionId: "collection",
          embedding,
        })),
      });
      sent.length = 0;
    });

    afterAll(async () => {
      if (client) {
        await client.$disconnect();
      } else if (driver) {
        await driver.disconnect();
      }
      client = undefined;
      driver = undefined;
    });

    /** The one statement `read` sends, and its rows. */
    const capture = async <T>(read: () => Promise<T>) => {
      sent.length = 0;
      const rows = await read();
      const [statement] = sent;
      if (sent.length !== 1 || !statement)
        throw new Error(
          `Expected one statement, the client sent ${sent.length}.`
        );
      return { rows, statement };
    };
    const nearest = (
      metric: "cosine" | "l2",
      approximate?: boolean
    ): { embedding: { _distance: VectorOrder } } => ({
      embedding: {
        _distance: {
          to: [1, 0, 0],
          metric,
          ...(approximate === undefined ? {} : { approximate }),
        },
      },
    });

    test("orders nearest-first by l2 distance and honors take", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: { id: true },
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
        },
        take: 2,
      });

      expect(docs.map((doc) => doc.id)).toEqual(["exact", "near"]);
    });

    test("orders farthest-first by l2 distance when distance sort is desc", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: { id: true },
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
              sort: "desc",
            },
          },
        },
        take: 2,
      });

      expect(docs.map((doc) => doc.id)).toEqual(["opposite", "orthogonal"]);
    });

    test("orders nearest-first by cosine distance and honors take", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: { id: true },
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "cosine",
            },
          },
        },
        take: 2,
      });

      expect(docs.map((doc) => doc.id)).toEqual(["exact", "near"]);
    });

    test("selects l2 distance scores as numbers", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: {
          id: true,
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
        },
        orderBy: { id: "asc" },
      });

      const scores = new Map(docs.map((doc) => [doc.id, doc._distance]));

      expect(typeof scores.get("exact")).toBe("number");
      expect(scores.get("exact")).toBeCloseTo(0);
      expect(scores.get("near")).toBeCloseTo(0.282_842_7);
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: This is the expected L2 distance the provider returns, not a stand-in for Math.SQRT2.
      expect(scores.get("orthogonal")).toBeCloseTo(1.414_213_5);
      expect(scores.get("opposite")).toBeCloseTo(2);
    });

    test("orders by distance and returns matching selected scores", async () => {
      const docs = await requireClient(client).doc.findMany({
        select: {
          id: true,
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
        },
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
        },
        take: 3,
      });

      expect(docs.map((doc) => doc.id)).toEqual([
        "exact",
        "near",
        "orthogonal",
      ]);
      expect(docs[0]?._distance).toBeCloseTo(0);
      expect(docs[1]?._distance).toBeCloseTo(0.282_842_7);
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: This is the expected L2 distance the provider returns, not a stand-in for Math.SQRT2.
      expect(docs[2]?._distance).toBeCloseTo(1.414_213_5);
    });

    test("orders included docs nearest-first by vector distance and honors take", async () => {
      const collections = await requireClient(client).collection.findMany({
        include: {
          docs: {
            select: { id: true },
            orderBy: {
              embedding: {
                _distance: {
                  to: [1, 0, 0],
                  metric: "l2",
                },
              },
            },
            take: 2,
          },
        },
      });

      expect(collections).toHaveLength(1);
      expect(collections[0]?.docs.map((doc) => doc.id)).toEqual([
        "exact",
        "near",
      ]);
    });

    test("throws on vector dimension mismatch before execution", async () => {
      await expect(
        requireClient(client).doc.findMany({
          select: { id: true },
          orderBy: {
            embedding: {
              _distance: {
                to: [1, 0],
                metric: "l2",
              },
            },
          },
        })
      ).rejects.toThrow(
        "Vector distance orderBy dimension mismatch for 'embedding': expected 3 values, received 2."
      );
    });

    test.each([
      "cosine",
      "l2",
    ] as const)("an approximate %s order reads the nearest rows nearest first", async (metric) => {
      const c = requireClient(client);
      const rows = await c.neighbour.findMany({
        select: { id: true },
        orderBy: nearest(metric, true),
        take: 3,
      });
      // Six rows: the index finds every one it holds, so this is also exact.
      expect(rows.map((row) => row.id)).toEqual(NEAREST[metric]);
      const first = await c.neighbour.findFirst({
        select: { id: true },
        orderBy: nearest(metric, true),
      });
      expect(first?.id).toBe("exact");
      const included = await c.neighbour.findMany({
        select: { id: true, collection: { select: { id: true } } },
        orderBy: nearest(metric, true),
        take: 3,
      });
      expect(included).toEqual(
        NEAREST[metric].map((id) => ({ id, collection: { id: "collection" } }))
      );
    });

    test("an approximate order keeps the selected distance exact", async () => {
      const rows = await requireClient(client).neighbour.findMany({
        select: {
          id: true,
          embedding: { _distance: { to: [1, 0, 0], metric: "cosine" } },
        },
        orderBy: nearest("cosine", true),
        take: 2,
      });
      expect(rows.map((row) => row.id)).toEqual(["exact", "near"]);
      expect(rows[0]?._distance).toBeCloseTo(0);
      expect(rows[1]?._distance).toBeCloseTo(0.029_857);
    });

    test("a filter beside an approximate order keeps only its own rows", async () => {
      const rows = await requireClient(client).neighbour.findMany({
        select: { id: true, group: true },
        where: { group: "a" },
        orderBy: nearest("cosine", true),
        take: 2,
      });
      // An index filters what it found: possibly fewer rows than `take`.
      const ids = rows.map((row) => row.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(["exact", "orthogonal"].slice(0, ids.length)).toEqual(ids);
    });

    test.each([
      "cosine",
      "l2",
    ] as const)("absent and false send the same %s statement", async (metric) => {
      const c = requireClient(client);
      const read = (approximate?: boolean) =>
        capture(() =>
          c.neighbour.findMany({
            select: { id: true },
            orderBy: nearest(metric, approximate),
            take: 3,
          })
        );
      const absent = await read();
      const off = await read(false);
      expect(off.statement).toEqual(absent.statement);
      expect(off.rows).toEqual(absent.rows);
    });

    test.each([
      "cosine",
      "l2",
    ] as const)("an approximate %s order names nothing where no index answers the read", async (metric) => {
      const c = requireClient(client);
      const reads: ((approximate?: boolean) => Promise<unknown>)[] = [
        (approximate) =>
          c.neighbour.findMany({
            orderBy: nearest(metric, approximate),
            take: 2,
            skip: 1,
          }),
        (approximate) =>
          c.neighbour.findMany({ orderBy: nearest(metric, approximate) }),
        (approximate) =>
          c.neighbour.findMany({
            orderBy: {
              embedding: {
                _distance: {
                  to: [1, 0, 0],
                  metric,
                  sort: "desc",
                  ...(approximate === undefined ? {} : { approximate }),
                },
              },
            },
            take: 2,
          }),
        (approximate) =>
          c.neighbour.findMany({
            orderBy: [{ group: "asc" }, nearest(metric, approximate)],
            take: 2,
          }),
        (approximate) =>
          c.neighbour.findMany({
            orderBy: nearest(metric, approximate),
            distinct: ["group"],
            take: 2,
          }),
        (approximate) =>
          c.collection.findMany({
            include: {
              neighbours: {
                select: { id: true },
                orderBy: nearest(metric, approximate),
                take: 2,
              },
            },
          }),
      ];
      for (const read of reads) {
        const exact = await capture(() => read());
        const flagged = await capture(() => read(true));
        expect(flagged.statement).toEqual(exact.statement);
        expect(flagged.rows).toEqual(exact.rows);
      }
    });

    test("an included read with an approximate order is exact", async () => {
      const collections = await requireClient(client).collection.findMany({
        include: {
          neighbours: {
            select: { id: true },
            where: { group: "a" },
            orderBy: nearest("cosine", true),
            take: 2,
          },
        },
      });
      expect(collections[0]?.neighbours.map((row) => row.id)).toEqual([
        "exact",
        "orthogonal",
      ]);
    });

    // biome-ignore lint/style/noDoneCallback: Vitest's test context, to skip on another dialect.
    test("PostgreSQL: only an approximate order is served by its HNSW index", async (context) => {
      const active = requireDriver(driver);
      if (active.dialect !== "postgresql") context.skip();
      const c = requireClient(client);
      for (const [metric, index] of [
        ["cosine", COSINE_INDEX],
        ["l2", L2_INDEX],
      ] as const) {
        const read = (approximate?: boolean) =>
          capture(() =>
            c.neighbour.findMany({
              select: { id: true },
              orderBy: nearest(metric, approximate),
              take: 3,
            })
          );
        const served = await explainPostgres(c, (await read(true)).statement);
        expect(served).toContain(`Index Scan using ${index}`);
        for (const exact of [await read(), await read(false)]) {
          expect(exact.rows.map((row) => row.id)).toEqual(NEAREST[metric]);
          const plan = await explainPostgres(c, exact.statement);
          expect(plan).toContain("Seq Scan");
          expect(plan).not.toContain(index);
        }
        const included = await capture(() =>
          c.collection.findMany({
            include: {
              neighbours: {
                select: { id: true },
                where: { group: "a" },
                orderBy: nearest(metric, true),
                take: 2,
              },
            },
          })
        );
        expect(await explainPostgres(c, included.statement)).not.toContain(
          index
        );
      }
    });

    // biome-ignore lint/style/noDoneCallback: Vitest's test context, to skip on another dialect.
    test("SurrealDB: a declared HNSW index answers an approximate cosine order", async (context) => {
      const active = requireDriver(driver);
      if (active.dialect !== "surrealql") context.skip();
      const { statement } = await capture(() =>
        requireClient(client).neighbour.findMany({
          select: { id: true },
          orderBy: nearest("cosine", true),
          take: 3,
        })
      );
      expect(statement.text).toContain("<|3,40|>");
      const plan = JSON.stringify(
        (
          await active._executeRaw(
            // A plan is one object, where a driver reads a list of rows.
            `RETURN [(${nearestSearch(statement.text)} EXPLAIN)]`,
            statement.params
          )
        ).rows
      );
      expect(plan).toContain("KnnScan");
      expect(plan).toContain(COSINE_INDEX);
    });

    // biome-ignore lint/style/noDoneCallback: Vitest's test context, to skip on another dialect.
    test("SurrealDB: an l2 order has no declared index of its distance and is exact", async (context) => {
      const active = requireDriver(driver);
      if (active.dialect !== "surrealql") context.skip();
      const c = requireClient(client);
      const read = (approximate?: boolean) =>
        capture(() =>
          c.neighbour.findMany({
            select: { id: true },
            orderBy: nearest("l2", approximate),
            take: 3,
          })
        );
      expect((await read(true)).statement).toEqual((await read()).statement);
    });

    // biome-ignore lint/style/noDoneCallback: Vitest's test context, to skip on another dialect.
    test("SurrealDB: without the index built, an approximate order answers exactly", async (context) => {
      const active = requireDriver(driver);
      if (active.dialect !== "surrealql") context.skip();
      await active._executeRaw(
        `REMOVE INDEX ${COSINE_INDEX} ON vector_behavior_neighbours`
      );
      try {
        const { rows, statement } = await capture(() =>
          requireClient(client).neighbour.findMany({
            select: { id: true },
            where: { group: "a" },
            orderBy: nearest("cosine", true),
            take: 2,
          })
        );
        expect(statement.text).toContain("<|2,40|>");
        expect(rows.map((row) => row.id)).toEqual(["exact", "orthogonal"]);
      } finally {
        await active._executeRaw(SURREAL_INDEX);
      }
    });
  });
}

type VectorOrder = {
  to: number[];
  metric: "cosine" | "l2";
  approximate?: boolean;
};

/** The three rows nearest `[1, 0, 0]`: a zero vector is 1 away in l2, cosine has no number for it. */
const NEAREST = {
  cosine: ["exact", "near", "orthogonal"],
  l2: ["exact", "near", "zero"],
};

const NEIGHBOURS: readonly (readonly [string, string, number[] | null])[] = [
  ["exact", "a", [1, 0, 0]],
  ["near", "b", [0.8, 0.2, 0]],
  ["orthogonal", "a", [0, 1, 0]],
  ["opposite", "b", [-1, 0, 0]],
  ["zero", "a", [0, 0, 0]],
  ["missing", "a", null],
];

/**
 * The plan PostgreSQL makes of a statement the client sent, as it sent it:
 * prepared, its parameters bound. A sequential scan is priced out wherever an
 * index can answer, so on six rows the plan says whether one can.
 */
async function explainPostgres(
  client: VectorClient,
  statement: { text: string; params: unknown[] }
): Promise<string> {
  const parts = statement.text.split(PLACEHOLDER);
  const strings: string[] = [`EXPLAIN ${parts[0]}`];
  const values: unknown[] = [];
  for (let at = 1; at < parts.length; at += 2) {
    values.push(statement.params[Number(parts[at]) - 1]);
    strings.push(parts[at + 1]!);
  }
  const rows = await client.$transaction(async (tx) => {
    await tx.$executeRaw(sql`SET LOCAL enable_seqscan = off`);
    return tx.$queryRaw<Record<string, unknown>>(
      new Sql(strings, values as never[])
    );
  });
  return rows.map((row) => Object.values(row).join("")).join("\n");
}
const PLACEHOLDER = /\$(\d+)/;

/** The nearest-neighbour search a SurrealQL read states ahead of itself: `LET $hN = …;`. */
function nearestSearch(text: string): string {
  const search = text.indexOf("<|");
  const start = text.indexOf(" = ", text.lastIndexOf("LET $", search));
  const end = text.indexOf(";", search);
  if (search < 0 || start < 0 || end < 0)
    throw new Error(`No nearest-neighbour search in: ${text}`);
  return text.slice(start + 3, end);
}

async function seedVectorDocs(driver: AnyDriver) {
  if (driver.dialect === "surrealql") {
    const docs = (
      [
        ["exact", [1, 0, 0]],
        ["near", [0.8, 0.2, 0]],
        ["orthogonal", [0, 1, 0]],
        ["opposite", [-1, 0, 0]],
      ] as const
    ).map(
      ([id, embedding]) =>
        `{ id: '${id}', collectionId: vector_behavior_collections:collection, embedding: [${embedding.join(", ")}] }`
    );
    await driver._executeRaw(
      "INSERT INTO vector_behavior_collections [{ id: 'collection' }]"
    );
    await driver._executeRaw(
      `INSERT INTO vector_behavior_docs [${docs.join(", ")}]`
    );
    return;
  }
  await driver._executeRaw(
    `INSERT INTO "vector_behavior_collections" ("id") VALUES ($1)`,
    ["collection"]
  );
  await driver._executeRaw(
    `INSERT INTO "vector_behavior_docs" ("id", "collectionId", "embedding") VALUES ` +
      "($1, $2, $3::vector), " +
      "($4, $5, $6::vector), " +
      "($7, $8, $9::vector), " +
      "($10, $11, $12::vector)",
    [
      "exact",
      "collection",
      "[1,0,0]",
      "near",
      "collection",
      "[0.8,0.2,0]",
      "orthogonal",
      "collection",
      "[0,1,0]",
      "opposite",
      "collection",
      "[-1,0,0]",
    ]
  );
}

function requireDriver(driver: AnyDriver | undefined): AnyDriver {
  if (!driver) {
    throw new Error("Vector behavior driver was not initialized.");
  }
  return driver;
}

function requireClient(client: VectorClient | undefined): VectorClient {
  if (!client) {
    throw new Error("Vector behavior client was not initialized.");
  }
  return client;
}

export const vectorContract = defineContract({
  id: "drivers.vector",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runVectorBehavior,
});
