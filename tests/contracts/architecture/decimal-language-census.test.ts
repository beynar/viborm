import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterWideDecimalRefusalEntries,
  censusFiles,
  collectDecimalLanguageCensus,
  DECIMAL_FLOAT_TRANSPORT_EXEMPTIONS,
  DECIMAL_OPERATION_KEYS,
  decimalFloatTransportEntries,
  ormOwnedDecimalWrapperEntries,
  partialDecimalOperationBagEntries,
  publicDecimalResultModeEntries,
  REJECTED_DECIMAL_FLOAT_TRANSPORT_TOKENS,
  REJECTED_DECIMAL_MODE_MEMBERS,
  REJECTED_DECIMAL_REFUSAL_NAMES,
  REJECTED_DECIMAL_RESULT_MEMBERS,
  REJECTED_DECIMAL_WRAPPER_NAMES,
  secondDecimalModeEntries,
} from "@tests/fixtures/decimal-language-census";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { describe, expect, it } from "vitest";

/**
 * Absence is useful only when each detector is proven capable of becoming red.
 * Every zero assertion therefore has independent witnesses for its retired
 * vocabulary and its admitted structural publication shapes. This is a source
 * census, not whole-program semantic or dataflow proof. The vocabulary and
 * exemption lists below are spelled independently of the fixture: a
 * misspelling in a detector and a witness generated from that same misspelling
 * would otherwise agree while guarding nothing.
 *
 * This is intentionally a non-`.core` contract. It spawns `git` to enumerate
 * the publication estate and belongs to `extended-local` under `pnpm test:all`.
 */

const census = collectDecimalLanguageCensus(REPOSITORY_ROOT);
const VALIDATED_DEFAULT_ASSIGNMENT =
  /function withValidatedDecimalDefault(?:(?!^}).)*default: value,/ms;
const DUPLICATE_DEFAULT_VALIDATION =
  /function withValidatedDecimalDefault(?:(?!^}).)*(?:normalizeDecimalDefault|~standard)/ms;

describe("decimal default validation ownership", () => {
  it("passes the schema-document base verdict to the scalar without a second codec pass", () => {
    const interpreter = readFileSync(
      join(REPOSITORY_ROOT, "src/schema/json/interpret.ts"),
      "utf8"
    );
    const scalar = readFileSync(
      join(REPOSITORY_ROOT, "src/schema/scalars/decimal/scalar.ts"),
      "utf8"
    );

    expect(interpreter).toContain(
      "return withValidatedDecimalDefault(scalar, verdict.value);"
    );
    expect(scalar).toMatch(VALIDATED_DEFAULT_ASSIGNMENT);
    expect(scalar).not.toMatch(DUPLICATE_DEFAULT_VALIDATION);
  });
});

const REJECTED_MODE_SPELLINGS = [
  "fixed",
  "fixedDecimal",
  "decimalMode",
  "native",
  "nativeDecimal",
  "nativeType",
  "unconstrained",
  "unconstrainedDecimal",
];

const FLOAT_TRANSPORT_EXEMPTION_SPELLINGS = [
  "src/migrations/decimal.ts readStoredDecimalInteger Number(value)",
  "src/validation/primitives/decimal-codec.ts expandExponentForm Number(exponentText)",
  // An SRID is a spatial reference IDENTIFIER (4326 and friends), an unsigned
  // 32-bit integer, not a quantity: readSrid bounds it with Number.isSafeInteger
  // to 0..4294967295 and refuses anything else rather than publishing an
  // unprovable spatial type. No decimal value transits it. The census flags it
  // only because the same module also renders DECIMAL columns, and the detector
  // is deliberately aggressive about mixed-purpose modules. Exempted by exact
  // spelling, so any OTHER Number() in that file still fails.
  "src/migrations/drivers/mysql/introspect.ts readSrid Number(col.SRS_ID)",
];

const REJECTED_FLOAT_TRANSPORT_SPELLINGS = [
  "Number",
  "Number.parseFloat",
  "numberType",
  "parseFloat",
  "unaryPlus",
];

