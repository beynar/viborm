/**
 * The enum evolution suite on the CI PostgreSQL server (16): before 17, reset
 * cannot use a value added to a type it created until that addition commits.
 *
 * NOTE: requires a running PostgreSQL database (PG_TEST_CONNECTION_STRING).
 */

import { PgDriver } from "@drivers/pg";
import { enumEvolutionTests } from "@tests/fixtures/enum-evolution";
import { Pool } from "pg";
import { afterAll, describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg enum evolution", () => {
  const pool = new Pool({ connectionString: TEST_CONNECTION_STRING });
  afterAll(() => pool.end());

  enumEvolutionTests(async (label) => {
    const namespace = `enum_evolution_${label}`;
    await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${namespace}"`);
    return { namespace, driver: new PgDriver({ pool, namespace }) };
  });
});
