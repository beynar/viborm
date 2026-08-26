// biome-ignore lint/performance/noNamespaceImport: the frozen baseline and current implementation intentionally expose different private readers.
import * as transactionOperations from "../../src/query-engine/transaction-operation";

export function readBenchmarkOperation(value: unknown) {
  const privateReader = Reflect.get(
    transactionOperations,
    "readTransactionOperation"
  );
  if (typeof privateReader === "function") {
    if (value === null || typeof value !== "object") return undefined;
    const admission = privateReader(value);
    if (admission === undefined) return undefined;
    const ownerReader = Reflect.get(
      transactionOperations,
      "transactionOperationOwner"
    );
    const admittedPrepare = Reflect.get(admission, "prepare");
    const owner =
      typeof admittedPrepare === "function"
        ? admission
        : typeof ownerReader === "function"
          ? ownerReader(admission)
          : undefined;
    if (owner === undefined) return admission;
    const capability = owner === admission ? value : admission;
    return {
      parseResult(raw: unknown) {
        return Reflect.apply(Reflect.get(owner, "parseResult"), owner, [
          capability,
          raw,
        ]);
      },
      prepare(driver?: unknown) {
        return Reflect.apply(Reflect.get(owner, "prepare"), owner, [
          capability,
          driver,
        ]);
      },
      prepareBatch(driver?: unknown) {
        return Reflect.apply(Reflect.get(owner, "prepareBatch"), owner, [
          capability,
          driver,
        ]);
      },
    };
  }

  // Protocol overlays on the frozen pre-extension baseline use its old
  // transaction-operation predicate. Current builds always take the private,
  // unforgeable reader above.
  const legacyPredicate = Reflect.get(
    transactionOperations,
    "isTransactionOperation"
  );
  return typeof legacyPredicate === "function" && legacyPredicate(value)
    ? value
    : undefined;
}
