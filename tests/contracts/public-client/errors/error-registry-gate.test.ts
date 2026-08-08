/**
 * The errors-registry gate (plan T7-U1).
 *
 * An error class is not "added" when its `class` statement compiles. It is added when it
 * appears on every surface the taxonomy promises: the driver-failure union it belongs to (or
 * visibly does not), the classifier that decides whether a caller was meant to receive it, the
 * Prisma-code map a porting user reads, and the errors page that documents it. A class that
 * reaches three of those and misses the fourth is exactly the W5-U2 shape — a lane building
 * blind to a taxonomy change, caught weeks later by audit.
 *
 * This file is the audit, run as a test. One canonical registry below; four surfaces checked
 * against it; every failure message names the CLASS and the SURFACE it is missing from.
 *
 * The registry itself is not hand-trusted: {@link discoverConcreteErrorClasses} parses every
 * `.ts` file under `src/` and derives the concrete `VibORMError` subclasses from the source,
 * so a class added anywhere in the tree without a registry row is a named failure here rather
 * than an invisible omission. The count pin is the house-census idiom: a number moves only
 * when someone decides it should.
 *
 * **Relationship to its neighbours** — this gate owns the CLASS axis; it does not restate what
 * they own:
 * - `prisma-codes.test.ts` owns the CODE axis of the Prisma mapping (every `VibORMErrorCode` is
 *   claimed or documented as unclaimed) and the serialization of `prismaCode`. Here we assert
 *   only that each class's constructed instance publishes the code its row pins, and that the
 *   map and the getter agree at the class.
 * - `failure-classification.test.ts` owns the retry policy and the per-code dispositions. Here
 *   we assert only the expected-failure-vs-defect verdict, for every class, by census.
 * - `error-code-discrimination.test.ts` owns the narrowing behaviour of the literal `code`.
 *   Here the type-level arm is the one thing that file deliberately does not do: tie its local
 *   union to the SHIPPED `DriverFailure`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  CacheConfigurationError,
  CacheInvalidKeyError,
  CacheInvalidTTLError,
  CacheOperationNotCacheableError,
  CheckConstraintError,
  ClientInitializationError,
  ConnectionError,
  classifyFailure,
  FeatureNotSupportedError,
  ForeignKeyError,
  InvalidTransactionInputError,
  MigrationError,
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  NotNullConstraintError,
  PendingOperationError,
  QueryEngineError,
  QueryError,
  type QueryFailure,
  TransactionError,
  toPrismaErrorCode,
  UniqueConstraintError,
  UnsupportedOperationError,
  ValidationError,
  ValueTooLongError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import ts from "typescript";
import {
  REPOSITORY_ROOT,
  SOURCE_ROOT,
} from "@tests/fixtures/repo-paths";
import { expectTypeOf } from "vitest";
import type { DriverFailure } from "@src/drivers/error-mapping";

const ERROR_MAPPING = join(SOURCE_ROOT, "drivers/error-mapping.ts");
const DOCS_ERRORS = join(
  REPOSITORY_ROOT,
  "docs/content/docs/client/errors.mdx"
);

/** The base every taxonomy class descends from. It is not itself a registry row. */
const TAXONOMY_ROOT = "VibORMError";

/**
 * One class, and what every surface must say about it.
 *
 * `make` builds the instance a caller actually receives, so each surface is exercised against
 * a real constructed error rather than against a table read in isolation.
 */
type RegistryRow = {
  /** Class name, exactly as declared and as the docs table spells it. */
  readonly name: string;
  /** The instance the surfaces are checked against. */
  readonly make: () => VibORMError;
  /** The code that instance carries. */
  readonly code: VibORMErrorCode;
  /** Whether the class is a member of the `DriverFailure` union (surface 1). */
  readonly driverFailure: boolean;
  /** What `classifyFailure` must answer for that instance (surface 2). */
  readonly classification: "failure" | "defect";
  /**
   * The Prisma code the instance publishes, or `null` for the viborm-only allowlist — a class
   * whose failure mode Prisma has no documented equivalent for (surface 3).
   */
  readonly prismaCode: string | null;
};

