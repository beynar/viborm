import type { Scalar } from "@schema/scalars";

export function isGeneratedIncrementDefault(
  field: Scalar | undefined,
  value: unknown
): boolean {
  const state = field?.["~"].state;
  if (state?.autoGenerate !== "increment") {
    return false;
  }

  return value === state.default;
}
