import type { InferInput } from "@src/validation";
import type { simpleSchemas } from "@tests/unit/operation-schemas/fixtures";

type WhereInput = InferInput<typeof simpleSchemas.where>;

const acceptedWhere: WhereInput = { name: "Ada", active: true };

// @ts-expect-error - the typo is refused beside a valid where key
const refusedWhere: WhereInput = { name: "Ada", nmae: "typo" };

// biome-ignore lint/complexity/noVoid: the discard is how a compile-only probe binding is consumed without asserting on its value
void acceptedWhere;
// biome-ignore lint/complexity/noVoid: the discard is how a compile-only probe binding is consumed without asserting on its value
void refusedWhere;