const REJECTED_RESULT_SPELLINGS = [
  "decimalDecode",
  "decimalResult",
  "decimalResultMode",
];

const REJECTED_WRAPPER_SPELLINGS = [
  "DecimalManager",
  "DecimalValue",
  "DecimalWrapper",
  "VibDecimal",
];

const DECIMAL_OPERATION_SPELLINGS = [
  "set",
  "increment",
  "decrement",
  "multiply",
  "divide",
  "push",
  "unshift",
];

const REJECTED_REFUSAL_SPELLINGS = [
  "assertExactDecimal*",
  "decimal-portability",
  "supportsExactDecimal",
];

describe("decimal-language census: detector vocabulary", () => {
  it("pins each ban list independently", () => {
    expect([...REJECTED_DECIMAL_MODE_MEMBERS].sort()).toEqual(
      [...REJECTED_MODE_SPELLINGS].sort()
    );
    expect([...DECIMAL_FLOAT_TRANSPORT_EXEMPTIONS].sort()).toEqual(
      [...FLOAT_TRANSPORT_EXEMPTION_SPELLINGS].sort()
    );
    expect([...REJECTED_DECIMAL_FLOAT_TRANSPORT_TOKENS].sort()).toEqual(
      [...REJECTED_FLOAT_TRANSPORT_SPELLINGS].sort()
    );
    expect([...REJECTED_DECIMAL_RESULT_MEMBERS].sort()).toEqual(
      [...REJECTED_RESULT_SPELLINGS].sort()
    );
    expect([...REJECTED_DECIMAL_WRAPPER_NAMES].sort()).toEqual(
      [...REJECTED_WRAPPER_SPELLINGS].sort()
    );
    expect([...DECIMAL_OPERATION_KEYS].sort()).toEqual(
      [...DECIMAL_OPERATION_SPELLINGS].sort()
    );
    expect([...REJECTED_DECIMAL_REFUSAL_NAMES].sort()).toEqual(
      [...REJECTED_REFUSAL_SPELLINGS].sort()
    );
  });
});