/**
 * THE REGISTRY. One row per concrete error class, alphabetical.
 *
 * Adding a class means adding a row here; the census test below turns "forgot to" into a named
 * failure. Changing a row means deciding, in writing, what the change means on four surfaces.
 */
const REGISTRY: readonly RegistryRow[] = [
  {
    name: "CacheConfigurationError",
    make: () => new CacheConfigurationError("Cache driver is missing"),
    code: VibORMErrorCode.CACHE_CONFIGURATION,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "CacheInvalidKeyError",
    make: () => new CacheInvalidKeyError("Cache key is not serializable"),
    code: VibORMErrorCode.CACHE_INVALID_KEY,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "CacheInvalidTTLError",
    make: () => new CacheInvalidTTLError("Invalid TTL"),
    code: VibORMErrorCode.CACHE_INVALID_TTL,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "CacheOperationNotCacheableError",
    make: () => new CacheOperationNotCacheableError("create", ["findMany"]),
    code: VibORMErrorCode.CACHE_OPERATION_NOT_CACHEABLE,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "CheckConstraintError",
    make: () => new CheckConstraintError("Check constraint violation"),
    code: VibORMErrorCode.CHECK_CONSTRAINT,
    driverFailure: true,
    classification: "failure",
    prismaCode: "P2004",
  },
  {
    name: "ClientInitializationError",
    make: () =>
      new ClientInitializationError('Model "ghost" not found in schema'),
    code: VibORMErrorCode.CLIENT_INITIALIZATION,
    driverFailure: false,
    classification: "failure",
    prismaCode: "P1012",
  },
  {
    name: "ConnectionError",
    make: () => new ConnectionError("Database connection failed"),
    code: VibORMErrorCode.CONNECTION_FAILED,
    driverFailure: false,
    classification: "failure",
    prismaCode: "P1001",
  },
  {
    name: "FeatureNotSupportedError",
    make: () => new FeatureNotSupportedError("vector", "l2Distance"),
    code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "ForeignKeyError",
    make: () => new ForeignKeyError("Foreign key constraint violation"),
    code: VibORMErrorCode.FOREIGN_KEY_CONSTRAINT,
    driverFailure: true,
    classification: "failure",
    prismaCode: "P2003",
  },
  {
    name: "InvalidTransactionInputError",
    make: () => new InvalidTransactionInputError(),
    code: VibORMErrorCode.INVALID_TRANSACTION_INPUT,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "MigrationError",
    make: () => new MigrationError("Migration failed"),
    code: VibORMErrorCode.MIGRATION_FAILED,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "NestedWriteAssertionError",
    make: () => new NestedWriteAssertionError("Connect target vanished"),
    code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
    driverFailure: true,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "NestedWriteError",
    make: () => new NestedWriteError("Nested write failed", "posts"),
    code: VibORMErrorCode.NESTED_WRITE_FAILED,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "NotFoundError",
    make: () => new NotFoundError("user", "findUniqueOrThrow"),
    code: VibORMErrorCode.RECORD_NOT_FOUND,
    driverFailure: false,
    classification: "failure",
    prismaCode: "P2025",
  },
  {
    name: "NotNullConstraintError",
    make: () => new NotNullConstraintError("Not-null constraint violation"),
    code: VibORMErrorCode.NOT_NULL_CONSTRAINT,
    driverFailure: true,
    classification: "failure",
    prismaCode: "P2011",
  },
  {
    name: "PendingOperationError",
    make: () => PendingOperationError.clientMismatch("user", "create"),
    code: VibORMErrorCode.OPERATION_CLIENT_MISMATCH,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    // The one defect in the registry: V9001 means the engine broke its own invariant.
    name: "QueryEngineError",
    make: () => new QueryEngineError("Engine invariant broken"),
    code: VibORMErrorCode.INTERNAL_ERROR,
    driverFailure: false,
    classification: "defect",
    prismaCode: null,
  },
  {
    name: "QueryError",
    make: () => new QueryError("Query execution failed"),
    code: VibORMErrorCode.QUERY_FAILED,
    driverFailure: true,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "TransactionError",
    make: () => new TransactionError("Transaction failed"),
    code: VibORMErrorCode.TRANSACTION_FAILED,
    driverFailure: true,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "UniqueConstraintError",
    make: () => new UniqueConstraintError("Unique constraint violation"),
    code: VibORMErrorCode.UNIQUE_CONSTRAINT,
    driverFailure: true,
    classification: "failure",
    prismaCode: "P2002",
  },
  {
    // The V8003 refusal. Same class family as the defect above, opposite disposition — the
    // pair this whole classification seam exists for.
    name: "UnsupportedOperationError",
    make: () => new UnsupportedOperationError("Shape not expressed"),
    code: VibORMErrorCode.UNSUPPORTED_OPERATION,
    driverFailure: false,
    classification: "failure",
    prismaCode: null,
  },
  {
    name: "ValidationError",
    make: () =>
      new ValidationError("create", [
        { message: "id is required", path: "data.id" },
      ]),
    code: VibORMErrorCode.VALIDATION_FAILED,
    driverFailure: false,
    classification: "failure",
    prismaCode: "P2009",
  },
  {
    name: "ValueTooLongError",
    make: () => new ValueTooLongError("Value too long for column type"),
    code: VibORMErrorCode.VALUE_TOO_LONG,
    driverFailure: true,
    classification: "failure",
    prismaCode: "P2000",
  },
];

