import { ValidationError, VibORMErrorCode } from "@errors";
import { decimal } from "@schema/scalars";
import { normalizeDecimalDefault } from "@schema/scalars/decimal/descriptor";
import { getScalarSchemas } from "@validation/scalars";
import Decimal from "decimal.js";
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
    ["a missing descriptor", () => (decimal as any)()],
    ["a null descriptor", () => (decimal as any)(null)],
    ["a number descriptor", () => (decimal as any)(5)],
    ["an array descriptor", () => (decimal as any)([10, 2])],
    ["a missing precision", () => (decimal as any)({ scale: 2 })],
    ["a missing scale", () => (decimal as any)({ precision: 10 })],
    [
      "an explicit undefined precision",
      () => (decimal as any)({ precision: undefined, scale: 2 }),
    ],
    [
      "an inherited-only descriptor",
      () => (decimal as any)(Object.create({ precision: 10, scale: 2 })),
    ],
    [
      "a string precision",
      () => (decimal as any)({ precision: "10", scale: 2 }),
    ],
    [
      "a fractional precision",
      () => (decimal as any)({ precision: 10.5, scale: 2 }),
    ],
    [
      "a NaN scale",
      () => (decimal as any)({ precision: 10, scale: Number.NaN }),
    ],
    [
      "an infinite precision",
      () => (decimal as any)({ precision: Number.POSITIVE_INFINITY, scale: 2 }),
    ],
    [
      "a negative-zero scale",
      () => (decimal as any)({ precision: 10, scale: -0 }),
    ],
    ["a zero precision", () => (decimal as any)({ precision: 0, scale: 0 })],
    [
      "a negative precision",
      () => (decimal as any)({ precision: -1, scale: 0 }),
    ],
    ["a negative scale", () => (decimal as any)({ precision: 10, scale: -1 })],
    [
      "a precision beyond the safe integers",
      () => (decimal as any)({ precision: 2 ** 53, scale: 0 }),
    ],
    [
      "a scale greater than precision",
      () => (decimal as any)({ precision: 4, scale: 5 }),
    ],
    [
      "an unknown key beside the real ones",
      () =>
        (decimal as any)({ precision: 10, scale: 2, rounding: "half-even" }),
    ],
    [
      "a misspelling beside the real ones",
      () => (decimal as any)({ precision: 10, scale: 2, scal: 2 }),
    ],
  ])("refuses %s at the declaration", (_name, build) => {
    const error = refusal(build);
    expect(error.source).toMatchObject({
      kind: "schema-builder",
      builder: "s.decimal",
    });
    expect(error.code).toBe(VibORMErrorCode.INVALID_INPUT);
  });

  it.each([
    ["an Error", () => new Error("accessor exploded")],
    ["a non-Error value", () => ({ secret: "accessor exploded" })],
  ])("owns a throwing accessor that threw %s, without rendering it", (_name, makeThrown) => {
    const error = refusal(() =>
      (decimal as any)({
        get precision(): number {
          throw makeThrown();
        },
        scale: 2,
      })
    );
    expect(error.issues[0]?.message).toBe(
      "Could not read 'precision' from the decimal descriptor"
    );
    // Whatever was thrown is normalized into an Error and carried as the
    // cause; the refusal sentence never coerces a caller value into itself.
    expect(error.originalCause).toBeInstanceOf(Error);
    expect(error.issues[0]?.message).not.toContain("accessor exploded");
  });

  it("contains an Error proxy whose prototype inspection throws", () => {
    const hostileError = new Proxy(new Error("private accessor failure"), {
      getPrototypeOf() {
        throw new Error("private prototype trap");
      },
    });
    const error = refusal(() =>
      (decimal as any)({
        get precision(): number {
          throw hostileError;
        },
        scale: 2,
      })
    );
    expect(error.issues[0]?.message).toBe(
      "Could not read 'precision' from the decimal descriptor"
    );
    expect(error.originalCause).toBeInstanceOf(Error);
    expect(error.issues[0]?.message).not.toContain("private");
  });

  it("refuses a hostile presence trap exactly like a hostile accessor", () => {
    // `Object.hasOwn` shares the read's `try`, so a trap that throws from the
    // descriptor query cannot slip past the presence test.
    const error = refusal(() =>
      (decimal as any)(
        new Proxy(
          { precision: 10, scale: 2 },
          {
            getOwnPropertyDescriptor() {
              throw new Error("trap");
            },
          }
        )
      )
    );
    expect(error.issues[0]?.message).toContain("Could not read 'precision'");
  });

  it("refuses a hostile ownKeys trap while enumerating declarations", () => {
    const error = refusal(() =>
      (decimal as any)(
        new Proxy(
          { precision: 10, scale: 2 },
          {
            ownKeys() {
              throw new Error("keys trap");
            },
          }
        )
      )
    );
    expect(error.issues[0]?.message).toContain("Could not enumerate");
  });

  it("reads each property exactly once", () => {
    // A second read is what would let a value that passed validation be
    // swapped for one that did not before it is used.
    const reads: string[] = [];
    let precision = 10;
    const scalar = decimal({
      get precision() {
        reads.push("precision");
        const current = precision;
        precision = 2;
        return current;
      },
      get scale() {
        reads.push("scale");
        return 2;
      },
    } as { precision: number; scale: number });
    expect(reads).toEqual(["precision", "scale"]);
    expect(scalar["~"].state.decimal).toEqual({ precision: 10, scale: 2 });
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

  it("refuses a symbol-keyed own property, named by its description", () => {
    // An own property this domain has no name for is an undeclared intent
    // whatever key shape carries it — `Object.keys` semantics are not the rule,
    // OWN-ness is. The symbol is named by its own `description` string: a
    // template literal throws on a symbol and `String(symbol)` is a coercion,
    // and this module never coerces a caller's value into a refusal sentence.
    const marked: Record<string | symbol, unknown> = {
      precision: 10,
      scale: 2,
    };
    marked[Symbol.for("rounding")] = "half-up";
    expect(refusal(() => (decimal as any)(marked)).issues[0]?.message).toBe(
      "Symbol(rounding) is not a decimal descriptor property; a decimal declares { precision, scale }"
    );
  });

  it("refuses an anonymous symbol-keyed own property", () => {
    const marked: Record<string | symbol, unknown> = {
      precision: 10,
      scale: 2,
    };
    // biome-ignore lint/style/useSymbolDescription: a symbol with no description is the input under test
    marked[Symbol()] = 1;
    expect(refusal(() => (decimal as any)(marked)).issues[0]?.message).toBe(
      "Symbol() is not a decimal descriptor property; a decimal declares { precision, scale }"
    );
  });

  it("refuses a NON-ENUMERABLE own unknown property", () => {
    // Enumerability is presentation, not intent: an own key the domain has no
    // name for is unknown whether or not `Object.keys` would list it.
    const hidden = { precision: 10, scale: 2 };
    Object.defineProperty(hidden, "rounding", {
      value: "half-up",
      enumerable: false,
    });
    expect(refusal(() => (decimal as any)(hidden)).issues[0]?.message).toBe(
      "'rounding' is not a decimal descriptor property; a decimal declares { precision, scale }"
    );
  });

  it("owns a REVOKED-proxy descriptor as a refusal, not a raw TypeError", () => {
    // The shape test itself calls `Array.isArray`, which throws on a revoked
    // proxy — so it has to sit inside the same normalized boundary as the
    // reads, or a `TypeError` escapes `s.decimal()` past the one typed
    // validation surface.
    const { proxy, revoke } = Proxy.revocable({ precision: 10, scale: 2 }, {});
    revoke();
    const error = refusal(() => (decimal as any)(proxy));
    expect(error.issues[0]?.message).toBe(
      "Could not inspect the decimal descriptor"
    );
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  it("refuses a forged Decimal candidate as a default", () => {
    // The default is normalized through the field codec at definition time, so
    // a forgery that rendered as non-numeric text would be frozen into model
    // metadata and into every DDL default derived from it.
    expect(
      refusal(() =>
        decimal(domain()).default({
          toStringTag: "[object Decimal]",
          s: 1,
          e: 0,
          d: [Number.NaN],
        } as never)
      ).source
    ).toMatchObject({ kind: "schema-builder", builder: "s.decimal" });
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
      expect(decimal(domain()).default(-0)["~"].state.default).toBe("0");
      expect(
        decimal(domain()).default(new Decimal("1.5"))["~"].state.default
      ).toBe("1.5");
    });

    it("normalizes every member of a list default", () => {
      expect(
        decimal(domain()).array().default(["1.10", 2])["~"].state.default
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

    it("snapshots a dense list without calling caller array methods", () => {
      let mapCalls = 0;
      const shadowed = ["1.10"];
      Object.defineProperty(shadowed, "map", {
        value: () => {
          mapCalls += 1;
          throw new Error("caller map ran");
        },
      });

      expect(() => decimal(domain()).array().default(shadowed)).toThrowError(
        ValidationError
      );
      expect(mapCalls).toBe(0);
    });

    it("owns a list-snapshot failure whose thrown value refuses prototype inspection", () => {
      let ownKeysCalls = 0;
      const hostileThrown = new Proxy(
        {},
        {
          getPrototypeOf(): object {
            throw new Error("prototype trap");
          },
        }
      );
      const hostileDefault = new Proxy(["1.10"], {
        ownKeys(): never {
          ownKeysCalls += 1;
          throw hostileThrown;
        },
      });

      const error = refusal(() =>
        decimal(domain()).array().default(hostileDefault)
      );

      expect(error.source).toEqual({
        kind: "schema-builder",
        builder: "s.decimal",
        path: "default",
      });
      expect(error.issues).toEqual([
        {
          path: "default",
          message: "Could not snapshot the decimal list default",
        },
      ]);
      expect(error.originalCause).toBeInstanceOf(Error);
      expect(error.originalCause?.message).toBe(
        "Underlying error details redacted"
      );
      expect(ownKeysCalls).toBe(1);
    });

    it("refuses revoked and sparse list defaults through the builder boundary", () => {
      const revoked = Proxy.revocable(["1.10"], {});
      revoked.revoke();
      expect(() =>
        decimal(domain()).array().default(revoked.proxy)
      ).toThrowError(ValidationError);

      const sparse = new Array<string>(1);
      expect(() => decimal(domain()).array().default(sparse)).toThrowError(
        ValidationError
      );

      const offsetHole = new Array<string>(1);
      Object.defineProperty(offsetHole, "shadow", { value: "1.5" });
      expect(() => decimal(domain()).array().default(offsetHole)).toThrowError(
        ValidationError
      );
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

    it("owns throwing, null, and async custom-schema results for literals", () => {
      const validators: readonly ((value: unknown) => unknown)[] = [
        () => {
          throw new Error("custom exploded");
        },
        () => null,
        () => Promise.resolve({ value: new Decimal("1.5") }),
      ];

      for (const validate of validators) {
        expect(() =>
          decimal(domain())
            .schema({
              "~standard": {
                version: 1,
                vendor: "decimal-descriptor-test",
                validate,
              },
            } as never)
            .default("1.5")
        ).toThrowError(ValidationError);
      }
    });

    it("owns a custom-schema failure whose thrown value refuses prototype inspection", () => {
      let validationCalls = 0;
      const hostileThrown = new Proxy(
        {},
        {
          getPrototypeOf(): object {
            throw new Error("prototype trap");
          },
        }
      );

      const error = refusal(() =>
        decimal(domain())
          .schema({
            "~standard": {
              version: 1,
              vendor: "decimal-descriptor-test",
              validate: (): never => {
                validationCalls += 1;
                throw hostileThrown;
              },
            },
          })
          .default("1.5")
      );

      expect(error.source).toEqual({
        kind: "schema-builder",
        builder: "s.decimal",
        path: "default",
      });
      expect(error.issues).toEqual([
        {
          path: "default",
          message:
            "The decimal field schema failed while validating its default",
        },
      ]);
      expect(error.originalCause).toBeInstanceOf(Error);
      expect(error.originalCause?.message).toBe(
        "Underlying error details redacted"
      );
      expect(validationCalls).toBe(1);
    });

    it("owns malformed direct field-schema results at the default boundary", () => {
      const schemas = [
        { "~standard": { validate: () => null } },
        {
          "~standard": {
            validate: () => ({
              then: () => undefined,
              value: new Decimal("1.5"),
            }),
          },
        },
        { "~standard": { validate: () => ({}) } },
      ];

      for (const schema of schemas) {
        expect(() =>
          normalizeDecimalDefault("1.5", schema as never, false)
        ).toThrowError(ValidationError);
      }
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
        "a non-finite Decimal",
        () =>
          decimal(domain()).default(
            new Decimal(Number.POSITIVE_INFINITY) as never
          ),
      ],
    ])("refuses %s at the declaration", (_name, build) => {
      expect(refusal(build).source).toMatchObject({
        kind: "schema-builder",
        builder: "s.decimal",
      });
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

  it("contains every hostile Standard Schema result probe", () => {
    const revoked = Proxy.revocable({ value: new Decimal("1.5") }, {});
    revoked.revoke();
    const hostileResults: readonly unknown[] = [
      revoked.proxy,
      new Proxy(
        { value: new Decimal("1.5") },
        {
          get(target, property, receiver) {
            if (property === "then") throw new Error("then read failed");
            return Reflect.get(target, property, receiver);
          },
        }
      ),
      new Proxy(
        { value: new Decimal("1.5") },
        {
          get(target, property, receiver) {
            if (property === "issues") throw new Error("issues read failed");
            return Reflect.get(target, property, receiver);
          },
        }
      ),
      new Proxy(
        { value: new Decimal("1.5") },
        {
          has(target, property) {
            if (property === "value") throw new Error("value probe failed");
            return Reflect.has(target, property);
          },
        }
      ),
      new Proxy(
        { value: new Decimal("1.5") },
        {
          get(target, property, receiver) {
            if (property === "value") throw new Error("value read failed");
            return Reflect.get(target, property, receiver);
          },
        }
      ),
    ];

    for (const hostileResult of hostileResults) {
      const schema = {
        "~standard": {
          validate: () => hostileResult,
        },
      };

      expect(() =>
        normalizeDecimalDefault("1.5", schema as never, false)
      ).toThrowError(ValidationError);
    }
  });
});
