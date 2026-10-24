/** How a read publishes its decoded rows: data, so a live transport applies the same rule. */
export type ReadResultRule =
  | { readonly kind: "rows"; readonly reversed?: true }
  | { readonly kind: "first"; readonly empty: "null" | "object" }
  | {
      readonly kind: "scalar";
      readonly field: string;
      readonly fallback: 0 | false;
    };

export function publishReadResult(
  rows: Record<string, unknown>[],
  rule: ReadResultRule
): unknown {
  // biome-ignore lint/style/useDefaultSwitchClause: the rule union is exhaustive.
  switch (rule.kind) {
    case "rows":
      return rule.reversed ? rows.reverse() : rows;
    case "first":
      return rows[0] ?? (rule.empty === "null" ? null : {});
    case "scalar":
      return rows[0]?.[rule.field] ?? rule.fallback;
  }
}
