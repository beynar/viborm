/**
 * The single-statement publication surface (C-01, D-14).
 *
 * `PendingOperation` is exported from the package entry, so the type of what it
 * publishes about the ONE statement an operation compiles to is a public
 * contract. This file states it where a compiler can check it:
 * `buildStatement()` publishes `Sql | undefined` — `undefined` is a real answer
 * (a verb that does not compile to exactly one statement), so a consumer cannot
 * use the result without narrowing it.
 *
 * Entering through the package entry is the point: a probe that named an
 * internal alias would type the alias, not what a consumer can write.
 */

import type { Sql } from "@sql";
import type { PendingOperation } from "@src/index";

declare const operation: PendingOperation<{ id: string }>;

// The published statement is optional: absence is an answer, not an error.
export const publishedStatement: Sql | undefined = operation.buildStatement();

// @ts-expect-error - an operation that compiles to no single statement answers `undefined`
export const requiredStatement: Sql = operation.buildStatement();
