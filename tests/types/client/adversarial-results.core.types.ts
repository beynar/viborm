import { createClient } from "@src/drivers/sqlite3";
import { s } from "@src/schema";
import { expectTypeOf } from "vitest";

const item = s.model({
  id: s.int().id(),
  category: s.string(),
  price: s.number(),
  embedding: s.vector().dimension(3),
  optionalEmbedding: s.vector().dimension(3).nullable(),
  parentId: s.int().nullable(),
  parent: s
    .toOne(() => item)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => item),
});
const client = createClient({ schema: { item } });

async function resultShapes(dynamic: boolean) {
  const asPromise: Promise<{ id: number }[]> = client.item.findMany({
    select: { id: true },
  });
  const promised = <T>(read: () => T | Promise<T>): T | Promise<T> => read();
  expectTypeOf(
    promised(() => client.item.findMany({ select: { id: true } }))
  ).toEqualTypeOf<{ id: number }[] | Promise<{ id: number }[]>>();
  expectTypeOf(asPromise).toEqualTypeOf<Promise<{ id: number }[]>>();
  const l2 = await client.item.findMany({
    select: { embedding: { _distance: { to: [1, 0, 0], metric: "l2" } } },
  });
  const cosine = await client.item.findMany({
    select: { embedding: { _distance: { to: [1, 0, 0], metric: "cosine" } } },
  });
  const nullable = await client.item.findMany({
    select: {
      optionalEmbedding: { _distance: { to: [1, 0, 0], metric: "l2" } },
    },
  });
  expectTypeOf(l2[0]!._distance).toEqualTypeOf<number>();
  expectTypeOf(cosine[0]!._distance).toEqualTypeOf<number | null>();
  expectTypeOf(nullable[0]!._distance).toEqualTypeOf<number | null>();
  // @ts-expect-error Select and include cannot both be active.
  client.item.findMany({ select: { id: true }, include: { children: true } });
  const conflicting = {
    select: { id: true },
    include: { children: true },
  } as const;
  // @ts-expect-error The same exclusivity applies to held arguments.
  client.item.findMany(conflicting);
  client.item.findMany({
    // @ts-expect-error Nested projection nodes obey the same rule.
    include: { children: { select: { id: true }, include: { parent: true } } },
  });
  client.item.findMany({ select: undefined, include: { children: true } });
  const grouped = await client.item.groupBy({
    by: ["id", "category"],
    _count: true,
  });
  expectTypeOf(grouped[0]!.id).toEqualTypeOf<number>();
  expectTypeOf(grouped[0]!.category).toEqualTypeOf<string>();
  expectTypeOf(grouped[0]!._count).toEqualTypeOf<number>();

  const totals = await client.item.aggregate({
    _sum: { id: false, price: true },
    _avg: { id: false, price: true },
    _min: { id: false, price: true },
    _max: { id: false, price: true },
    _count: { id: false, price: true },
  });
  expectTypeOf(totals._sum.price).toEqualTypeOf<number | null>();
  // @ts-expect-error false aggregate selector is absent
  totals._sum.id;
  // @ts-expect-error false aggregate selector is absent
  totals._avg.id;
  // @ts-expect-error false aggregate selector is absent
  totals._min.id;
  // @ts-expect-error false aggregate selector is absent
  totals._max.id;
  // @ts-expect-error false count selector is absent
  totals._count.id;

  const selected = await client.item.findMany({
    select: { id: true, price: dynamic },
  });
  expectTypeOf(selected[0]!.id).toEqualTypeOf<number>();
  expectTypeOf(selected[0]!.price).toEqualTypeOf<number | undefined>();
  const maybeTotal = await client.item.aggregate({ _sum: { price: dynamic } });
  expectTypeOf(maybeTotal._sum.price).toEqualTypeOf<
    number | null | undefined
  >();
}
