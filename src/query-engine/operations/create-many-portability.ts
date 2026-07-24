import { QueryEngineError } from "../types";

const DEFAULT_ONLY_SKIP_ERROR =
  "createMany with skipDuplicates cannot include a row with no explicit scalar values; no portable duplicate-only DEFAULT VALUES primitive exists.";

export function assertPortableCreateManySkip(
  skipDuplicates: boolean | undefined,
  hasDefaultOnlyRow: boolean
): void {
  if (skipDuplicates === true && hasDefaultOnlyRow) {
    throw new QueryEngineError(DEFAULT_ONLY_SKIP_ERROR);
  }
}
