import { s } from "@src/schema";
import type { InferInput } from "@src/validation";
import type { requiredManyToOneSchemas } from "@tests/unit/operation-schemas/relations/fixtures";

const user = s.model({ id: s.string().id(), email: s.string() });

const _post = s.model({
  id: s.string().id(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

type RelationSelect = InferInput<typeof requiredManyToOneSchemas.select>;

const _acceptedRelation: RelationSelect = { select: { id: true } };

// @ts-expect-error - the typo is refused beside a valid related-model field
const _refusedRelation: RelationSelect = { select: { id: true, di: true } };
