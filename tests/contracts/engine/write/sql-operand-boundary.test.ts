import {
  registerSqlOperandWallBehavior,
  sqlOperandWallSchema,
} from "@tests/contracts/engine/write/sql-operand-boundary-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

const substrates = [
  {
    name: "transaction",
    getFamily: usePGliteSchemaFamily(sqlOperandWallSchema, "transaction"),
  },
  {
    name: "atomic batch",
    getFamily: usePGliteSchemaFamily(sqlOperandWallSchema, "atomicBatch"),
  },
] as const;

for (const substrate of substrates) {
  registerSqlOperandWallBehavior(
    substrate.name,
    async () => substrate.getFamily().client
  );
}
