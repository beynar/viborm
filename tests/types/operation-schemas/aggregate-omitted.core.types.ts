import { s } from "@schema";
import type { InferInput } from "@src/validation";
import type { ModelStateSchemas } from "@validation/model";

const vault = s
  .model({
    id: s.string().id(),
    label: s.string(),
    // A numeric field beside the hidden one: an aggregate with no admitted
    // key at all types as `{}`, which TypeScript does not check for extras.
    score: s.int(),
    pin: s.int(),
    keeperId: s.string(),
    keeper: s
      .toOne(() => keeper)
      .fields("keeperId")
      .references("id"),
  })
  .omit({ pin: true });

const keeper = s.model({
  id: s.string().id(),
  vaults: s.toMany(() => vault),
});

type Args = ModelStateSchemas<typeof vault>["args"];
type Aggregate = InferInput<Args["aggregate"]>;
type GroupBy = InferInput<Args["groupBy"]>;
type KeeperFindMany = InferInput<
  ModelStateSchemas<typeof keeper>["args"]["findMany"]
>;

// `_count` and `where` return no value of the hidden field: both keep it.
const counted: Aggregate = {
  where: { pin: { gt: 3 } },
  _count: { pin: true },
  _max: { label: true },
};

// @ts-expect-error - a value aggregate never returns a field the model omits
const maxed: Aggregate = { _max: { pin: true } };

// @ts-expect-error - nor a value computed from it
const summed: Aggregate = { _sum: { pin: true } };

// An order returns no value either: a group may sort by the hidden field.
const sortedGroups: GroupBy = {
  by: ["label"],
  orderBy: { _max: { pin: "desc" } },
};

// And a to-many relation may order its parents by it.
const sortedKeepers: KeeperFindMany = {
  orderBy: { vaults: { _max: { pin: "desc" } } },
};

// @ts-expect-error - a group would carry the hidden value as its key
const grouped: GroupBy = { by: ["pin"] };

// biome-ignore lint/complexity/noVoid: the discard is how a compile-only probe binding is consumed without asserting on its value
void [counted, maxed, summed, sortedGroups, sortedKeepers, grouped];