/** The census pin. Moves only when a class is deliberately added or removed. */
const REGISTRY_COUNT = 23;

/* ------------------------------------------------------------------ *
 * Source discovery: the registry cannot quietly fall behind the tree. *
 * ------------------------------------------------------------------ */

type DeclaredClass = {
  readonly name: string;
  readonly parent: string | undefined;
  readonly abstract: boolean;
  readonly file: string;
};

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(path);
    }
    return path.endsWith(".ts") ? [path] : [];
  });
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    basename(path),
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

function baseClassName(node: ts.ClassDeclaration): string | undefined {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }
    const expression = clause.types[0]?.expression;
    if (expression && ts.isIdentifier(expression)) {
      return expression.text;
    }
  }
  return undefined;
}

function declaredClasses(path: string): DeclaredClass[] {
  const found: DeclaredClass[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      found.push({
        name: node.name.text,
        parent: baseClassName(node),
        abstract: (ts.getModifiers(node) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword
        ),
        file: path,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path));
  return found;
}

/**
 * Every concrete class under `src/` whose `extends` chain reaches `VibORMError`. Resolution is
 * by NAME across the whole tree, which is what makes a subclass declared outside `src/errors/`
 * visible here too.
 */
function discoverConcreteErrorClasses(): DeclaredClass[] {
  const all = listTypeScriptFiles(SOURCE_ROOT).flatMap(declaredClasses);
  const parentByName = new Map(all.map((entry) => [entry.name, entry.parent]));
  const descendsFromRoot = (name: string): boolean => {
    const seen = new Set<string>();
    let current = parentByName.get(name);
    while (current !== undefined && !seen.has(current)) {
      if (current === TAXONOMY_ROOT) {
        return true;
      }
      seen.add(current);
      current = parentByName.get(current);
    }
    return false;
  };
  return all.filter((entry) => !entry.abstract && descendsFromRoot(entry.name));
}

const DISCOVERED = discoverConcreteErrorClasses();

/* ------------------------------------------- *
 * Surface 1: the driver-failure union, read    *
 * out of its own source so a miss can be named.*
 * ------------------------------------------- */

function unionMemberNames(path: string, alias: string): string[] {
  let members: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === alias) {
      members = ts.isUnionTypeNode(node.type)
        ? node.type.types.map((member) => member.getText())
        : [node.type.getText()];
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path));
  if (!members) {
    throw new Error(`no type alias named ${alias} in ${path}`);
  }
  return members;
}

