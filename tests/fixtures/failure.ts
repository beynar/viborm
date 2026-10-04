/** The rejection of an operation that must fail; a fulfilment is the test's failure. */
export async function failure(pending: PromiseLike<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}
