import { remapStatementIndex } from "@drivers/driver-error-context";
import {
  readSuppressedFailures,
  withSuppressedFailure,
} from "@drivers/shared/suppressed-failure";
import { getTrustedErrorCause, UniqueConstraintError } from "@errors";
import { expect, test } from "vitest";

test("guard-prefix attribution rebases both public and trusted error metadata", () => {
  const cause = new Error("provider failure");
  const secondary = new Error("cleanup failure");
  const original = new UniqueConstraintError("duplicate", {
    cause,
    meta: { statementIndex: 3, model: "record" },
  });
  withSuppressedFailure(original, secondary);
  const remapped = remapStatementIndex(original, 0);
  expect(remapped).toBeInstanceOf(UniqueConstraintError);
  expect(original.meta.statementIndex).toBe(3);
  expect(remapped.meta.statementIndex).toBe(0);
  expect(remapped.toJSON().meta).toMatchObject({
    statementIndex: 0,
    model: "record",
  });
  expect(getTrustedErrorCause(remapped)).toMatchObject({
    name: getTrustedErrorCause(original)?.name,
    message: getTrustedErrorCause(original)?.message,
  });
  expect(getTrustedErrorCause(remapped)).not.toBe(cause);
  expect(readSuppressedFailures(remapped)).toEqual([secondary]);
});
