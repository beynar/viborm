/**
 * Acceptance: the documentation IS the corpus.
 *
 * Every schema-declaring fence under `docs/content/docs/schema/**` has a JSON
 * twin, and the twin has to denote the same schema — proven twice over: the
 * coded fence serializes to the document, and the document parses back to a
 * schema that serializes to the same document. Where the completed fence is a
 * schema the resolution gate accepts, the two also produce the SAME MIGRATION
 * SNAPSHOT, which is the resolved relation index made comparable.
 *
 * The three fences the format refuses get a witness apiece instead, and both
 * counts are recorded here rather than left to the reader.
 *
 * The `json` fences are not transliterated at all — they ARE documents, so they
 * are run.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { parseSchema, serializeSchema } from "@schema/json";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { serializeModels } from "@src/migrations/serializer";
import { validateSchema } from "@src/schema/validation";
import { docsFenceCorpus } from "@tests/fixtures/schema-json-docs-corpus";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const DOCS_ROOT = "docs/content/docs/schema";
const FENCE = /^```(\w+)[^\n]*\n([\s\S]*?)^```/gm;

/**
 * The three fences the format refuses, by address. Two carry the function
 * default; the third is prose — `s.model({ ... })` with a literal ellipsis.
 */
const REFUSED_FENCE_IDS = ["index.mdx#1", "model.mdx#0", "model.mdx#8"];

/**
 * Every fence in the schema docs that SPELLS a model, addressed as
 * `<file>#<fence index>`. Reading the tree rather than trusting a number is
 * what keeps the corpus from drifting: a new schema fence lands here with no
 * twin and this suite says so.
 */
function schemaDeclaringFenceIds(): string[] {
  return fences()
    .filter((fence) => fence.body.includes("s.model("))
    .map((fence) => fence.id);
}

interface DocsFence {
  readonly id: string;
  readonly language: string;
  readonly body: string;
}

/** Every fence in the schema docs, addressed as `<file>#<fence index>`. */
function fences(): DocsFence[] {
  const found: DocsFence[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".mdx")) continue;
      const text = readFileSync(path, "utf8");
      let index = 0;
      FENCE.lastIndex = 0;
      for (const match of text.matchAll(FENCE)) {
        found.push({
          id: `${relative(DOCS_ROOT, path)}#${index}`,
          language: match[1] ?? "",
          body: match[2] ?? "",
        });
        index += 1;
      }
    }
  };
  walk(DOCS_ROOT);
  return found;
}

describe("docs acceptance corpus", () => {
  it("partitions every schema-declaring fence into accepted and refused", () => {
    const declared = schemaDeclaringFenceIds();
    const accepted = docsFenceCorpus.map((entry) => entry.id);
    expect(new Set(accepted).size).toBe(accepted.length);
    expect([...declared].sort()).toEqual(
      [...accepted, ...REFUSED_FENCE_IDS].sort()
    );
    // The counts, recorded rather than left to the reader.
    expect(declared).toHaveLength(38);
    expect(accepted).toHaveLength(35);
    expect(REFUSED_FENCE_IDS).toHaveLength(3);
  });

  it("records how the whole fence population divides", () => {
    const byLanguage: Record<string, number> = {};
    for (const fence of fences()) {
      byLanguage[fence.language] = (byLanguage[fence.language] ?? 0) + 1;
    }
    expect(byLanguage).toEqual({
      ts: 145,
      sql: 8,
      json: 3,
      text: 3,
      mermaid: 1,
    });
  });

  it.each(
    docsFenceCorpus
  )("$id — the coded fence writes the document", (entry) => {
    expect(serializeSchema(entry.coded())).toEqual(entry.document);
  });

  it.each(
    docsFenceCorpus
  )("$id — the document reads back the same", (entry) => {
    expect(serializeSchema(parseSchema(entry.document))).toEqual(
      entry.document
    );
  });

  it.each(
    docsFenceCorpus
  )("$id — both denote the same resolved schema", (entry) => {
    const coded = entry.coded();
    const parsed = parseSchema(entry.document);
    const codedVerdict = validateSchema(coded);
    expect(validateSchema(parsed).errors.map((issue) => issue.code)).toEqual(
      codedVerdict.errors.map((issue) => issue.code)
    );
    if (!codedVerdict.valid) return;
    const options = { migrationDriver: postgresMigrationDriver };
    expect(serializeModels(parsed, options)).toEqual(
      serializeModels(coded, options)
    );
  });
});

