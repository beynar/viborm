/**
 * What a pinned migration session treats as its lost connection, over
 * postgres.js (plan S2; CI runs 38100835561, 38107336285). The session asks
 * the driver error mapping, its one classifier (`reportsLostConnection`): a
 * failure that maps to a `ConnectionError` ends the session at once, without
 * a cleanup statement. Any other failure leaves it live, and its ROLLBACK and
 * unlock then wait out `CLEANUP_BOUND_MS` each on a socket that is gone.
 *
 * postgres.js rejects a query on a connection that died with its own codes:
 * `CONNECTION_CLOSED` (the socket closed), `CONNECTION_DESTROYED` (the
 * connection was terminated while a query was queued or in flight),
 * `CONNECTION_ENDED` (a query sent after it ended), and the socket's own
 * error, such as `EPIPE` for a write to a peer that already closed.
 */

import { normalizeDriverError } from "@drivers/error-mapping";
import { ConnectionError } from "@errors";
import { describe, expect, test } from "vitest";

describe("a postgres.js connection failure on a pinned migration session", () => {
  test.each([
    "CONNECTION_CLOSED",
    "CONNECTION_DESTROYED",
    "CONNECTION_ENDED",
    "ECONNRESET",
    "EPIPE",
  ])("%s is the lost connection", (code) => {
    const mapped = normalizeDriverError(
      Object.assign(new Error(`write ${code}`), { code }),
      { driverName: "postgres", dialect: "postgresql" }
    );
    expect(mapped).toBeInstanceOf(ConnectionError);
    expect(mapped).toMatchObject({ code: "V1001" });
  });
});
