/**
 * postgres.js Driver Tests — a scalar list bound as one parameter (engine-09):
 * the array's own text crosses as one string, which postgres.js hands to the
 * server for the type the server describes.
 */

import { runBoundMemberListBehavior } from "@tests/contracts/engine/query/bound-member-list-behavior";
import { createPostgresDriver, describeIf } from "./postgres-fixtures";

describeIf("postgres.js Driver", () => {
  runBoundMemberListBehavior({
    name: "postgres.js",
    dialect: "postgresql",
    createDriver: createPostgresDriver,
  });
});
