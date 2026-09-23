/**
 * G4 RF-16 witness — recursive reads on the fuller codec set, through the
 * PUBLIC client.
 *
 * These cells once entered the retired private root-only
 * `Queries.recursive(model, { seeds, relation, depth, args })` through an
 * `OperationContext`. That slice is gone (features-docs/recursive-query.md
 * §3.6): `recurse` modifies an ordinary relation node, and the shipped client's
 * `findMany` is the entry. The property is unchanged — DateTime, decimal,
 * bigint, enum, JSON and a scalar list decode exactly at every depth, over a
 * mapped compound identity path — and the one intentional contract change is
 * named at the cell that meets it (depth 0 is invalid, and the operation, not
 * a seed list, owns root cardinality and order).
 *
 * The schema, seeds, driver, hooks and the three cells live in
 * `recursive-fit-cells.ts`, shared with `unit02/recursive-codec-fit.test.ts`,
 * which reads the same projection through the command-engine entry; this file
 * registers them under its own identity with the client's `findMany`.
 *
 * Oracle: the public values are written by the shipped client and are the hand
 * values; the traversal must return exactly those values at every depth.
 */
import { describeRecursiveFit } from "./recursive-fit-cells";

describeRecursiveFit(
  "G4 RF-16 recursive reads on the fuller codec set",
  ({ client }, args) => {
    const reader = client as unknown as Record<
      string,
      { findMany(args: unknown): Promise<unknown> }
    >;
    return reader.node!.findMany(args);
  }
);
