import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { QueryEngineError } from "@errors";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { validateSchema, validateSchemaOrThrow } from "@src/schema/validation";
import { validateClientSchemaOrThrow } from "@src/schema/validation/validator";
import { describe, expect, it } from "vitest";

/**
 * **Unit 2.1 — the TIMING half of the inverse-resolution pin.**
 *
 * A schema whose inverse cannot be resolved fails in three different places, at three
 * different times, with three different classes of diagnostic. Phase 2 gives inverse
 * resolution one owner whose `missing` and `ambiguous` arms throw nothing, and every
 * caller keeps translating them by its own policy — so the three timings below are what
 * "unchanged definition failures" means in the keep gate. They are pinned before the
 * resolver exists, as the pre-change truth Phase 2's later behaviour commit is measured
 * against.
 *
 *  1. **Missing inverse** (R002/R003/R004/R005, severity `error`). NOT run at client
 *     construction for an ordinary schema: `validateClientSchemaOrThrow`
 *     (`src/schema/validation/validator.ts:155-164`, called by `createClient` at
 *     `src/client/client.ts:632-633`) runs ONLY `inverseOneToOneMustBeOptional` there.
 *     The missing-inverse rules run at `push` (`src/migrations/push/index.ts:59`) and in
 *     the CLI (`src/cli/utils.ts:191`), through the full rule set.
 *  2. **Ambiguous inverse** (R007) is a `warning`, and `validateOrThrow` throws only for
 *     errors — so ambiguity is never a definition failure at all. It becomes a
 *     `QueryEngineError` at QUERY time, in the engine's own scanner.
 *  3. A schema that declares ANY polymorphic relation runs the complete rule set at
 *     client construction, so the very same missing inverse throws there.
 *
 * The resolution answers themselves (which back-reference each scanner picks, and where
 * the two disagree) are pinned in
 * `tests/unit/relations/inverse-resolution-parity.core.test.ts`.
 */

// =============================================================================
// FIXTURES — one missing inverse, reused so the timings differ by nothing else
// =============================================================================

const note = s.model({
  id: s.string().id(),
  body: s.string(),
});

/** R003: a one-to-many whose target declares no many-to-one back at it. */
const folder = s.model({
  id: s.string().id(),
  notes: s.oneToMany(() => note),
});

/** R004: a many-to-one whose target declares no one-to-many back at it. */
const mention = s.model({
  id: s.string().id(),
  noteId: s.string(),
  target: s
    .manyToOne(() => note)
    .fields("noteId")
    .references("id"),
});

/**
 * A well-formed polymorphic trio. Its only job is to flip `hasPolymorphicRelations`,
 * which is what decides how much of the rule set client construction runs.
 */
const clip = s.model({ id: s.string().id() });
const reel = s.model({ id: s.string().id() });
const bookmark = s.model({
  id: s.string().id(),
  subject: s.polymorphic({ clip: () => clip, reel: () => reel }),
});

const errorCodes = (result: ReturnType<typeof validateSchema>): string[] =>
  result.errors.map((issue) => issue.code);

describe("inverse resolution failure timing", () => {
  describe("a missing inverse on an ordinary schema", () => {
    it("is not raised at client construction", () => {
      // `createClient` hydrates and then calls this. For a schema with no polymorphic
      // relation it runs one rule, and that rule has nothing to say about a missing
      // one-to-many/many-to-one pairing.
      expect(() =>
        validateClientSchemaOrThrow({ folder, note, mention })
      ).not.toThrow();
    });

    it("is an error of the full rule set, which push and the CLI run", () => {
      const result = validateSchema({ folder, note, mention });

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        code: "R003",
        message:
          "'notes' (oneToMany) in 'folder' missing inverse manyToOne in 'note'",
        severity: "error",
        model: "folder",
        relation: "notes",
      });
      expect(result.errors).toContainEqual({
        code: "R004",
        message:
          "'target' (manyToOne) in 'mention' missing inverse oneToMany in 'note'",
        severity: "error",
        model: "mention",
        relation: "target",
      });

      expect(() =>
        validateSchemaOrThrow({ folder, note, mention })
      ).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "R003", model: "folder" }),
            expect.objectContaining({ code: "R004", model: "mention" }),
          ]),
        })
      );
    });
  });

  describe("an ambiguous inverse on an ordinary schema", () => {
    // Two fields-bearing back-references, neither named: the case where the two runtime
    // scanners disagree (see the parity file). Definition validation has an opinion about
    // it — and that opinion is a WARNING.
    const user = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      editorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id"),
      editor: s
        .manyToOne(() => user)
        .fields("editorId")
        .references("id"),
    });
    hydrateSchemaNames({ post, user });

    it("is a warning that no definition gate throws for", () => {
      const result = validateSchema({ user, post });

      expect(result.warnings).toContainEqual({
        code: "R007",
        message:
          "Multiple relations author, editor from 'post' to 'user' - disambiguate with .name()",
        severity: "warning",
        model: "post",
      });
      expect(errorCodes(result)).not.toContain("R007");

      // Warnings never throw, so neither definition boundary refuses this schema.
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(() => validateSchemaOrThrow({ user, post })).not.toThrow();
      expect(() => validateClientSchemaOrThrow({ user, post })).not.toThrow();
    });

    it("becomes an error only when a query binds the relation", () => {
      const scope = createQueryScope(new PostgresAdapter(), user);
      const relationInfo = getRelationInfo(scope, "posts");
      if (!relationInfo) {
        throw new Error("Expected relation 'posts' on the fixture model.");
      }

      expect(() => bindRelation(scope, relationInfo)).toThrow(QueryEngineError);
      expect(() => bindRelation(scope, relationInfo)).toThrow(
        "Ambiguous relation 'posts' on model 'user': multiple relations on 'post' point back to it. Add .name() to both sides of each relation to disambiguate."
      );
    });
  });

  describe("a schema that declares a polymorphic relation", () => {
    it("adds no definition error of its own", () => {
      // The control for the contrast below: the trio is clean, so the throw it causes is
      // the ORDINARY missing inverse being reported earlier, not a polymorphic complaint.
      expect(validateSchema({ clip, reel, bookmark }).errors).toEqual([]);
    });

    it("runs the complete rule set at client construction", () => {
      // Same models, same missing inverse, one extra polymorphic-owning model — and the
      // failure moves from push time to client construction.
      expect(() =>
        validateClientSchemaOrThrow({ folder, note, mention })
      ).not.toThrow();

      expect(() =>
        validateClientSchemaOrThrow({
          folder,
          note,
          mention,
          clip,
          reel,
          bookmark,
        })
      ).toThrowError(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: "R003",
              model: "folder",
              relation: "notes",
            }),
          ]),
        })
      );
    });
  });
});