const DRIVER_FAILURE_MEMBERS = new Set(
  unionMemberNames(ERROR_MAPPING, "DriverFailure")
);

/**
 * The same union, spelled as types, so the source scan above cannot drift from what the
 * compiler sees. `error-code-discrimination.test.ts` writes this union locally to pin
 * NARROWING; the one thing it deliberately does not do is tie it to the shipped alias. This
 * does: delete a member from `DriverFailure` and `pnpm test:types` fails here.
 */
type DriverFailureCensus =
  | CheckConstraintError
  | ForeignKeyError
  | NestedWriteAssertionError
  | NotNullConstraintError
  | QueryError
  | TransactionError
  | UniqueConstraintError
  | ValueTooLongError;

/** Every concrete class in the registry, as a type. */
type RegisteredError =
  | CacheConfigurationError
  | CacheInvalidKeyError
  | CacheInvalidTTLError
  | CacheOperationNotCacheableError
  | CheckConstraintError
  | ClientInitializationError
  | ConnectionError
  | FeatureNotSupportedError
  | ForeignKeyError
  | InvalidTransactionInputError
  | MigrationError
  | NestedWriteAssertionError
  | NestedWriteError
  | NotFoundError
  | NotNullConstraintError
  | PendingOperationError
  | QueryEngineError
  | QueryError
  | TransactionError
  | UniqueConstraintError
  | UnsupportedOperationError
  | ValidationError
  | ValueTooLongError;

/* ---------------------------------------------------- *
 * Surface 4: the user-facing errors page, read as text. *
 * ---------------------------------------------------- */

const DOCS_SOURCE = readFileSync(DOCS_ERRORS, "utf8");

/** `| \`ClassName\` | \`V####\`, … | Raised when … |` → name → the code cell. */
const DOCS_TABLE_ROW = /^\|\s*`(\w+Error)`\s*\|([^|]*)\|/;

const DOCS_ROWS = new Map<string, string>(
  DOCS_SOURCE.split("\n").flatMap((line) => {
    const match = DOCS_TABLE_ROW.exec(line);
    return match ? [[match[1] as string, match[2] as string] as const] : [];
  })
);

const docsMentions = (code: string): boolean =>
  DOCS_SOURCE.includes(`\`${code}\``);

describe("the error registry census", () => {
  it("has a row for every concrete VibORMError subclass declared in src/", () => {
    const registered = new Set(REGISTRY.map((row) => row.name));
    const missing = DISCOVERED.filter(
      (entry) => !registered.has(entry.name)
    ).map((entry) => `${entry.name} (${entry.file}) has no registry row`);
    expect(missing).toEqual([]);
  });

  it("registers nothing the source does not declare", () => {
    const discovered = new Set(DISCOVERED.map((entry) => entry.name));
    const phantom = REGISTRY.filter((row) => !discovered.has(row.name)).map(
      (row) => `${row.name} is registered but no longer declared under src/`
    );
    expect(phantom).toEqual([]);
  });

  it("holds at the pinned count, in both the registry and the source", () => {
    expect(REGISTRY).toHaveLength(REGISTRY_COUNT);
    expect(DISCOVERED).toHaveLength(REGISTRY_COUNT);
    expect(new Set(REGISTRY.map((row) => row.name)).size).toBe(REGISTRY_COUNT);
  });

  it("builds each row at the class and code it claims", () => {
    const wrong = REGISTRY.flatMap((row) => {
      const error = row.make();
      if (!(error instanceof VibORMError)) {
        return [`${row.name} does not construct a VibORMError`];
      }
      if (error.constructor.name !== row.name) {
        return [`${row.name} constructs a ${error.constructor.name} instead`];
      }
      return error.code === row.code
        ? []
        : [`${row.name} carries ${error.code}, not the pinned ${row.code}`];
    });
    expect(wrong).toEqual([]);
  });
});

