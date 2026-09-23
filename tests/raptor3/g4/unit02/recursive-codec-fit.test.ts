/**
 * G4-02 author check — RF-16's property, measured with a traversal-only walk,
 * through the COMMAND ENGINE entry.
 *
 * It began as a copy of `tests/raptor3/g4/read-recursive-fit.test.ts` whose
 * flattening walk descended the traversal relation (`children`) instead of
 * every nested value, because each row's `document: { code }` JSON payload
 * would otherwise be adopted as a traversal row (`g4/unit02/note.md` §P.11).
 * The witness file walks the same way today, so the two files differ only by
 * their entry and share the schema, seeds, driver, hooks and three cells
 * (`../recursive-fit-cells.ts`). Both files entered the retired private
 * `Queries.recursive(model, traversal)` through an `OperationContext`; that
 * slice is gone (features-docs/recursive-query.md §3.6). The witness file
 * reads through the public client; this one reads the same `recurse`
 * projection through `createCommandEngine(...).execute`, the engine entry the
 * client routes to, so the two files are the two entries of one projection
 * rather than one duplicate. Intentional contract change, named at its cell:
 * depth 0 is invalid, and the operation, not a seed list, owns root
 * cardinality and order.
 */
import { createCommandEngine } from "@query-engine/raptor3/commands";
import {
  describeRecursiveFit,
  recursiveFitSchema,
} from "../recursive-fit-cells";

describeRecursiveFit(
  "G4 RF-16 recursive reads on the fuller codec set",
  ({ driver }, args) =>
    createCommandEngine({ schema: recursiveFitSchema, driver }).execute(
      "node",
      "findMany",
      args
    )
);