describe("decimal-language census: estate enumeration", () => {
  it("includes untracked source and excludes prose, tests, and deletions", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "viborm-dec-census-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
      execFileSync("git", ["config", "user.email", "census@example.test"], {
        cwd: repositoryRoot,
      });
      execFileSync("git", ["config", "user.name", "census"], {
        cwd: repositoryRoot,
      });
      execFileSync("mkdir", ["-p", join(repositoryRoot, "src", "schema")]);
      execFileSync("mkdir", ["-p", join(repositoryRoot, "tests")]);
      writeFileSync(join(repositoryRoot, "src", "tracked.ts"), "export {};\n");
      writeFileSync(join(repositoryRoot, "src", "deleted.ts"), "export {};\n");
      writeFileSync(join(repositoryRoot, "src", "AGENTS.md"), "prose\n");
      writeFileSync(
        join(repositoryRoot, "tests", "outside.ts"),
        "export {};\n"
      );
      execFileSync(
        "git",
        [
          "add",
          "src/tracked.ts",
          "src/deleted.ts",
          "src/AGENTS.md",
          "tests/outside.ts",
        ],
        { cwd: repositoryRoot }
      );
      unlinkSync(join(repositoryRoot, "src", "deleted.ts"));
      writeFileSync(
        join(repositoryRoot, "src", "schema", "untracked.ts"),
        "export {};\n"
      );

      expect(censusFiles(repositoryRoot)).toEqual([
        "src/schema/untracked.ts",
        "src/tracked.ts",
      ]);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});

describe("decimal-language census: one declaration mode", () => {
  it("finds no zero-argument, native, fixed, or unconstrained mode", () => {
    expect(census.secondDecimalMode).toEqual([]);
  });

  it("requires the descriptor and public factory owners to remain manifest", () => {
    expect(
      secondDecimalModeEntries("src/validation/primitives/decimal-codec.ts", "")
    ).toEqual([
      "src/validation/primitives/decimal-codec.ts descriptor:declarationCount 1",
    ]);
    expect(
      secondDecimalModeEntries("src/schema/scalars/decimal/scalar.ts", "")
    ).toEqual([
      "src/schema/scalars/decimal/scalar.ts factoryDeclarationCount 1",
    ]);
  });

  it("detects an extra real member and a renamed second descriptor", () => {
    const witness = `export interface DecimalDescriptor {
  readonly precision: number;
  readonly scale: number;
  readonly rounding: "half-even";
}
interface MoneyDomain {
  precision: number;
  scale: number;
}
`;
    expect(
      secondDecimalModeEntries(
        "src/validation/primitives/decimal-codec.ts",
        witness
      )
    ).toEqual([
      "src/validation/primitives/decimal-codec.ts descriptor:member:rounding 1",
      "src/validation/primitives/decimal-codec.ts secondDescriptor:MoneyDomain 1",
    ]);
  });

  it("detects a second descriptor in a mixed-purpose codec consumer", () => {
    const witness = `import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
interface AdapterDecimalDomain {
  precision: number;
  scale: number;
  provider: "mysql";
}
`;
    expect(
      secondDecimalModeEntries("src/adapters/database-adapter.ts", witness)
    ).toEqual([
      "src/adapters/database-adapter.ts secondDescriptor:AdapterDecimalDomain 1",
    ]);
  });

  it("detects a differently named exported decimal factory", () => {
    const witness = `import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
export function money(descriptor: DecimalDescriptor) {
  return { scalarType: "decimal", descriptor };
}
`;
    expect(
      secondDecimalModeEntries("src/schema/scalars/decimal/money.ts", witness)
    ).toEqual(["src/schema/scalars/decimal/money.ts secondFactory:money 1"]);
  });

  it("detects descriptorless decimal scalar state outside public regions", () => {
    const witness = `export type ScalarType = "string" | "decimal";
interface NumericScalarConfig {
  scalarType: ScalarType;
}
`;
    expect(
      secondDecimalModeEntries("src/schema/scalars/legacy-types.ts", witness)
    ).toEqual([
      "src/schema/scalars/legacy-types.ts descriptorlessDecimalConfig:NumericScalarConfig 1",
      "src/schema/scalars/legacy-types.ts secondScalarTypeDeclaration 1",
    ]);
  });

  it("detects rejected mode exports from each shipped public entry", () => {
    for (const file of ["src/index.ts", "src/schema/exports.ts"] as const) {
      const witness = `export { decimal as fixedDecimal } from "./decimal";
export { decimal as nativeDecimal } from "./decimal";
`;
      expect(secondDecimalModeEntries(file, witness)).toEqual([
        `${file} export:fixedDecimal 1`,
        `${file} export:nativeDecimal 1`,
      ]);
    }
  });

  it("detects every decimal binding export from each shipped public entry", () => {
    for (const file of ["src/index.ts", "src/schema/exports.ts"] as const) {
      const witness = `export { decimal as money } from "./decimal";
export { decimal } from "./decimal";
`;
      expect(secondDecimalModeEntries(file, witness)).toEqual([
        `${file} export:decimal 1`,
        `${file} export:money 1`,
      ]);
    }
  });

  it("pins the one decimal binding on the public s initializer", () => {
    expect(secondDecimalModeEntries("src/schema/index.ts", "")).toEqual([
      "src/schema/index.ts publicBuilder:decimalBindingCount 1",
    ]);
    const witness = `import { decimal } from "./scalars";
export const s = { decimal, money: decimal };
`;
    expect(secondDecimalModeEntries("src/schema/index.ts", witness)).toEqual([
      "src/schema/index.ts publicBuilder:binding:money 1",
    ]);
  });

  it("allows type-only Decimal exports from each shipped public entry", () => {
    const rootWitness = `export { default as Decimal } from "decimal.js";
export type { DecimalScalar } from "./schema/scalars";
`;
    expect(secondDecimalModeEntries("src/index.ts", rootWitness)).toEqual([]);
    expect(ormOwnedDecimalWrapperEntries("src/index.ts", rootWitness)).toEqual(
      []
    );

    const schemaWitness = `export type { Decimal, DecimalScalar } from "./scalars";
`;
    expect(
      secondDecimalModeEntries("src/schema/exports.ts", schemaWitness)
    ).toEqual([]);
    expect(
      ormOwnedDecimalWrapperEntries("src/schema/exports.ts", schemaWitness)
    ).toEqual([]);
  });

  it("detects a weakened exact-key surface, factory arity, and fluent modes", () => {
    const witness = `type LooseDomain<Given> = Given &
  Record<Exclude<keyof Given, keyof DecimalDescriptor | "mode">, never>;
export const decimal = <const D extends DecimalDescriptor>(
  descriptor?: LooseDomain<D>,
  nativeType?: NativeType
) => ({
  fixed() {},
  fixedDecimal: () => undefined,
  nativeType(value: string) {},
});
decimal({ precision: 10, scale: 2 }).fixed();
// A zero-argument decimal and .fixed() are rejected concepts, not live modes.
`;
    expect(
      secondDecimalModeEntries("src/schema/scalars/decimal/scalar.ts", witness)
    ).toEqual([
      "src/schema/scalars/decimal/scalar.ts call:fixed 1",
      "src/schema/scalars/decimal/scalar.ts factoryArity 1",
      "src/schema/scalars/decimal/scalar.ts factoryExactKeySurface 1",
      "src/schema/scalars/decimal/scalar.ts factoryOptionality 1",
      "src/schema/scalars/decimal/scalar.ts member:fixed 1",
      "src/schema/scalars/decimal/scalar.ts member:fixedDecimal 1",
      "src/schema/scalars/decimal/scalar.ts member:nativeType 1",
      "src/schema/scalars/decimal/scalar.ts nativeFactoryParameter 1",
      "src/schema/scalars/decimal/scalar.ts nonDescriptorFactoryParameter 1",
    ]);
  });
});

describe("decimal-language census: no floating transport", () => {
  it("finds no decimal transport through JavaScript number", () => {
    expect(census.floatTransport).toEqual([]);
  });

  it("detects every coercion spelling inside a lexical decimal arm", () => {
    const witness = `import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
if (scalar.type === "decimal") {
  const amount: number = Number(providerValue);
  const ratio = Number.parseFloat(providerValue);
  const rounded = parseFloat(providerValue);
  const recovered = +providerValue;
}
// Number(providerValue) is rejected prose here, not another call.
`;
    expect(
      decimalFloatTransportEntries(
        "src/query-engine/builders/values-builder.ts",
        witness
      )
    ).toEqual([
      "src/query-engine/builders/values-builder.ts Number 1",
      "src/query-engine/builders/values-builder.ts Number.parseFloat 1",
      "src/query-engine/builders/values-builder.ts numberType 1",
      "src/query-engine/builders/values-builder.ts parseFloat 1",
      "src/query-engine/builders/values-builder.ts unaryPlus 1",
    ]);
  });

  it("does not claim dataflow through an unrelated numeric module", () => {
    expect(
      decimalFloatTransportEntries(
        "src/shared/numeric-parser.ts",
        "const amount = Number(providerValue);"
      )
    ).toEqual([]);
  });

  it("detects Number transport in a mixed-purpose codec consumer", () => {
    const witness = `import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
function decodeProviderValue(value: string) {
  return Number(value);
}
`;
    expect(
      decimalFloatTransportEntries(
        "src/query-engine/builders/values-builder.ts",
        witness
      )
    ).toEqual(["src/query-engine/builders/values-builder.ts Number 1"]);
  });

  it("exempts only the central exponent and stored-descriptor readers", () => {
    expect(
      decimalFloatTransportEntries(
        "src/validation/primitives/decimal-codec.ts",
        `function expandExponentForm(text: string) {
  const exponentText = text.split("e")[1];
  return Number(exponentText);
}`
      )
    ).toEqual([]);
    expect(
      decimalFloatTransportEntries(
        "src/migrations/decimal.ts",
        `function readStoredDecimalInteger(value: unknown) {
  return Number(value);
}`
      )
    ).toEqual([]);
    expect(
      decimalFloatTransportEntries(
        "src/validation/primitives/decimal-codec.ts",
        `function expandExponentForm(exponentText: string) {
  const exponent = Number(exponentText);
  return exponent + Number(exponentText);
}`
      )
    ).toEqual(["src/validation/primitives/decimal-codec.ts Number 1"]);
  });
});

describe("decimal-language census: one public Decimal result", () => {
  it("finds no public string or number result mode", () => {
    expect(census.publicResultMode).toEqual([]);
  });

  it("detects the retired decode thread and client configuration", () => {
    const witness = `interface ClientConfig {
  decimal: "string" | "number";
  decimalDecode?: "string" | "number";
}
const decimalDecode = "string";
const client = createClient({ decimal: "number", decimalResultMode: "string" });
// decimalDecode was retired with the public string result mode.
`;
    expect(
      publicDecimalResultModeEntries("src/client/decimal-witness.ts", witness)
    ).toEqual([
      "src/client/decimal-witness.ts decimalConfig:number 1",
      "src/client/decimal-witness.ts decimalConfigType 2",
      "src/client/decimal-witness.ts decimalDecode 2",
      "src/client/decimal-witness.ts decimalResultMode 1",
    ]);
  });

  it("detects a renamed string or number Decimal output configuration", () => {
    const witness = `interface DecimalOutputConfig {
  output: "string" | "number";
}
`;
    expect(
      publicDecimalResultModeEntries("src/client/decimal-output.ts", witness)
    ).toEqual(["src/client/decimal-output.ts decimalResultConfig:output 1"]);
  });
});

describe("decimal-language census: no ORM-owned wrapper", () => {
  it("finds no second Decimal constructor, class, wrapper, or re-export owner", () => {
    expect(census.ormOwnedWrapper).toEqual([]);
  });

  it("detects a runtime Decimal.clone second constructor", () => {
    const witness = `import Decimal from "decimal.js";
const Exact = Decimal.clone({ defaults: true });
`;
    expect(
      ormOwnedDecimalWrapperEntries(
        "src/validation/primitives/decimal-codec.ts",
        witness
      )
    ).toEqual([
      "src/validation/primitives/decimal-codec.ts decimalCloneCall 1",
    ]);
  });

  it("detects a second constructor through a renamed Decimal import", () => {
    const witness = `import ExactDecimal from "decimal.js";
const Exact = ExactDecimal.clone({ defaults: true });
`;
    expect(
      ormOwnedDecimalWrapperEntries(
        "src/validation/primitives/decimal-codec.ts",
        witness
      )
    ).toEqual([
      "src/validation/primitives/decimal-codec.ts decimalCloneCall 1",
    ]);
  });

  it("requires exactly the root Decimal constructor export", () => {
    expect(ormOwnedDecimalWrapperEntries("src/index.ts", "")).toEqual([
      "src/index.ts decimalConstructorExportCount 1",
    ]);
    expect(
      ormOwnedDecimalWrapperEntries(
        "src/index.ts",
        'export { default as Decimal } from "decimal.js";'
      )
    ).toEqual([]);
    expect(
      ormOwnedDecimalWrapperEntries(
        "src/index.ts",
        'export { default as Decimal, default as Money } from "decimal.js";'
      )
    ).toEqual(["src/index.ts decimalConstructorExportSpelling 1"]);
  });

  it("detects declarations and a decimal.js re-export outside the root", () => {
    const witness = `import DecimalRuntime from "decimal.js";
class Decimal {}
interface DecimalWrapper {}
type DecimalValue = string;
const VibDecimal = class {};
export { default as Decimal } from "decimal.js";
// class DecimalManager would be a second ORM-owned wrapper.
`;
    expect(
      ormOwnedDecimalWrapperEntries("src/client/decimal-wrapper.ts", witness)
    ).toEqual([
      "src/client/decimal-wrapper.ts decimalConstructorExport 1",
      "src/client/decimal-wrapper.ts decimalRuntimeImport 1",
      "src/client/decimal-wrapper.ts declaration:Decimal 1",
      "src/client/decimal-wrapper.ts declaration:DecimalValue 1",
      "src/client/decimal-wrapper.ts declaration:DecimalWrapper 1",
      "src/client/decimal-wrapper.ts declaration:VibDecimal 1",
    ]);
  });

  it("detects constructor re-exports hidden behind another public name", () => {
    const witness = `export { default as Money } from "decimal.js";
export { Decimal as Exact } from "./values";
`;
    expect(
      ormOwnedDecimalWrapperEntries("src/client/money.ts", witness)
    ).toEqual(["src/client/money.ts decimalConstructorExport 2"]);
  });

  it("does not treat type-only decimal.js exports as a constructor", () => {
    const witness = `export type { default as DecimalType, Decimal as ExactDecimalType } from "decimal.js";
export { type Decimal as ExactType } from "./values";
`;
    expect(
      ormOwnedDecimalWrapperEntries("src/client/decimal-types.ts", witness)
    ).toEqual([]);
  });

  it("detects a renamed class that owns a Decimal.js value", () => {
    const witness = `import type Decimal from "decimal.js";
export class Money {
  constructor(readonly value: Decimal) {}
}
`;
    expect(
      ormOwnedDecimalWrapperEntries("src/client/decimal-money.ts", witness)
    ).toEqual(["src/client/decimal-money.ts decimalValueCarrier:Money 1"]);
  });

  it("detects a renamed class that owns an array of Decimal.js values", () => {
    const witness = `import type { Decimal as ExactDecimal } from "decimal.js";
export class MoneyLedger {
  readonly values: ExactDecimal[] = [];
}
`;
    expect(
      ormOwnedDecimalWrapperEntries("src/client/money-ledger.ts", witness)
    ).toEqual(["src/client/money-ledger.ts decimalValueCarrier:MoneyLedger 1"]);
  });

  it("detects a renamed class that owns a ReadonlyArray of Decimal.js values", () => {
    const witness = `import type { default as ExactDecimal } from "decimal.js";
export class MoneyLedger {
  readonly values: ReadonlyArray<ExactDecimal> = [];
}
`;
    expect(
      ormOwnedDecimalWrapperEntries("src/client/money-ledger.ts", witness)
    ).toEqual(["src/client/money-ledger.ts decimalValueCarrier:MoneyLedger 1"]);
  });

  it("detects a renamed class whose parameter property owns Decimal.js values", () => {
    const witness = `import type { Decimal as ExactDecimal } from "decimal.js";
export class MoneyLedger {
  constructor(readonly values: readonly [ExactDecimal]) {}
}
`;
    expect(
      ormOwnedDecimalWrapperEntries("src/client/money-ledger.ts", witness)
    ).toEqual(["src/client/money-ledger.ts decimalValueCarrier:MoneyLedger 1"]);
  });
});

describe("decimal-language census: exact-one operation bags", () => {
  it("finds no partial decimal operation bag", () => {
    expect(census.partialOperationBag).toEqual([]);
  });

  it("detects a renamed partial bag in the decimal schema owner", () => {
    const witness = `
interface MoneyMutation<S, O> {
  set?: S;
  increment: O;
}
type Bag<S, O> = Partial<MoneyMutation<S, O>>;
const schema = v.partialObject({});
const operationBag = v.object({ set: value, increment: value });
// Partial<MoneyMutation<S, O>> is rejected prose here.
`;
    expect(
      partialDecimalOperationBagEntries(
        "src/validation/scalars/decimal.ts",
        witness
      )
    ).toEqual([
      "src/validation/scalars/decimal.ts Partial 1",
      "src/validation/scalars/decimal.ts builder:operationBag 1",
      "src/validation/scalars/decimal.ts builder:partialObject 1",
      "src/validation/scalars/decimal.ts optional:set 1",
    ]);
  });

  it("leaves an unrelated partial operation bag outside the decimal census", () => {
    const witness = `interface MoneyMutation<S> { set?: S }
type Bag<S> = Partial<MoneyMutation<S>>;
const schema = v.partialObject({});
`;
    expect(
      partialDecimalOperationBagEntries(
        "src/query-engine/builders/set-builder.ts",
        witness
      )
    ).toEqual([]);
  });

  it("detects a partial bag in a mixed module that imports the decimal codec", () => {
    const witness = `import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
interface MoneyMutation<S> { set?: S; increment: S }
type Bag<S> = Partial<MoneyMutation<S>>;
const schema = v.partialObject({});
`;
    expect(
      partialDecimalOperationBagEntries(
        "src/query-engine/builders/set-builder.ts",
        witness
      )
    ).toEqual([
      "src/query-engine/builders/set-builder.ts Partial 1",
      "src/query-engine/builders/set-builder.ts builder:partialObject 1",
      "src/query-engine/builders/set-builder.ts optional:set 1",
    ]);
  });

  it("detects a partial bag moved into a decimal region or declaration", () => {
    const namedWitness = `interface DecimalMutation<S> {
  set?: S;
  increment: S;
}
interface MoneyMutation<S> {
  push?: S;
}
type Bag<S> = Partial<DecimalMutation<S>>;
`;
    expect(
      partialDecimalOperationBagEntries(
        "src/query-engine/builders/set-builder.ts",
        namedWitness
      )
    ).toEqual([
      "src/query-engine/builders/set-builder.ts Partial 1",
      "src/query-engine/builders/set-builder.ts optional:set 1",
    ]);

    const regionalWitness = `interface MoneyMutation<S> {
  set?: S;
  increment: S;
}
type Bag<S> = Partial<MoneyMutation<S>>;
`;
    expect(
      partialDecimalOperationBagEntries(
        "src/query-engine/builders/decimal-update.ts",
        regionalWitness
      )
    ).toEqual([
      "src/query-engine/builders/decimal-update.ts Partial 1",
      "src/query-engine/builders/decimal-update.ts optional:set 1",
    ]);
  });

  it("detects an optional mapped decimal operation bag", () => {
    const witness = `type DecimalUpdate = {
  [K in "set" | "increment"]?: string;
};
`;
    expect(
      partialDecimalOperationBagEntries(
        "src/validation/scalars/decimal.ts",
        witness
      )
    ).toEqual([
      "src/validation/scalars/decimal.ts mappedOptionalOperationBag 1",
    ]);
  });
});

describe("decimal-language census: no adapter-wide refusal", () => {
  it("finds no capability flag, portability helper, or assertion ladder", () => {
    expect(census.adapterWideRefusal).toEqual([]);
  });

  it("detects every retired refusal family", () => {
    const witness = `import { assertExactDecimalOperation } from "./decimal-portability";
const supported = capabilities.supportsExactDecimal;
assertExactDecimalOperation("orderBy");
assertExactDecimalRelationKey("join");
// supportsExactDecimal and decimal-portability are retired concepts.
`;
    expect(
      adapterWideDecimalRefusalEntries(
        "src/query-engine/builders/decimal-witness.ts",
        witness
      )
    ).toEqual([
      "src/query-engine/builders/decimal-witness.ts assertExactDecimal* 2",
      "src/query-engine/builders/decimal-witness.ts decimal-portability 1",
      "src/query-engine/builders/decimal-witness.ts supportsExactDecimal 1",
    ]);
  });

  it("detects a renamed adapter-wide Decimal capability", () => {
    const witness = `interface Capabilities {
  exactDecimal: boolean;
}
function ensureDecimalSupported() {
  if (!capabilities.exactDecimal) throw new Error("unsupported");
}
`;
    expect(
      adapterWideDecimalRefusalEntries(
        "src/adapters/database-adapter.ts",
        witness
      )
    ).toEqual([
      "src/adapters/database-adapter.ts decimalCapability:exactDecimal 1",
    ]);
  });
});