describe("surface 1 — the DriverFailure union", () => {
  it("lists every class the registry marks driver-constructed", () => {
    const missing = REGISTRY.filter(
      (row) => row.driverFailure && !DRIVER_FAILURE_MEMBERS.has(row.name)
    ).map(
      (row) =>
        `${row.name} is missing from the DriverFailure union (src/drivers/error-mapping.ts)`
    );
    expect(missing).toEqual([]);
  });

  it("lists nothing else", () => {
    const claimed = new Set(
      REGISTRY.filter((row) => row.driverFailure).map((row) => row.name)
    );
    const unexpected = [...DRIVER_FAILURE_MEMBERS]
      .filter((member) => !claimed.has(member))
      .map(
        (member) =>
          `${member} is a DriverFailure member with no driverFailure row in the registry`
      );
    expect(unexpected).toEqual([]);
  });

  it("matches the shipped type exactly", () => {
    // Type-level, so the source scan above cannot be satisfied by a union that says something
    // different from what it spells. Failing here is a `pnpm test:types` error naming this line.
    expectTypeOf<DriverFailure>().toEqualTypeOf<DriverFailureCensus>();
    expect(DRIVER_FAILURE_MEMBERS.size).toBe(
      REGISTRY.filter((row) => row.driverFailure).length
    );
  });

  it("carries every registered class on QueryFailure's error arm", () => {
    // `QueryFailure` did not land as a union of classes — it is the classification RESULT, and
    // its `error` is the carrier every expected failure is handed back on (T1-U3). So the
    // union-membership question for this surface is assignability to that carrier, and the
    // runtime half below is the one that matters: the classifier hands the very instance back.
    expectTypeOf<RegisteredError>().toExtend<QueryFailure["error"]>();
    const dropped = REGISTRY.filter(
      (row) => row.classification === "failure"
    ).flatMap((row) => {
      const error = row.make();
      const classified = classifyFailure(error);
      return classified.kind === "failure" && classified.error === error
        ? []
        : [`${row.name} is not carried through QueryFailure.error`];
    });
    expect(dropped).toEqual([]);
  });
});

describe("surface 2 — classifyFailure", () => {
  it("gives every registered class the disposition its row pins", () => {
    const disagreements = REGISTRY.flatMap((row) => {
      const verdict = classifyFailure(row.make()).kind;
      return verdict === row.classification
        ? []
        : [
            `${row.name} classifies as a ${verdict}; classifyFailure's switch is missing the ${row.classification} disposition for ${row.code}`,
          ];
    });
    expect(disagreements).toEqual([]);
  });

  it("keeps the V8003 refusal and the V9001 defect on opposite sides", () => {
    // The pair the seam exists for, restated at the class axis: same family, same `instanceof`
    // answer, opposite dispositions.
    const refusal = new UnsupportedOperationError("Shape not expressed");
    const defect = new QueryEngineError("Engine invariant broken");
    expect(refusal).toBeInstanceOf(QueryEngineError);
    expect(classifyFailure(refusal).kind).toBe("failure");
    expect(classifyFailure(defect).kind).toBe("defect");
  });
});

describe("surface 3 — the prismaCode map", () => {
  it("publishes the pinned Prisma code, or none at all", () => {
    const wrong = REGISTRY.flatMap((row) => {
      const published = row.make().prismaCode;
      const expectedCode = row.prismaCode ?? undefined;
      return published === expectedCode
        ? []
        : [
            `${row.name} publishes prismaCode ${String(published)}; the registry pins ${String(expectedCode)} (src/errors/base.ts PRISMA_CODE_BY_VIBORM_CODE)`,
          ];
    });
    expect(wrong).toEqual([]);
  });

  it("agrees with the map read directly, class by class", () => {
    const disagreements = REGISTRY.flatMap((row) => {
      const error = row.make();
      return toPrismaErrorCode(error.code) === error.prismaCode
        ? []
        : [
            `${row.name}: toPrismaErrorCode(${error.code}) and error.prismaCode disagree`,
          ];
    });
    expect(disagreements).toEqual([]);
  });

  it("names the viborm-only classes explicitly", () => {
    // The allowlist is the `prismaCode: null` rows, spelled out rather than defaulted, so
    // adding a class silently inherits no disposition.
    expect(
      REGISTRY.filter((row) => row.prismaCode === null)
        .map((row) => row.name)
        .sort()
    ).toEqual([
      "CacheConfigurationError",
      "CacheInvalidKeyError",
      "CacheInvalidTTLError",
      "CacheOperationNotCacheableError",
      "FeatureNotSupportedError",
      "InvalidTransactionInputError",
      "MigrationError",
      "NestedWriteAssertionError",
      "NestedWriteError",
      "PendingOperationError",
      "QueryEngineError",
      "QueryError",
      "TransactionError",
      "UnsupportedOperationError",
    ]);
  });
});

