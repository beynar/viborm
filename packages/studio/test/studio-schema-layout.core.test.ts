import { expect, test } from "vitest";
import type { StudioEdge, StudioModel, StudioSchema } from "../src/schema";
import { CARD_WIDTH, cardHeight } from "../ui/src/lib/diagram";
import { schemaLayout } from "../ui/src/lib/schema-layout";

const model = (name: string, pointsTo: readonly string[] = []) =>
  ({
    name,
    fields: [
      { name: "id" },
      { name: "title" },
      ...pointsTo.map((target) => ({ name: `${target}Id` })),
    ],
    relations: pointsTo.map((target) => ({ name: target })),
  }) as unknown as StudioModel;

const edgesOf = (models: readonly StudioModel[]): StudioEdge[] =>
  models.flatMap((from) =>
    from.relations.map((relation) => ({
      id: `${from.name}.${relation.name}`,
      kind: "one-to-many" as const,
      from: {
        model: from.name,
        relation: relation.name,
        columns: [`${relation.name}Id`],
      },
      to: { model: relation.name, columns: ["id"] },
      fromEnd: "zero-or-many" as const,
      toEnd: "one" as const,
    }))
  );

const schemaOf = (models: readonly StudioModel[]): StudioSchema => ({
  dialect: "postgresql",
  models,
  edges: edgesOf(models),
});

/** A team of models all joined to each other, the first pointing to `link`. */
const team = (prefix: string, size: number, link?: string) =>
  Array.from({ length: size }, (_, index) =>
    model(`${prefix}${index}`, [
      ...Array.from({ length: index }, (_, other) => `${prefix}${other}`),
      ...(index === 0 && link ? [link] : []),
    ])
  );

const shape = (
  at: ReadonlyMap<string, { x: number; y: number }>,
  s: StudioSchema
) => {
  const height = new Map(s.models.map((m) => [m.name, cardHeight(m)]));
  const places = [...at.values()];
  const width = Math.max(...places.map((p) => p.x)) + CARD_WIDTH;
  const tall = Math.max(
    ...[...at].map(([name, p]) => p.y + (height.get(name) ?? 0))
  );
  return { width, tall, columns: new Set(places.map((p) => p.x)).size };
};

const gapBetween = (
  at: ReadonlyMap<string, { x: number; y: number }>,
  a: string,
  b: string
) => {
  const p = at.get(a);
  const q = at.get(b);
  if (!(p && q)) throw new Error(`${a} or ${b} has no place`);
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
};

test("no schema has nothing to place", () => {
  expect(schemaLayout(schemaOf([])).size).toBe(0);
});

test.each([
  ["one model", [model("only")]],
  ["a model pointing to itself", [model("tree", ["tree"])]],
  ["a loop", [model("a", ["b"]), model("b", ["c"]), model("c", ["a"])]],
  ["models with no line", Array.from({ length: 12 }, (_, i) => model(`m${i}`))],
  [
    "a crowd",
    [
      model("hub"),
      ...Array.from({ length: 30 }, (_, i) => model(`m${i}`, ["hub"])),
    ],
  ],
  [
    "teams",
    [
      ...team("a", 6),
      ...team("b", 6, "a0"),
      ...team("c", 6, "b0"),
      model("lonely"),
    ],
  ],
])("%s: every card has a place of its own", (_, models) => {
  const schema = schemaOf(models);
  const at = schemaLayout(schema);
  expect([...at.keys()].sort()).toEqual(models.map((m) => m.name).sort());
  const cards = models.map((m) => ({
    ...(at.get(m.name) ?? { x: 0, y: 0 }),
    height: cardHeight(m),
    name: m.name,
  }));
  for (const [index, a] of cards.entries()) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    for (const b of cards.slice(index + 1)) {
      const apart =
        a.x + CARD_WIDTH <= b.x ||
        b.x + CARD_WIDTH <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      expect(apart, `${a.name} over ${b.name}`).toBe(true);
    }
  }
});

test("a schema has one layout, whatever order it is read in", () => {
  const models = [...team("a", 5), ...team("b", 5, "a0"), model("lonely")];
  const schema = schemaOf(models);
  const shuffled: StudioSchema = {
    ...schema,
    models: [...schema.models].reverse(),
    edges: [...schema.edges].reverse(),
  };
  expect(Object.fromEntries(schemaLayout(shuffled))).toEqual(
    Object.fromEntries(schemaLayout(schema))
  );
});

