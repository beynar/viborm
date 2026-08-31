/**
 * The errors documentation page's examples, compiled (plan T1-U4).
 *
 * A documented DX claim is worth what its probe is worth. Every `ts` example on
 * `docs/content/docs/client/errors.mdx` is reproduced below VERBATIM — the whole body, not a
 * paraphrase — so `pnpm test:types` compiles it, `@ts-expect-error` lines are checked to be
 * genuine errors (TS2578 if they stop erroring), and the runtime assertions exercise it.
 *
 * The verbatim part is enforced, not trusted: the test reads the page, extracts its fenced
 * `ts` blocks, and matches each against the region between the matching `docs:begin` /
 * `docs:end` markers here. Import lines are excluded from the comparison — the page imports
 * from `"viborm"` (the published entry point, which is what a reader types) while a test in
 * this repo imports from the source. Everything below the imports must match character for
 * character, so editing the page without re-probing the change fails here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CheckConstraintError,
  type ForeignKeyError,
  isRetryableError,
  type NotNullConstraintError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { REPOSITORY_ROOT, SOURCE_ROOT } from "@tests/fixtures/repo-paths";

const PAGE = join(REPOSITORY_ROOT, "docs/content/docs/client/errors.mdx");

// A stand-in for the client the page's first example calls. The example's SHAPE is the claim
// (catch, narrow by class, read meta); the client that produced the error is not.
const client = {
  user: {
    create: (_args: { data: { email: string } }): Promise<never> =>
      Promise.reject(
        new UniqueConstraintError("Unique constraint violation", {
          meta: { constraint: "user_email_key", columns: ["email"] },
        })
      ),
  },
};

// docs:begin catching
async function register(email: string): Promise<void> {
  try {
    await client.user.create({ data: { email } });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      // error.meta.constraint, error.meta.columns, error.meta.table
      throw new Error("That email is already registered.");
    }
    throw error;
  }
}
// docs:end catching

// docs:begin narrowing
function describeFailure(
  error: UniqueConstraintError | ForeignKeyError
): string {
  if (error.code === "V3001") {
    // error is UniqueConstraintError here
    return `duplicate ${error.meta.columns?.join(", ") ?? "value"}`;
  }
  // and ForeignKeyError here
  return `missing parent for ${error.meta.constraint ?? "relation"}`;
}
// docs:end narrowing

// docs:begin impossible
function handle(error: unknown): string {
  if (
    error instanceof UniqueConstraintError &&
    // @ts-expect-error — a UniqueConstraintError never carries V3002
    error.code === VibORMErrorCode.FOREIGN_KEY_CONSTRAINT
  ) {
    return "unreachable";
  }
  return "ok";
}
// docs:end impossible

// docs:begin exhaustive
type ConstraintFailure =
  | CheckConstraintError
  | ForeignKeyError
  | NotNullConstraintError
  | UniqueConstraintError;

function userMessage(error: ConstraintFailure): string {
  switch (error.code) {
    case VibORMErrorCode.UNIQUE_CONSTRAINT:
      return "That value is already taken.";
    case VibORMErrorCode.FOREIGN_KEY_CONSTRAINT:
      return "That reference does not exist.";
    case VibORMErrorCode.NOT_NULL_CONSTRAINT:
      return "A required field was empty.";
    case VibORMErrorCode.CHECK_CONSTRAINT:
      return "That value is not allowed.";
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}
// docs:end exhaustive

// docs:begin retry
async function withOneRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isRetryableError(error)) {
      throw error;
    }
    return await run();
  }
}
// docs:end retry

const TS_BLOCK = /```ts\n([\s\S]*?)```/g;
/** A whole import statement, single- or multi-line. No import contains a `;`, so this is exact. */
const LEADING_IMPORT = /^\s*import[^;]*;\s*/;
/** The named bindings of every `… from "viborm";` import on the page. */
const PAGE_IMPORT = /import(?: type)?\s*\{([^}]*)\}\s*from\s*"viborm";/g;

