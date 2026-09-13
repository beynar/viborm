/**
 * The SQL a text→identifier conversion has to be preceded by.
 *
 * These are rendered here and EXECUTED in the live identifier suites
 * (`tests/contracts/engine/query/identifier-storage-behavior.ts`), against
 * PostgreSQL, MySQL and SQLite, over a legacy text table seeded with exactly
 * the three failures each check names. What this file pins is the rendering:
 * the grammar per format, the prefix arithmetic, the alias fold, and the two
 * table aliases without which a one-to-one child compares its own column with
 * itself.
 */

import { MigrationError } from "@errors";
import { s } from "@schema";
import type { Sql } from "@sql";
import { identifierConversionChecks } from "@src/migrations/identifier-conversion";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id().uuid("usr"),
  handle: s.string().nanoid(12),
  posts: s.toMany(() => post),
  profile: s.toOne(() => profile),
});

const post = s
  .model({
    id: s.string().id().ulid(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");

/** The child whose PRIMARY KEY is its foreign key: both columns are named `id`. */
const profile = s.model({
  id: s.string().id(),
  bio: s.string(),
  owner: s
    .toOne(() => user)
    .fields("id")
    .references("id"),
});

/** A ksuid key, with a COMPOUND reference to it: one member of that reference
 * names this key and the other does not. */
const ticket = s
  .model({
    id: s.string().ksuid(),
    wing: s.string(),
    subject: s.string(),
    bookings: s.toMany(() => booking),
  })
  .id(["id", "wing"]);

const booking = s
  .model({
    id: s.string().id(),
    ticketId: s.string(),
    ticketWing: s.string(),
    ticket: s
      .toOne(() => ticket)
      .fields("ticketId", "ticketWing")
      .references("id", "wing"),
  })
  .map("bookings");

const schema = { booking, post, profile, ticket, user };

/** The refusal's own words, so a reworded message cannot pass this test. */
const NO_COMPACT_DOMAIN = /only uuid, uuidv7, ulid and ksuid change storage/;

/** One check rendered as the statement a reviewer reads, parameters inlined. */
const rendered = (query: Sql): string =>
  query.values.reduce<string>(
    (text, value, position) =>
      // A function replacer, not a string: every pattern here ends in `$`, and
      // `$'` in a replacement STRING means "everything after the match".
      text.replace(`$${position + 1}`, () => `'${String(value)}'`),
    query.toStatement("$n")
  );

const checksFor = (
  model: Parameters<typeof identifierConversionChecks>[0]["model"],
  field: string,
  dialect: "postgresql" | "mysql" | "sqlite"
): string[] =>
  identifierConversionChecks({ schema, model, field, dialect }).map((check) =>
    rendered(check.query)
  );

describe("identifier conversion pre-checks", () => {
  test("a prefixed uuid key: format, collisions, and each referencing column", () => {
    const checks = checksFor(user, "id", "postgresql");

    expect(checks).toEqual([
      `SELECT NOT EXISTS (SELECT 1 FROM "user" AS p WHERE p."id" IS NOT NULL AND NOT (substr(p."id", 1, 4) = 'usr-' AND length(substr(p."id", 5)) = 36 AND substr(p."id", 5) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) AS ok`,
      `SELECT COUNT(p."id") = COUNT(DISTINCT lower(substr(p."id", 5))) AS ok FROM "user" AS p`,
      `SELECT NOT EXISTS (SELECT 1 FROM "posts" AS c WHERE c."authorId" IS NOT NULL AND NOT (substr(c."authorId", 1, 4) = 'usr-' AND length(substr(c."authorId", 5)) = 36 AND substr(c."authorId", 5) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) AS ok`,
      `SELECT NOT EXISTS (SELECT 1 FROM "posts" AS c WHERE c."authorId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" AS p WHERE lower(substr(p."id", 5)) = lower(substr(c."authorId", 5)))) AS ok`,
      `SELECT NOT EXISTS (SELECT 1 FROM "profile" AS c WHERE c."id" IS NOT NULL AND NOT (substr(c."id", 1, 4) = 'usr-' AND length(substr(c."id", 5)) = 36 AND substr(c."id", 5) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) AS ok`,
      // `profile.id` is the child's OWN primary key, so its aliases collapse
      // into each other exactly as the parent's do. `posts.authorId` above is a
      // many-side foreign key and gets no such question: repeats there are the
      // relation, and asking it would refuse every healthy estate.
      `SELECT COUNT(c."id") = COUNT(DISTINCT lower(substr(c."id", 5))) AS ok FROM "profile" AS c`,
      `SELECT NOT EXISTS (SELECT 1 FROM "profile" AS c WHERE c."id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" AS p WHERE lower(substr(p."id", 5)) = lower(substr(c."id", 5)))) AS ok`,
    ]);
  });

  test("a unique referencing column is asked the fold question; a plain one is not", () => {
    const checks = checksFor(user, "id", "postgresql");
    const collisions = checks.filter((check) =>
      check.includes("COUNT(DISTINCT")
    );

    expect(collisions).toEqual([
      `SELECT COUNT(p."id") = COUNT(DISTINCT lower(substr(p."id", 5))) AS ok FROM "user" AS p`,
      `SELECT COUNT(c."id") = COUNT(DISTINCT lower(substr(c."id", 5))) AS ok FROM "profile" AS c`,
    ]);
    expect(collisions.some((check) => check.includes("authorId"))).toBe(false);
  });

  test("a ksuid reference is asked no fold question, unique column or not", () => {
    // The format has no aliases, so nothing folds and nothing can collide —
    // for the key, for a unique reference, or for a plain one.
    expect(
      checksFor(ticket, "id", "postgresql").some((check) =>
        check.includes("COUNT(DISTINCT")
      )
    ).toBe(false);
  });

  test("the child whose key IS the foreign key names both sides", () => {
    // Without the aliases this correlation reads `"id" = "id"` and proves
    // nothing at all: `profile.id` and `user.id` are one spelling.
    expect(checksFor(user, "id", "postgresql")[6]).toContain(
      `WHERE lower(substr(p."id", 5)) = lower(substr(c."id", 5))`
    );
  });

  test("a ulid key folds UP, and an unprefixed payload is the whole column", () => {
    expect(checksFor(post, "id", "postgresql")).toEqual([
      `SELECT NOT EXISTS (SELECT 1 FROM "posts" AS p WHERE p."id" IS NOT NULL AND NOT (length(p."id") = 26 AND p."id" ~ '^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$')) AS ok`,
      `SELECT COUNT(p."id") = COUNT(DISTINCT upper(p."id")) AS ok FROM "posts" AS p`,
    ]);
  });

  test("a ksuid key has no aliases, so nothing is folded anywhere", () => {
    // Not just no collision check: the foreign-key agreement compares the
    // columns THEMSELVES, because for this format one value has one spelling.
    expect(checksFor(ticket, "id", "postgresql")).toEqual([
      `SELECT NOT EXISTS (SELECT 1 FROM "ticket" AS p WHERE p."id" IS NOT NULL AND NOT (length(p."id") = 27 AND p."id" ~ '^[0-9A-Za-z]{27}$')) AS ok`,
      `SELECT NOT EXISTS (SELECT 1 FROM "bookings" AS c WHERE c."ticketId" IS NOT NULL AND NOT (length(c."ticketId") = 27 AND c."ticketId" ~ '^[0-9A-Za-z]{27}$')) AS ok`,
      `SELECT NOT EXISTS (SELECT 1 FROM "bookings" AS c WHERE c."ticketId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ticket" AS p WHERE p."id" = c."ticketId")) AS ok`,
    ]);
  });

  test("a compound reference contributes only the member that names this key", () => {
    // `booking.ticket` references (id, wing); `ticketWing` holds no identifier
    // and must not be checked as one. And `user`'s own foreign keys belong to
    // another key entirely, so they contribute nothing here.
    const checks = checksFor(ticket, "id", "postgresql");
    expect(checks.some((check) => check.includes("ticketWing"))).toBe(false);
    expect(checks.some((check) => check.includes("authorId"))).toBe(false);
  });

  test("MySQL spells the width and the match its own way", () => {
    expect(checksFor(post, "id", "mysql")[0]).toBe(
      "SELECT NOT EXISTS (SELECT 1 FROM `posts` AS p WHERE p.`id` IS NOT NULL AND NOT (CHAR_LENGTH(p.`id`) = 26 AND p.`id` REGEXP '^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$')) AS ok"
    );
  });

  test("MySQL asks every IDENTITY comparison of bytes, and the grammar of text", () => {
    // `utf8mb4_0900_ai_ci` is MySQL 8's default: a bare `=` there answers TRUE
    // for two values a BINARY(n) column holds as different bytes, which
    // certifies an estate whose foreign key names no parent after the
    // conversion. Measured on the project's container, where the unfolded
    // ksuid correlation answered `ok = 1` for a child holding a different
    // KSUID in a different case.
    const uuidChecks = checksFor(user, "id", "mysql");
    expect(uuidChecks[0]).toContain(
      "CAST(substr(p.`id`, 1, 4) AS BINARY) = 'usr-'"
    );
    expect(uuidChecks[1]).toBe(
      "SELECT COUNT(p.`id`) = COUNT(DISTINCT CAST(lower(substr(p.`id`, 5)) AS BINARY)) AS ok FROM `user` AS p"
    );
    expect(uuidChecks[3]).toContain(
      "WHERE CAST(lower(substr(p.`id`, 5)) AS BINARY) = CAST(lower(substr(c.`authorId`, 5)) AS BINARY)"
    );
    // The unfolded format is the one the collation actually broke.
    expect(checksFor(ticket, "id", "mysql")[2]).toContain(
      "WHERE CAST(p.`id` AS BINARY) = CAST(c.`ticketId` AS BINARY)"
    );
    // The grammar match is NOT cast: MySQL's REGEXP refuses a binary operand,
    // and every pattern here already spells both cases.
    expect(checksFor(ticket, "id", "mysql")[0]).toContain(
      "p.`id` REGEXP '^[0-9A-Za-z]{27}$'"
    );
  });

  test("PostgreSQL and SQLite compare the column itself, uncast", () => {
    // Both compare text by bytes already; a cast there would be a second
    // spelling of the same question and would break `citext` besides.
    expect(checksFor(user, "id", "postgresql").join("\n")).not.toContain(
      "CAST("
    );
    expect(checksFor(user, "id", "sqlite").join("\n")).not.toContain("CAST(");
  });

  test("SQLite has no REGEXP, so the grammar is spelled as a GLOB", () => {
    expect(checksFor(post, "id", "sqlite")[0]).toBe(
      `SELECT NOT EXISTS (SELECT 1 FROM "posts" AS p WHERE p."id" IS NOT NULL AND NOT (length(p."id") = 26 AND p."id" GLOB '[0-7]${"[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]".repeat(25)}')) AS ok`
    );
  });

  test("PostgreSQL qualifies the table with the bound namespace", () => {
    const [first] = identifierConversionChecks({
      schema,
      model: ticket,
      field: "id",
      dialect: "postgresql",
      namespace: "app",
    });

    expect(first?.query.toStatement("$n")).toContain(
      `FROM "app"."ticket" AS p`
    );
  });

  test("every check is one trusted read that must answer true", () => {
    for (const check of identifierConversionChecks({
      schema,
      model: user,
      field: "id",
      dialect: "postgresql",
    })) {
      expect(check.kind).toBe("trusted-read");
      expect(check.equals).toBe(true);
    }
  });

  test("a field with no compact domain is refused, not answered with silence", () => {
    expect(() => checksFor(user, "handle", "postgresql")).toThrow(
      MigrationError
    );
    expect(() => checksFor(profile, "id", "postgresql")).not.toThrow();
    expect(() => checksFor(user, "handle", "postgresql")).toThrow(
      NO_COMPACT_DOMAIN
    );
  });
});

/**
 * A reference the edge records in the other order.
 *
 * An edge's two endpoints are canonically ordered; whether the FOREIGN KEY's
 * owner is the first or the second of them is a fact about the schema, not
 * about the reference. Both orders have to find the same referencing column,
 * and the schema above only produces one of them.
 */
describe("identifier conversion pre-checks — the other endpoint order", () => {
  const aaTarget = s
    .model({
      id: s.string().id().uuid(),
      marks: s.toMany(() => zzOwner),
      // A junction edge beside the foreign key: its columns are private
      // storage with no (model, field), so it contributes nothing here — and
      // the walk has to pass over it rather than read `reference` off it.
      peers: s.toMany(() => zzOwner).name("peers"),
    })
    .map("aa_targets");
  const zzOwner = s
    .model({
      id: s.string().id(),
      targetId: s.string(),
      target: s
        .toOne(() => aaTarget)
        .fields("targetId")
        .references("id"),
      peers: s.toMany(() => aaTarget).name("peers"),
    })
    .map("zz_owners");
  const otherSchema = { aaTarget, zzOwner };

  test("the referencing column is found whichever end owns the key", () => {
    const checks = identifierConversionChecks({
      schema: otherSchema,
      model: aaTarget,
      field: "id",
      dialect: "postgresql",
    }).map((check) => rendered(check.query));

    expect(checks).toHaveLength(4);
    expect(checks[2]).toContain(`FROM "zz_owners" AS c`);
    expect(checks[3]).toContain(
      `NOT EXISTS (SELECT 1 FROM "aa_targets" AS p WHERE lower(p."id") = lower(c."targetId"))`
    );
  });
});
