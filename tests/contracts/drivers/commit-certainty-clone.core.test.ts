import { attachCommitCertainty } from "@drivers/driver-error-context";
import {
  readSuppressedFailures,
  withSuppressedFailure,
} from "@drivers/shared/suppressed-failure";
import { getTrustedErrorCause, UniqueConstraintError } from "@errors";
import { expect, test } from "vitest";

test("attaching commit certainty clones public and trusted error state without mutating the original", () => {
  const cause = new Error("provider failure");
  const secondary = new Error("cleanup failure");
  const original = new UniqueConstraintError("duplicate", {
    cause,
    meta: { statementIndex: 3, model: "record" },
  });
  withSuppressedFailure(original, secondary);
  const clone = attachCommitCertainty(original, "may-have-committed");
  expect(clone).toBeInstanceOf(UniqueConstraintError);
  expect(original.meta).not.toHaveProperty("commitCertainty");
  expect(clone.toJSON().meta).toMatchObject({
    commitCertainty: "may-have-committed",
    statementIndex: 3,
    model: "record",
  });
  expect(getTrustedErrorCause(clone)).toMatchObject({
    name: getTrustedErrorCause(original)?.name,
    message: getTrustedErrorCause(original)?.message,
  });
  expect(getTrustedErrorCause(clone)).not.toBe(cause);
  expect(readSuppressedFailures(clone)).toEqual([secondary]);
});
