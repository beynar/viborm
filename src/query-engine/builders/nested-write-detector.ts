export const SUPPORTED_NESTED_WRITE_KEYS = [
  "create",
  "createMany",
  "connect",
  "connectOrCreate",
  "disconnect",
  "delete",
  "set",
] as const;

export type SupportedNestedWriteKey =
  (typeof SUPPORTED_NESTED_WRITE_KEYS)[number];

export function hasNestedWritesInData(data: unknown): boolean {
  if (!isRecord(data)) {
    return false;
  }

  return Object.values(data).some(hasSupportedNestedWriteInput);
}

export function hasSupportedNestedWriteInput(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  for (const key of SUPPORTED_NESTED_WRITE_KEYS) {
    if (key === "set") {
      if (Array.isArray(value.set)) {
        return true;
      }
      continue;
    }

    if (key in value) {
      return true;
    }
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