test("models that join each other stand nearer than models that barely do", () => {
  const schema = schemaOf([
    ...team("a", 5),
    ...team("b", 5, "a0"),
    ...team("c", 5, "b0"),
  ]);
  const at = schemaLayout(schema);
  const mean = (a: string, b: string) => {
    let sum = 0;
    for (let i = 0; i < 5; i += 1) {
      for (let k = 0; k < 5; k += 1)
        sum += gapBetween(at, `${a}${i}`, `${b}${k}`);
    }
    return sum / 25;
  };
  for (const [own, other] of [
    ["a", "b"],
    ["b", "c"],
    ["c", "a"],
  ] as const) {
    expect(mean(own, own)).toBeLessThan(mean(own, other));
  }
});

test("a model every other one points to does not make one group of the schema", () => {
  const pointingToUser = (prefix: string) =>
    Array.from({ length: 5 }, (_, index) =>
      model(`${prefix}${index}`, [
        "user",
        ...Array.from({ length: index }, (_, other) => `${prefix}${other}`),
      ])
    );
  const at = schemaLayout(
    schemaOf([model("user"), ...pointingToUser("a"), ...pointingToUser("b")])
  );
  const mean = (a: string, b: string) => {
    let sum = 0;
    for (let index = 0; index < 5; index += 1) {
      sum += gapBetween(at, `${a}0`, `${b}${index}`);
    }
    return sum / 5;
  };
  expect(mean("a", "a")).toBeLessThan(mean("a", "b"));
  expect(mean("b", "b")).toBeLessThan(mean("b", "a"));
});

test("inside a group the model pointed to stands left of the model pointing to it", () => {
  const at = schemaLayout(
    schemaOf([
      model("post", ["user"]),
      model("user"),
      model("comment", ["post"]),
    ])
  );
  const x = (name: string) => at.get(name)?.x ?? 0;
  expect(x("user")).toBeLessThan(x("post"));
  expect(x("post")).toBeLessThan(x("comment"));
});

test.each([
  [
    "a crowd around one model",
    [
      model("hub"),
      ...Array.from({ length: 40 }, (_, i) => model(`m${i}`, ["hub"])),
    ],
  ],
  ["models with no line", Array.from({ length: 40 }, (_, i) => model(`m${i}`))],
  [
    "many teams",
    Array.from({ length: 8 }, (_, g) =>
      team(`t${g}x`, 6, g > 0 ? `t${g - 1}x0` : undefined)
    ).flat(),
  ],
])("%s: the sheet is about as wide as a screen, in many columns", (_, models) => {
  const schema = schemaOf(models);
  const { width, tall, columns } = shape(schemaLayout(schema), schema);
  expect(columns).toBeGreaterThan(2);
  expect(width / tall).toBeGreaterThan(0.6);
  expect(width / tall).toBeLessThan(3);
});

test("a crowd stands on both sides of the model it points to", () => {
  const at = schemaLayout(
    schemaOf([
      model("hub"),
      ...Array.from({ length: 30 }, (_, i) => model(`m${i}`, ["hub"])),
    ])
  );
  const hub = at.get("hub")?.x ?? 0;
  const others = [...at].filter(([name]) => name !== "hub").map(([, p]) => p.x);
  expect(others.some((x) => x < hub)).toBe(true);
  expect(others.some((x) => x > hub)).toBe(true);
});

test("no line stretches a column apart", () => {
  const schema = schemaOf([
    model("user"),
    model("tag"),
    model("collection"),
    model("post", ["user", "tag", "collection"]),
    model("comment", ["post", "user"]),
    model("profile", ["user"]),
  ]);
  const at = schemaLayout(schema);
  const byColumn = new Map<number, StudioModel[]>();
  for (const m of schema.models) {
    const x = at.get(m.name)?.x ?? 0;
    byColumn.set(x, [...(byColumn.get(x) ?? []), m]);
  }
  for (const column of byColumn.values()) {
    const sorted = column.sort(
      (a, b) => (at.get(a.name)?.y ?? 0) - (at.get(b.name)?.y ?? 0)
    );
    for (const [index, card] of sorted.slice(1).entries()) {
      const above = sorted[index];
      if (!above) continue;
      const gap =
        (at.get(card.name)?.y ?? 0) -
        (at.get(above.name)?.y ?? 0) -
        cardHeight(above);
      expect(gap).toBeLessThanOrEqual(97);
    }
  }
});
