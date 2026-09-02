/**
 * G — decode parity (pattern-engine-ideal-state.md §13.5 M3, decoding).
 *
 * Provider-row fixtures are decoded twice: through today's boundary
 * (`ResultParser.parse` with the shape derived from the request) and through
 * the pattern (`decodeRows`, shape derived from the projection). Results and
 * refusals must be identical, on a JSON-object provider and a JSON-text one.
 */
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  constructRead,
  type ReadOperation,
} from "@query-engine/pattern/construct-read";
import { decodeRows, expectedShapeOf } from "@query-engine/pattern/decode";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { ResultParser } from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import type { Operation } from "@query-engine/types";
import { validate } from "@query-engine/validator";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateSchemaOrThrow } from "@schema/validation";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      age: s.int().nullable(),
      posts: s.toMany(() => post).name("authored"),
    })
    .map("dp_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      views: s.bigInt(),
      createdAt: s.dateTime(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .name("authored")
        .fields("authorId")
        .references("id"),
      subject: s.toOne(
        { author: () => author, tag: () => tag },
        { values: { author: "dp.author", tag: "dp.tag" } }
      ),
    })
    .map("dp_posts");
  const tag = s
    .model({
      id: s.string().id(),
      label: s.string(),
    })
    .map("dp_tags");
  return { author, post, tag };
})();
hydrateSchemaNames(schema);
validateSchemaOrThrow(schema);
const registry = createModelRegistry(schema, createSchemaRegistry(schema));

const providers = [
  {
    name: "postgresql (json objects)",
    adapter: new PostgresAdapter(),
    dialect: "postgresql" as const,
    text: false,
  },
  {
    name: "sqlite (json text)",
    adapter: new SQLiteAdapter(),
    dialect: "sqlite" as const,
    text: true,
  },
];

const carrier = (value: unknown, text: boolean) =>
  text ? JSON.stringify(value) : value;

type Fixture = {
  readonly name: string;
  readonly model: Model<any>;
  readonly operation: ReadOperation;
  readonly args: Record<string, unknown>;
  readonly rows: (text: boolean) => unknown[];
};

const FIXTURES: readonly Fixture[] = [
  {
    name: "scalar rows with a nullable int and a bigint",
    model: schema.post,
    operation: "findMany",
    args: { select: { id: true, title: true, views: true } },
    rows: () => [
      { id: "p1", title: "a", views: "9007199254740993" },
      { id: "p2", title: "b", views: 3 },
    ],
  },
  {
    name: "to-many carrier reversed by a negative take",
    model: schema.author,
    operation: "findMany",
    args: {
      include: { posts: { take: -2, select: { id: true, title: true } } },
    },
    rows: (text) => [
      {
        id: "a1",
        name: "n",
        age: null,
        posts: carrier(
          [
            { id: "p2", title: "b" },
            { id: "p1", title: "a" },
          ],
          text
        ),
      },
    ],
  },
  {
    name: "to-one carrier and a relation count",
    model: schema.post,
    operation: "findFirst",
    args: {
      select: { id: true, author: { select: { id: true, name: true } } },
      include: undefined,
    },
    rows: (text) => [
      { id: "p1", author: carrier({ id: "a1", name: "n" }, text) },
    ],
  },
  {
    name: "relation counts",
    model: schema.author,
    operation: "findMany",
    args: { select: { id: true, _count: { select: { posts: true } } } },
    rows: (text) => [
      { id: "a1", "0viborm_relation_counts": carrier({ posts: 2 }, text) },
    ],
  },
  {
    name: "polymorphic carrier bound by the discriminator",
    model: schema.post,
    operation: "findMany",
    args: { select: { id: true, subject: true } },
    rows: (text) => [
      {
        id: "p1",
        subject: carrier(
          {
            __viborm_state: "linked",
            type: "author",
            data: { id: "a1", name: "n", age: 4 },
          },
          text
        ),
      },
      {
        id: "p2",
        subject: carrier(
          {
            __viborm_state: "linked",
            type: "tag",
            data: { id: "t9", label: "l" },
          },
          text
        ),
      },
      { id: "p3", subject: null },
    ],
  },
  {
    name: "malformed: an extra column",
    model: schema.post,
    operation: "findMany",
    args: { select: { id: true, title: true } },
    rows: () => [{ id: "p1", title: "a", views: 1 }],
  },
  {
    name: "malformed: a missing column",
    model: schema.post,
    operation: "findMany",
    args: { select: { id: true, title: true } },
    rows: () => [{ id: "p1" }],
  },
  {
    name: "malformed: a half-null polymorphic carrier",
    model: schema.post,
    operation: "findMany",
    args: { select: { id: true, subject: true } },
    rows: (text) => [
      {
        id: "p1",
        subject: carrier(
          { __viborm_state: "invalid", storedType: "dp.author", hasId: false },
          text
        ),
      },
    ],
  },
  {
    name: "malformed: a to-many carrier that is an object",
    model: schema.author,
    operation: "findMany",
    args: { include: { posts: true } },
    rows: (text) => [
      { id: "a1", name: "n", age: 1, posts: carrier({ id: "x" }, text) },
    ],
  },
  {
    name: "malformed: unknown discriminator",
    model: schema.post,
    operation: "findMany",
    args: { select: { id: true, subject: true } },
    rows: (text) => [
      {
        id: "p1",
        subject: carrier(
          { __viborm_state: "linked", type: "video", data: { id: "v" } },
          text
        ),
      },
    ],
  },
  {
    name: "count carrier",
    model: schema.post,
    operation: "count",
    args: { select: { _all: true, title: true } },
    rows: () => [{ _all: "3", title: 2 }],
  },
  {
    name: "aggregate carrier",
    model: schema.post,
    operation: "aggregate",
    args: { _count: true, _sum: { views: true }, _max: { title: true } },
    rows: (text) => [
      {
        "0viborm_aggregate:count": 4,
        "0viborm_aggregate:sum": carrier({ views: "12" }, text),
        "0viborm_aggregate:max": carrier({ title: "z" }, text),
      },
    ],
  },
  {
    name: "groupBy rows",
    model: schema.post,
    operation: "groupBy",
    args: { by: ["authorId"], _count: { id: true } },
    rows: (text) => [
      { authorId: "a1", "0viborm_aggregate:count": carrier({ id: 2 }, text) },
    ],
  },
];

type Outcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "error"; readonly name: string; readonly message: string };

const attempt = (run: () => unknown): Outcome => {
  try {
    return { kind: "value", value: run() };
  } catch (error) {
    const e = error as { name?: string; message?: string };
    return {
      kind: "error",
      name: String(e?.name),
      message: String(e?.message),
    };
  }
};

for (const provider of providers) {
  describe(`decode parity on ${provider.name}`, () => {
    const driver = new SqlOnlyDriver(provider.adapter, provider.dialect);
    const engine = new QueryEngine(driver, registry);
    const boundary = {
      adapter: engine.adapter,
      relations: engine.relations,
      driver,
    };

    test.each(
      FIXTURES.map((fixture) => [fixture.name, fixture] as const)
    )("%s", (_name, fixture) => {
      const operation = fixture.operation as Operation;
      const validated = validate<Record<string, unknown>>(
        engine.schemaRegistry,
        fixture.model,
        operation,
        fixture.args
      );
      const oracle = attempt(() =>
        new ResultParser(engine, fixture.model, driver).parse(
          operation,
          fixture.rows(provider.text),
          validated,
          buildExpectedResultShape(
            fixture.model,
            operation,
            validated,
            engine.relations
          )
        )
      );
      const pattern = constructRead(
        fixture.model,
        fixture.operation,
        validated,
        engine.relations
      );
      const viaPattern = attempt(() =>
        decodeRows(pattern, fixture.rows(provider.text), boundary)
      );
      expect(viaPattern).toEqual(oracle);
      const consumable = attempt(() =>
        decodeRows(pattern, fixture.rows(provider.text), boundary, {
          consumable: true,
        })
      );
      expect(consumable).toEqual(oracle);
    });

    test("the projection-derived shape equals the request-derived shape", () => {
      for (const fixture of FIXTURES) {
        const operation = fixture.operation as Operation;
        const validated = validate<Record<string, unknown>>(
          engine.schemaRegistry,
          fixture.model,
          operation,
          fixture.args
        );
        const pattern = constructRead(
          fixture.model,
          fixture.operation,
          validated,
          engine.relations
        );
        const expected = buildExpectedResultShape(
          fixture.model,
          operation,
          validated,
          engine.relations
        );
        const derived = expectedShapeOf(pattern, engine);
        expect({ ...derived, rawKeys: [...derived.rawKeys].sort() }).toEqual({
          ...expected,
          rawKeys: [...(expected?.rawKeys ?? [])].sort(),
        });
      }
    });
  });
}
