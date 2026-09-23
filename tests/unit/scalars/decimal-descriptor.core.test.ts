import { ValidationError, VibORMErrorCode } from "@errors";
import { decimal } from "@schema/scalars";
import { Decimal } from "@src/index";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, it } from "vitest";

// `s.decimal({ precision, scale })` is the first scalar factory that reads a
// caller-owned object, so the hostile-definition matrix lives here rather than
// beside the value grammar. It must also live under tests/unit/scalars for the
// L2 coverage gate to execute every refusal arm.

const domain = () => ({ precision: 10, scale: 2 });

/** Build and return the refusal, or fail loudly if the call was accepted. */
const refusal = (build: () => unknown): ValidationError => {
  try {
    build();
  } catch (thrown) {
    if (thrown instanceof ValidationError) return thrown;
    throw thrown;
  }
  throw new Error("expected the declaration to be refused");
};

describe("decimal descriptor", () => {
  it("declares the domain as immutable scalar state", () => {
    const scalar = decimal({ precision: 10, scale: 2 });
    expect(scalar["~"].state.decimal).toEqual({ precision: 10, scale: 2 });
    expect(Object.isFrozen(scalar["~"].state.decimal)).toBe(true);
  });

  it("freezes a COPY, so mutating the caller's object afterwards is inert", () => {
    const source = { precision: 10, scale: 2 };
    const scalar = decimal(source);
    source.precision = 4;
    source.scale = 4;
    expect(scalar["~"].state.decimal).toEqual({ precision: 10, scale: 2 });
  });

  it("carries the SAME descriptor object through every modifier", () => {
    // Identity, not equality: a modifier that rebuilt the domain would be a
    // second owner of it, and the two copies could drift.
    const scalar = decimal({ precision: 12, scale: 4 });
    const declared = scalar["~"].state.decimal;
    // `.unique()` is chained on the SCALAR arm, not on the list one: a
    // fixed-decimal list cannot be a key, so `.array().unique()` is refused at
    // the declaration (see `decimal-list-exclusions.core.test.ts`).
    const chained = scalar.nullable().array().map("amount").default(null);
    expect(Object.is(chained["~"].state.decimal, declared)).toBe(true);
    expect(
      Object.is(scalar.nullable().unique()["~"].state.decimal, declared)
    ).toBe(true);
    expect(Object.is(scalar.id()["~"].state.decimal, declared)).toBe(true);
    expect(
      Object.is(
        scalar.schema({
          "~standard": {
            version: 1,
            vendor: "test",
            validate: (value: unknown) => ({ value: value as Decimal }),
          },
        })["~"].state.decimal,
        declared
      )
    ).toBe(true);
  });

  it("publishes no native-type override", () => {
    // A decimal's column type is derived from the domain on every dialect, so
    // the internal accessor DECLARES the absence rather than leaving a slot a
    // later reader could fill.
    expect(decimal(domain())["~"].nativeType).toBeUndefined();
  });

  it.each([
    ["a missing descriptor", () => (decimal as any)(), "descriptor.precision"],
    ["a null descriptor", () => (decimal as any)(null), "descriptor.precision"],
    ["a number descriptor", () => (decimal as any)(5), "descriptor.precision"],
    [
      "an array descriptor",
      () => (decimal as any)([10, 2]),
      "descriptor.precision",
    ],
    [
      "a missing precision",
      () => (decimal as any)({ scale: 2 }),
      "descriptor.precision",
    ],
    [
      "a missing scale",
      () => (decimal as any)({ precision: 10 }),
      "descriptor.scale",
    ],
    [
      "an explicit undefined precision",
      () => (decimal as any)({ precision: undefined, scale: 2 }),
      "descriptor.precision",
    ],
    [
      "a string precision",
      () => (decimal as any)({ precision: "10", scale: 2 }),
      "descriptor.precision",
    ],
    [
      "a fractional precision",
      () => (decimal as any)({ precision: 10.5, scale: 2 }),
      "descriptor.precision",
    ],
    [
      "a NaN scale",
      () => (decimal as any)({ precision: 10, scale: Number.NaN }),
      "descriptor.scale",
    ],
    [
      "an infinite precision",
      () => (decimal as any)({ precision: Number.POSITIVE_INFINITY, scale: 2 }),
      "descriptor.precision",
    ],
    [
      "a negative-zero scale",
      () => (decimal as any)({ precision: 10, scale: -0 }),
      "descriptor.scale",
    ],
    [
      "a zero precision",
      () => (decimal as any)({ precision: 0, scale: 0 }),
      "descriptor.precision",
    ],
    [
      "a negative precision",
      () => (decimal as any)({ precision: -1, scale: 0 }),
      "descriptor.precision",
    ],
    [
      "a negative scale",
      () => (decimal as any)({ precision: 10, scale: -1 }),
      "descriptor.scale",
    ],
    [
      "a precision beyond the safe integers",
      () => (decimal as any)({ precision: 2 ** 53, scale: 0 }),
      "descriptor.precision",
    ],
    [
      "a scale greater than precision",
      () => (decimal as any)({ precision: 4, scale: 5 }),
      "descriptor.scale",
    ],
  ])("refuses %s at the declaration", (_name, build, path) => {
    const error = refusal(build);
    expect(error.source).toMatchObject({
      kind: "schema-builder",
      builder: "s.decimal",
      path,
    });
    expect(error.code).toBe(VibORMErrorCode.INVALID_INPUT);
    expect(error.issues).toEqual([
      {
        path,
        message:
          path === "descriptor.precision"
            ? "'precision' must be an integer between 1 and the maximum safe integer"
            : "'scale' must be an integer between 0 and precision",
      },
    ]);
  });

  it("reads the descriptor as an ordinary argument", () => {
    // The descriptor is the developer's own argument, so it is read like one:
    // an inherited pair names the same numbers, and a key the domain has no
    // name for is ignored at runtime (the public type refuses it, fresh or
    // held — see tests/types/scalars/state.core.types.ts).
    expect(
      (decimal as any)(Object.create({ precision: 10, scale: 2 }))["~"].state
        .decimal
    ).toEqual({ precision: 10, scale: 2 });
    expect(
      (decimal as any)({ precision: 10, scale: 2, rounding: "half-even" })["~"]
        .state.decimal
    ).toEqual({ precision: 10, scale: 2 });
  });

  it("accepts scale zero and a scale equal to precision", () => {
    expect(decimal({ precision: 5, scale: 0 })["~"].state.decimal).toEqual({
      precision: 5,
      scale: 0,
    });
    expect(decimal({ precision: 5, scale: 5 })["~"].state.decimal).toEqual({
      precision: 5,
      scale: 5,
    });
  });

  it("validates and normalizes defaults at the maximum declared domain without allocating the scale", () => {
    const scalar = decimal({
      precision: Number.MAX_SAFE_INTEGER,
      scale: Number.MAX_SAFE_INTEGER,
    });

    expect(scalar["~"].state.base["~standard"].validate("0.1")).toEqual({
      value: "0.1",
    });
    expect(scalar["~"].state.base["~standard"].validate("1")).toHaveProperty(
      "issues"
    );
    expect(scalar.default("0")["~"].state.default).toBe("0");
  });

  it("refuses a forged Decimal candidate as a default", () => {
    // The default is normalized through the field codec at definition time, so
    // a value the constructor never built would be frozen into model metadata
    // and into every DDL default derived from it. Both halves of the codec's
    // admission are witnessed: an ordinary object carrying decimal-shaped keys,
    // and a value wearing the prototype without ever having been constructed —
    // which passes `instanceof` and still has no coefficient to read.
    for (const forged of [
      { s: 1, e: 0, c: [1] },
      Object.create(Decimal.prototype),
    ]) {
      expect(
        refusal(() => decimal(domain()).default(forged as never)).source
      ).toMatchObject({ kind: "schema-builder", builder: "s.decimal" });
    }
  });

  describe("a custom schema survives every modifier order", () => {
    // `create` reads `state.schema` directly, but `set`, `equals` and the
    // field's own value schema all read `state.base` — so a modifier that
    // rebuilt `base` without the schema would make ONE field validate
    // differently on create than on update.
    type Probe = {
      "~standard": {
        version: 1;
        vendor: string;
        validate: (value: unknown) => { value: Decimal };
      };
    };

    const ORDERS: readonly [string, (schema: Probe) => void][] = [
      [
        "schema()",
        (s) => {
          decimal(domain())
            .schema(s)
            ["~"].state.base["~standard"].validate("1.5");
        },
      ],
      [
        "schema().nullable()",
        (s) => {
          decimal(domain())
            .schema(s)
            .nullable()
            ["~"].state.base["~standard"].validate("1.5");
        },
      ],
      [
        "schema().array()",
        (s) => {
          decimal(domain())
            .schema(s)
            .array()
            ["~"].state.base["~standard"].validate(["1.5"]);
        },
      ],
      [
        "nullable().schema()",
        (s) => {
          decimal(domain())
            .nullable()
            .schema(s)
            ["~"].state.base["~standard"].validate("1.5");
        },
      ],
      [
        "schema().unique().map()",
        (s) => {
          decimal(domain())
            .schema(s)
            .unique()
            .map("amount")
            ["~"].state.base["~standard"].validate("1.5");
        },
      ],
    ];

    it.each(
      ORDERS
    )("runs the custom schema from `base` after %s", (_n, run) => {
      let runs = 0;
      const probe: Probe = {
        "~standard": {
          version: 1 as const,
          vendor: "decimal-descriptor-test",
          validate: (value: unknown) => {
            runs += 1;
            return { value: value as Decimal };
          },
        },
      };
      run(probe);
      expect(runs).toBe(1);
    });
  });

  describe("defaults", () => {
    it("normalizes a literal default to canonical text", () => {
      expect(decimal(domain()).default("4.20")["~"].state.default).toBe("4.2");
      expect(decimal(domain()).default("-0")["~"].state.default).toBe("0");
      expect(
        decimal(domain()).default(new Decimal("1.5"))["~"].state.default
      ).toBe("1.5");
    });

    it("normalizes every member of a list default", () => {
      expect(
        decimal(domain()).array().default(["1.10", "2"])["~"].state.default
      ).toEqual(["1.1", "2"]);
    });

    it("gives each omitted literal-list default a fresh array", () => {
      const create = getScalarSchemas(
        decimal(domain()).array().default(["1.10"])["~"].state
      ).create;
      const first = create["~standard"].validate(undefined);
      const second = create["~standard"].validate(undefined);

      expect(first).toEqual({ value: ["1.1"] });
      expect(second).toEqual({ value: ["1.1"] });
      if (!("value" in first && "value" in second)) {
        throw new Error("expected literal default values");
      }
      expect(first.value).not.toBe(second.value);
    });

    it("copies a list default without calling caller array methods", () => {
      // The field's own list schema reads each index and builds a fresh array,
      // so a shadowing property on the caller's list is never called and never
      // retained.
      let mapCalls = 0;
      const shadowed = ["1.10"];
      Object.defineProperty(shadowed, "map", {
        value: () => {
          mapCalls += 1;
          throw new Error("caller map ran");
        },
      });

      const retained = decimal(domain()).array().default(shadowed)["~"]
        .state.default;
      expect(retained).toEqual(["1.1"]);
      expect(retained).not.toBe(shadowed);
      expect(mapCalls).toBe(0);
    });

    it("refuses revoked and sparse list defaults with the default sentence", () => {
      const revoked = Proxy.revocable(["1.10"], {});
      revoked.revoke();
      const sparse = new Array<string>(1);
      const offsetHole = new Array<string>(1);
      Object.defineProperty(offsetHole, "shadow", { value: "1.5" });

      for (const list of [revoked.proxy, sparse, offsetHole]) {
        const error = refusal(() => decimal(domain()).array().default(list));
        expect(error.source).toEqual({
          kind: "schema-builder",
          builder: "s.decimal",
          path: "default",
        });
        expect(error.issues).toEqual([
          {
            path: "default",
            message: "The decimal default did not satisfy its field schema",
          },
        ]);
      }
    });

    it("runs literal defaults through the current full field codec", () => {
      let observed = 0;
      const scalar = decimal(domain())
        .schema({
          "~standard": {
            version: 1,
            vendor: "decimal-descriptor-test",
            validate: (value: unknown) => {
              observed += 1;
              if (!(value instanceof Decimal)) {
                return { issues: [{ message: "Expected Decimal" }] };
              }
              return value.eq("1.5")
                ? { value }
                : { issues: [{ message: "Expected 1.5" }] };
            },
          },
        })
        .default("1.50");

      expect(scalar["~"].state.default).toBe("1.5");
      expect(observed).toBe(1);
      expect(() =>
        decimal(domain())
          .schema({
            "~standard": {
              version: 1,
              vendor: "decimal-descriptor-test",
              validate: () => ({ issues: [{ message: "never" }] }),
            },
          })
          .default("1.5")
      ).toThrowError(ValidationError);
    });

    it("revalidates a retained literal default after schema and arity changes", () => {
      expect(() =>
        decimal(domain())
          .default("1.5")
          .schema({
            "~standard": {
              version: 1,
              vendor: "decimal-descriptor-test",
              validate: () => ({ issues: [{ message: "never" }] }),
            },
          })
      ).toThrowError(ValidationError);

      expect(() => decimal(domain()).default("1.5").array()).toThrowError(
        ValidationError
      );
    });

    it("lets a developer's custom schema speak for itself at the default", () => {
      // The custom schema is the developer's own code: what it throws reaches
      // the developer unchanged, and an async one is refused by the field
      // pipeline, whose refusal the default reports in its one sentence.
      const withSchema = (validate: (value: unknown) => unknown) =>
        decimal(domain()).schema({
          "~standard": {
            version: 1,
            vendor: "decimal-descriptor-test",
            validate,
          },
        } as never);

      expect(() =>
        withSchema(() => {
          throw new Error("custom exploded");
        }).default("1.5")
      ).toThrowError("custom exploded");
      expect(
        refusal(() =>
          withSchema(() =>
            Promise.resolve({ value: new Decimal("1.5") })
          ).default("1.5")
        ).issues
      ).toEqual([
        {
          path: "default",
          message: "The decimal default did not satisfy its field schema",
        },
      ]);
    });

    it("turns hostile factory-list reads into validation issues", () => {
      const hostile = new Proxy(["1.5"], {
        get(target, property, receiver) {
          if (property === "0") throw new Error("member trap");
          return Reflect.get(target, property, receiver);
        },
      });
      const create = getScalarSchemas(
        decimal(domain())
          .array()
          .default(() => hostile)["~"].state
      ).create;

      expect(() => create["~standard"].validate(undefined)).not.toThrow();
      expect(create["~standard"].validate(undefined)).toHaveProperty("issues");
    });

    it("keeps null and a closure, which have no canonical spelling", () => {
      expect(
        decimal(domain()).nullable().default(null)["~"].state.default
      ).toBe(null);
      const closure = () => "1.5";
      expect(
        decimal(domain()).default(closure as never)["~"].state.default
      ).toBe(closure);
    });

    it("validates a factory default through the full field codec once", () => {
      const observed: unknown[] = [];
      const scalar = decimal(domain())
        .schema({
          "~standard": {
            version: 1,
            vendor: "decimal-descriptor-test",
            validate: (value: unknown) => {
              observed.push(value);
              return value instanceof Decimal
                ? { value }
                : { issues: [{ message: "Expected Decimal" }] };
            },
          },
        })
        .default(() => "1.50");
      const create = getScalarSchemas(scalar["~"].state).create;

      expect(create["~standard"].validate(undefined)).toEqual({ value: "1.5" });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBeInstanceOf(Decimal);
    });

    it("validates factory list members and nullable defaults through their field rules", () => {
      let memberRuns = 0;
      const probe = {
        "~standard": {
          version: 1 as const,
          vendor: "decimal-descriptor-test",
          validate: (value: unknown) => {
            memberRuns += 1;
            return value instanceof Decimal
              ? { value }
              : { issues: [{ message: "Expected Decimal" }] };
          },
        },
      };
      const list = decimal(domain())
        .schema(probe)
        .array()
        .nullable()
        .default(() => ["1.50", new Decimal("2")]);
      const nullable = decimal(domain())
        .schema(probe)
        .nullable()
        .default(() => null);

      expect(
        getScalarSchemas(list["~"].state).create["~standard"].validate(
          undefined
        )
      ).toEqual({ value: ["1.5", "2"] });
      expect(
        getScalarSchemas(nullable["~"].state).create["~standard"].validate(
          undefined
        )
      ).toEqual({ value: null });
      expect(memberRuns).toBe(2);
    });

    it("refuses invalid and throwing factory defaults as validation issues", () => {
      const outside = decimal(domain()).default(() => "100000000");
      const throwing = decimal(domain()).default(() => {
        throw new Error("default exploded");
      });

      expect(
        getScalarSchemas(outside["~"].state).create["~standard"].validate(
          undefined
        )
      ).toHaveProperty("issues");
      expect(
        getScalarSchemas(throwing["~"].state).create["~standard"].validate(
          undefined
        )
      ).toEqual({ issues: [{ message: "Default failed: default exploded" }] });
    });

    it.each([
      [
        "null on a non-null scalar",
        () => decimal(domain()).default(null as never),
      ],
      [
        "a scalar on a list",
        () =>
          decimal(domain())
            .array()
            .default("1.2" as never),
      ],
      ["a list on a scalar", () => decimal(domain()).default(["1.2"] as never)],
    ])("refuses %s at the definition boundary", (_name, build) => {
      expect(refusal(build).source).toMatchObject({
        kind: "schema-builder",
        builder: "s.decimal",
      });
    });

    it.each([
      ["a value outside the scale", () => decimal(domain()).default("1.005")],
      ["a value outside the precision", () => decimal(domain()).default("1e9")],
      [
        "a value that is not a decimal at all",
        () => decimal(domain()).default("abc" as never),
      ],
      [
        // The constructor builds no non-finite value, so a Decimal-typed value
        // fails here only when it was never constructed: this one wears the
        // prototype and carries decimal-shaped own properties with it.
        "a Decimal-shaped value the constructor never built",
        () =>
          decimal(domain()).default(
            Object.assign(Object.create(Decimal.prototype), {
              s: 1,
              e: 0,
            }) as never
          ),
      ],
    ])("refuses %s at the declaration", (_name, build) => {
      const error = refusal(build);
      expect(error.source).toEqual({
        kind: "schema-builder",
        builder: "s.decimal",
        path: "default",
      });
      expect(error.issues).toEqual([
        {
          path: "default",
          message: "The decimal default did not satisfy its field schema",
        },
      ]);
    });

    it("stores the canonical spelling a literal default names", () => {
      expect(decimal(domain()).default("+001.20")["~"].state.default).toBe(
        "1.2"
      );
      expect(
        decimal(domain()).array().default(["+001.20", "-0"])["~"].state.default
      ).toEqual(["1.2", "0"]);
    });
  });
});

describe("coverage low value", () => {
  it("contains a throwing literal-list member read", () => {
    const hostileList = new Proxy(["1.5"], {
      get(target, property, receiver) {
        if (property === "0") throw new Error("member read failed");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => decimal(domain()).array().default(hostileList)).toThrowError(
      ValidationError
    );
  });
});
