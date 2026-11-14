/**
 * A scalar class is exported, so it can be subclassed. A modifier answers a
 * scalar of the class that declares the modifiers, built from the state the
 * modifier made: a subclass whose constructor takes no state does not lose
 * what the modifier changed.
 */
import {
  boolean,
  dateTime,
  decimal,
  enumScalar,
  int,
  json,
} from "@schema/scalars";
import { BooleanScalar } from "@schema/scalars/boolean/scalar";
import type { ScalarState } from "@schema/scalars/common";
import { DateTimeScalar } from "@schema/scalars/datetime/scalar";
import { DecimalScalar } from "@schema/scalars/decimal/scalar";
import { EnumScalar } from "@schema/scalars/enum/scalar";
import { IntScalar } from "@schema/scalars/int/scalar";
import { JsonScalar } from "@schema/scalars/json/scalar";
import { describe, expect, it } from "vitest";

class FixedInt extends IntScalar<ScalarState<"int">> {
  constructor() {
    super(int()["~"].state);
  }
}
class FixedBoolean extends BooleanScalar<ScalarState<"boolean">> {
  constructor() {
    super(boolean()["~"].state);
  }
}
class FixedJson extends JsonScalar<ScalarState<"json">> {
  constructor() {
    super(json()["~"].state);
  }
}
class FixedDateTime extends DateTimeScalar<ScalarState<"datetime">> {
  constructor() {
    super(dateTime()["~"].state);
  }
}
class FixedEnum extends EnumScalar<ScalarState<"enum">> {
  constructor() {
    super(enumScalar(["a", "b"])["~"].state);
  }
}
class FixedDecimal extends DecimalScalar<ScalarState<"decimal">> {
  constructor() {
    super(decimal({ precision: 10, scale: 2 })["~"].state);
  }
}

const admitsNull = (scalar: {
  "~": { state: Pick<ScalarState, "nullable" | "base"> };
}) => [
  scalar["~"].state.nullable,
  scalar["~"].state.base["~standard"].validate(null),
];

describe("a subclass of a scalar whose constructor takes no state", () => {
  it("keeps what a modifier changed, in a scalar of the declaring class", () => {
    const cases = [
      [new FixedInt(), FixedInt, IntScalar],
      [new FixedBoolean(), FixedBoolean, BooleanScalar],
      [new FixedJson(), FixedJson, JsonScalar],
      [new FixedDateTime(), FixedDateTime, DateTimeScalar],
      [new FixedEnum(), FixedEnum, EnumScalar],
      [new FixedDecimal(), FixedDecimal, DecimalScalar],
    ] as const;
    for (const [fixed, Fixed, Declaring] of cases) {
      expect(admitsNull(fixed)).toEqual([false, expect.objectContaining({})]);
      const nullable = fixed.nullable();
      expect(nullable).toBeInstanceOf(Declaring);
      expect(nullable).not.toBeInstanceOf(Fixed);
      expect(admitsNull(nullable)).toEqual([true, { value: null }]);
      expect(fixed.map("col")["~"].state.columnName).toBe("col");
    }
  });

  it("keeps the modifiers a family adds: a key, a list, the instant of the write", () => {
    expect(new FixedInt().id()["~"].state.isId).toBe(true);
    expect(new FixedInt().array()["~"].state.array).toBe(true);
    expect(new FixedDateTime().now()["~"].state.autoGenerate).toEqual({
      kind: "now",
    });
    expect(new FixedDecimal().unique()["~"].state.isUnique).toBe(true);
    expect(new FixedEnum().array()["~"].state.array).toBe(true);
  });
});
