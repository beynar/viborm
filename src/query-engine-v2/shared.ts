import type { Model } from "@schema/model";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getStepModelName(model: Model<any>, fallback: string): string {
  return model["~"].names.ts ?? model["~"].names.sql ?? fallback;
}