/**
 * The other half of the corpus: the documents the docs SHOW.
 *
 * A `ts` fence is transliterated by hand above, so a coded example that rots is
 * caught by its twin. A `json` fence had no such check at all — and the very
 * first one, the page's primary example, named two variant targets it never
 * declared, so a reader who copied it got `J006`. These fences ARE documents,
 * so they are simply run: parsed, and proven to be fixed points of the
 * canonical form.
 */
describe("documented JSON documents", () => {
  const documents = fences().filter((fence) => fence.language === "json");

  it("finds every JSON fence in the schema docs", () => {
    expect(documents.map((fence) => fence.id)).toEqual([
      "json.mdx#1",
      "json.mdx#3",
      "json.mdx#4",
    ]);
  });

  it.each(documents)("$id parses", (fence) => {
    expect(() => parseSchema(fence.body)).not.toThrow();
  });

  it.each(documents)("$id is its own canonical form", (fence) => {
    const once = serializeSchema(parseSchema(fence.body));
    expect(serializeSchema(parseSchema(once))).toEqual(once);
  });

  it.each(
    documents
  )("$id describes a schema the validator accepts", (fence) => {
    expect(validateSchema(parseSchema(fence.body)).errors).toEqual([]);
  });
});

describe("refusal witnesses for the excluded fences", () => {
  // `model.mdx` #0 and #8 both spell `.default(() => new Date())`.
  it("model.mdx#0 — a function default has no document spelling", () => {
    const user = s.model({
      id: s.string().id().ulid(),
      email: s.string().unique(),
      name: s.string(),
      createdAt: s.dateTime().default(() => new Date()),
    });
    expect(() => serializeSchema({ user })).toThrow(ValidationError);
  });

  it("model.mdx#8 — `.extends()` flattens, but its function default does not", () => {
    const baseModel = s.model({
      id: s.string().id(),
      createdAt: s.dateTime().default(() => new Date()),
    });
    const user = baseModel.extends({
      email: s.string().unique(),
      name: s.string(),
    });
    // `.extends()` itself needs no spelling: the document states the merged
    // shape, which is what the state already holds.
    expect(Object.keys(user["~"].state.shape)).toEqual([
      "id",
      "createdAt",
      "email",
      "name",
    ]);
    expect(() => serializeSchema({ user })).toThrow(ValidationError);
  });

  it("index.mdx#1 declares nothing — `s.model({ ... })` is prose", () => {
    // The fence's ellipsis is literal; there is no declaration to transliterate
    // and therefore no witness beyond the partition above, which records it as
    // refused rather than silently missing.
    expect(REFUSED_FENCE_IDS).toContain("index.mdx#1");
  });

  // `scalars/json.mdx` #1, #3 and #4 attach a validator to a SCALAR. They
  // declare no model, so they are outside the 38 — but they are the other
  // function-valued surface the format refuses, and `attachFieldSchemas` is
  // the named way back.
  it("json.mdx — a `.schema()` validator is refused by name", () => {
    const settings = s.model({
      id: s.string().id(),
      preferences: s.json().schema(z.object({ theme: z.string() })),
    });
    let refused: ValidationError | undefined;
    try {
      serializeSchema({ settings });
    } catch (thrown) {
      if (thrown instanceof ValidationError) refused = thrown;
    }
    expect(refused?.issues[0]?.message).toContain("attachFieldSchemas");
  });
});
