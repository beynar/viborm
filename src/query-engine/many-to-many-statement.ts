import { getTableName } from "./context";
import type { RelationStatement } from "./operation-program";
import type { QueryScope, RelationInfo } from "./types";

/**
 * The oriented many-to-many junction statement descriptor (P6 pure-leaf
 * extraction, consumed by V2): names the parent model, relation, junction
 * operation, and its args so the executor can lower a membership change against
 * the join table.
 */
export function manyToManyStatement(
  parent: QueryScope,
  relation: RelationInfo,
  operation: RelationStatement["operation"],
  args: Record<string, unknown>
): RelationStatement {
  return {
    kind: "relation",
    operation,
    model: getTableName(parent.model),
    relation: relation.name,
    args,
  };
}
