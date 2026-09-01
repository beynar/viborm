import {
  producedIdentitySchema,
  registerProducedIdentityBehavior,
} from "@tests/contracts/engine/write/junction-produced-identity-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

const substrates = [
  {
    name: "transaction",
    getFamily: usePGliteSchemaFamily(producedIdentitySchema, "transaction"),
  },
  {
    name: "atomic batch",
    getFamily: usePGliteSchemaFamily(producedIdentitySchema, "atomicBatch"),
  },
] as const;

for (const substrate of substrates) {
  registerProducedIdentityBehavior(
    substrate.name,
    async () => substrate.getFamily().client
  );
}
