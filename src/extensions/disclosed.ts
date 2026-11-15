/**
 * `disclosed(error, { sql?, parameters? })`: what a log or a span may show of
 * a failure. A `unit` handler that presents `failure(u)`, or an error another
 * extension noted, presents this copy, never the error itself: the error may
 * carry a provider's message, its stack, statement text or parameter values
 * the application's `disclosure` hides, and it may be any value at all.
 */
import { sanitizeErrorForLogging } from "@errors";
import { isError } from "../errors/diagnostic-safety";
import type { DisclosurePolicy } from "./disclosure";

/**
 * A new `Error`, safe to log or to put on a span, made from `error`.
 *
 * Of an error the package made (a `VibORMError`: every error the library
 * throws), it keeps what the package recorded when it built the error: its
 * `name`, `message`, `code`, `prismaCode`, `timestamp`, the `meta` keys the
 * package knows, and its causes. Of any other `Error`, it keeps the name
 * `"Error"`, the message `"Error details redacted"`, those of its own `code`,
 * `errno`, `sqlState`, `status` and `statusCode` that have the shape of a
 * code (`ECONNRESET`, a SQLSTATE, an HTTP status), and its causes.
 *
 * It removes the stack, always, and every property not named above. A
 * cause's message, `detail` and `hint` (a provider's words) are replaced by
 * `"Underlying error details redacted"` unless the application's
 * `disclosure` allowed `providerDetails` when the error was built; then they
 * are kept with the credentials in URLs, `password=…`, `token=…`,
 * `secret=…` and `Bearer …` redacted. A `callsite` is kept only where the
 * application's `disclosure` allowed `callsite`. Statement text (`meta.sql`)
 * is kept only with `allow.sql`, parameter values (`meta.params`) only with
 * `allow.parameters`; what the application's `disclosure` hid is not in the
 * error at all, so `allow` can only hide more.
 *
 * Bounds: a cause seen twice (a cycle) becomes an error `"[Circular]"`, a
 * chain deeper than eight causes `"[Truncated]"`; a string is cut at 4,096
 * characters, the whole copy at 32,768.
 *
 * A value that is not an `Error` (a string, a plain object, `undefined`)
 * gives `Error: Error details redacted`, and nothing of it but its prototype
 * chain is read.
 *
 * What it reads of an `Error`: its prototype chain (`instanceof`), the
 * package's own record of it, and its own data properties through their
 * descriptors, so a getter on them never runs; `originalCause` and `cause`
 * are read as properties, so a getter there runs, at most once per error of
 * the chain and per call. Each call reads again: call it once per failure
 * and keep the copy. It never throws: what cannot be read is left out.
 */
export function disclosed(
  error: unknown,
  allow: Pick<DisclosurePolicy, "sql" | "parameters"> = {}
): Error {
  // An error the package did not make shows no message: this one neither.
  const made = isError(error) ? error : new Error("A non-Error value failed.");
  return sanitizeErrorForLogging(made, {
    includeSql: allow.sql === true,
    includeParams: allow.parameters === true,
  });
}
