import { UnsupportedOperationError } from "@errors";
import { expect } from "vitest";

export function indivisibleGeneratedOutputRefusalMessage(
  output: string
): string {
  return `query-engine-v2 cannot materialize generated output '${output}' across statements inside one indivisible shared batch. Use the default operation form or a driver with an interactive transaction.`;
}

export async function expectIndivisibleGeneratedOutputRefusal(
  operation: PromiseLike<unknown>,
  output: string
): Promise<void> {
  const thrown = await operation.then(
    () => undefined,
    (error: unknown) => error
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: This shared assertion helper is invoked only from registered tests.
  expect(thrown).toBeInstanceOf(UnsupportedOperationError);
  if (!(thrown instanceof UnsupportedOperationError)) throw thrown;
  // biome-ignore lint/suspicious/noMisplacedAssertion: This shared assertion helper is invoked only from registered tests.
  expect(thrown.message).toBe(indivisibleGeneratedOutputRefusalMessage(output));
}