describe("surface 4 — the user-facing errors docs", () => {
  it("has a code-table row for every registered class", () => {
    const missing = REGISTRY.filter((row) => !DOCS_ROWS.has(row.name)).map(
      (row) =>
        `${row.name} has no row in the code table (docs/content/docs/client/errors.mdx)`
    );
    expect(missing).toEqual([]);
  });

  it("lists each class's code in that class's row", () => {
    const missing = REGISTRY.flatMap((row) => {
      const cell = DOCS_ROWS.get(row.name);
      if (cell === undefined) {
        return [];
      }
      return cell.includes(`\`${row.code}\``)
        ? []
        : [
            `${row.name}'s docs row does not list ${row.code} (docs/content/docs/client/errors.mdx)`,
          ];
    });
    expect(missing).toEqual([]);
  });

  it("names no class the registry does not know", () => {
    const registered = new Set(REGISTRY.map((row) => row.name));
    const stale = [...DOCS_ROWS.keys()]
      .filter((name) => !registered.has(name))
      .map(
        (name) =>
          `the docs code table has a row for ${name}, which is not a registered error class`
      );
    expect(stale).toEqual([]);
  });

  it("documents every code in the taxonomy somewhere on the page", () => {
    // The page claims to cover the whole code space — the rows, plus the closing sentence
    // listing the reserved codes. A code added without a home is a named failure.
    const undocumented = Object.values(VibORMErrorCode)
      .filter((code) => !docsMentions(code))
      .map(
        (code) =>
          `${code} appears nowhere on the errors page (docs/content/docs/client/errors.mdx)`
      );
    expect(undocumented).toEqual([]);
  });
});

const CLONE_TABLE_PATTERN = /const CLONE_CONSTRUCTORS = \[([^\]]*)\]/;

describe("surface 5 — the execution-context clone table", () => {
  // The lived defect: CLONE_CONSTRUCTORS in src/drivers/driver-error-context.ts
  // was a hand-maintained list, and three newer classes were absent — their
  // instances silently downgraded to the base VibORMError when cloned through
  // attachExecutionContext, erasing the literal `code` T1 pinned. Same idiom as
  // surface 4: scan the source, so a class added to the registry but not the
  // clone table is a NAMED failure, not a latent downgrade.
  const CLONE_SOURCE = readFileSync(
    join(SOURCE_ROOT, "drivers", "driver-error-context.ts"),
    "utf8"
  );
  const cloneTable = CLONE_SOURCE.match(CLONE_TABLE_PATTERN)?.[1] ?? "";

  it("declares the table this gate audits", () => {
    expect(cloneTable.length).toBeGreaterThan(0);
  });

  it("lists every registered class, or handles it by name", () => {
    // ValidationError is deliberately absent from the array: it clones through
    // cloneValidationError (issues need structural copying). Any other absence
    // is the downgrade bug returning.
    const handledElsewhere = new Set(["ValidationError"]);
    const missing = REGISTRY.filter(
      (row) =>
        !(handledElsewhere.has(row.name) || cloneTable.includes(row.name))
    ).map(
      (row) =>
        `${row.name} is missing from CLONE_CONSTRUCTORS (src/drivers/driver-error-context.ts) — its instances downgrade to VibORMError when cloned`
    );
    expect(missing).toEqual([]);
    expect(CLONE_SOURCE.includes("cloneValidationError")).toBe(true);
  });
});