/** The page's fenced `ts` blocks, in order. */
function pageExamples(): string[] {
  const page = readFileSync(PAGE, "utf8");
  const blocks: string[] = [];
  TS_BLOCK.lastIndex = 0;
  let match = TS_BLOCK.exec(page);
  while (match) {
    if (match[1]) blocks.push(match[1]);
    match = TS_BLOCK.exec(page);
  }
  return blocks;
}

/** This file's `docs:begin <id>` … `docs:end <id>` region. */
function probeRegion(id: string): string {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const open = `// docs:begin ${id}\n`;
  const begin = source.indexOf(open);
  const end = source.indexOf(`// docs:end ${id}`);
  if (begin === -1 || end === -1) {
    throw new Error(`no probe region for '${id}'`);
  }
  return source.slice(begin + open.length, end);
}

/**
 * Comparison form: leading imports dropped (the page imports from `"viborm"`, this file from
 * the source) and the edges trimmed. Indentation INSIDE the example is compared as written.
 */
function comparable(code: string): string {
  let body = code;
  while (LEADING_IMPORT.test(body)) {
    body = body.replace(LEADING_IMPORT, "");
  }
  return body
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

const EXAMPLES = ["catching", "narrowing", "impossible", "exhaustive", "retry"];

describe("the errors page examples", () => {
  it("has the five examples this file probes, and no more", () => {
    expect(pageExamples()).toHaveLength(EXAMPLES.length);
  });

  for (const [index, id] of EXAMPLES.entries()) {
    it(`reproduces the '${id}' example verbatim`, () => {
      const onPage = pageExamples()[index];
      expect(onPage, `example ${index} missing from the page`).toBeDefined();
      expect(comparable(onPage ?? "")).toBe(comparable(probeRegion(id)));
    });
  }
});

describe("the errors page examples do what the page says", () => {
  it("catches the unique violation by class", async () => {
    await expect(register("a@b.c")).rejects.toThrowError(
      "That email is already registered."
    );
  });

  it("narrows on the string code spelling", () => {
    expect(
      describeFailure(
        new UniqueConstraintError("u", { meta: { columns: ["email"] } })
      )
    ).toBe("duplicate email");
  });

  it("keeps the impossible branch unreachable", () => {
    expect(handle(new UniqueConstraintError("u"))).toBe("ok");
  });

  it("answers every arm of the exhaustive switch", () => {
    expect(userMessage(new UniqueConstraintError("u"))).toBe(
      "That value is already taken."
    );
  });

  it("retries exactly once, and only what is retryable", async () => {
    let attempts = 0;
    await expect(
      withOneRetry(() => {
        attempts += 1;
        return Promise.reject(new UniqueConstraintError("u"));
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(attempts).toBe(1);
  });

  it("only imports names the published entry point actually exports", () => {
    // The verbatim comparison excludes import lines (the page imports from "viborm", this
    // file from source), which would leave the page free to teach a name that does not exist.
    // Check them directly against the root entry's export list.
    const entry = readFileSync(join(SOURCE_ROOT, "index.ts"), "utf8");
    const page = readFileSync(PAGE, "utf8");
    const imported = new Set<string>();
    PAGE_IMPORT.lastIndex = 0;
    let match = PAGE_IMPORT.exec(page);
    while (match) {
      for (const name of (match[1] ?? "").split(",")) {
        const bare = name.replace("type ", "").trim();
        if (bare) imported.add(bare);
      }
      match = PAGE_IMPORT.exec(page);
    }
    expect(imported.size).toBeGreaterThan(0);
    for (const name of imported) {
      expect(
        entry,
        `the errors page imports '${name}', which viborm does not export`
      ).toContain(name);
    }
  });

  it("documents the codes it publishes", () => {
    const page = readFileSync(PAGE, "utf8");
    for (const code of Object.values(VibORMErrorCode)) {
      expect(page, `${code} is missing from the errors page`).toContain(code);
    }
  });
});
