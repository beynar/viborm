/**
 * Hand-written K3 programs for unit F (pattern-engine-ideal-state.md §13.3:
 * "hand-written fragment fixtures with expected statement sequences and
 * outcomes under each injected fault").
 *
 * The SQL here is deliberately plain: the executors treat statements as
 * opaque, and the simulated driver never interprets them. What matters is the
 * structure — matches, premises, writes, boundaries, outputs.
 */
import { sql } from "@sql";
import type {
  BoundPremise,
  Fragment,
  Program,
} from "@src/query-engine/pattern/fragment";
import {
  type GuardStep,
  type ReadStep,
  ref,
  type TargetConstraintPin,
  type WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";

export const AUTHOR_PIN: TargetConstraintPin = {
  fields: ["email"],
  table: "sim_users",
  columns: ["email"],
  constraints: ["sim_users_email_key"],
};

export function findAuthor(id = "u1", required = true): ReadStep {
  return {
    id: "author.find",
    kind: "read",
    model: "user",
    statement: sql`SELECT "id" FROM "sim_users" WHERE "id" = ${id}`,
    outputs: {
      id: { kind: "firstRowField", field: "id", optional: !required },
    },
    ...(required
      ? {
          expects: {
            kind: "exactlyOneRow" as const,
            failure: {
              kind: "nestedWrite" as const,
              message: "connect target 'author' was not found",
              relation: "author",
              raceable: false,
            },
          },
        }
      : {}),
  };
}

export function updatePost(postId = "p1"): WriteStep {
  return {
    id: "post.update",
    kind: "write",
    model: "post",
    statement: sql`UPDATE "sim_posts" SET "author_id" = ${ref("author.find", "id")} WHERE "id" = ${postId}`,
    outputs: { count: { kind: "rowCount" } },
    expects: {
      kind: "affectedRows",
      expected: 1,
      failure: {
        kind: "notFound",
        message: "post not found",
        raceable: false,
      },
    },
  };
}

export function existsPremise(
  match: ReadStep,
  guard?: GuardStep
): BoundPremise {
  return {
    premise: { kind: "exists", row: 1, raceable: false },
    match,
    ...(guard ? { guard } : {}),
  };
}

export function program(
  fragments: readonly Fragment[],
  outputs: Program["outputs"],
  attribution: { model?: string; operation?: string } = {}
): Program {
  return {
    fragments,
    outputs,
    model: attribution.model ?? "post",
    operation: attribution.operation ?? "update",
  };
}

/** `post.update({ where: {id}, data: { author: { connect: {id} } } })`. */
export function connectProgram(
  options: { explicitGuard?: GuardStep } = {}
): Program {
  const match = findAuthor();
  return program(
    [
      {
        matches: [[match]],
        writes: [updatePost()],
        premises: [existsPremise(match, options.explicitGuard)],
        inherited: [],
        boundary: { kind: "end" },
      },
    ],
    { result: "post.update" }
  );
}

/** Two independent matches at one level, a third depending on the first. */
export function levelledProgram(): Program {
  const author = findAuthor();
  const tag: ReadStep = {
    id: "tag.find",
    kind: "read",
    model: "tag",
    statement: sql`SELECT "id" FROM "sim_tags" WHERE "label" = ${"news"}`,
    outputs: { id: { kind: "firstRowField", field: "id" } },
  };
  const profile: ReadStep = {
    id: "profile.find",
    kind: "read",
    model: "profile",
    statement: sql`SELECT "id" FROM "sim_profiles" WHERE "user_id" = ${ref("author.find", "id")}`,
    outputs: { id: { kind: "firstRowField", field: "id" } },
  };
  const link: WriteStep = {
    id: "post.tag",
    kind: "write",
    model: "post",
    statement: sql`INSERT INTO "sim_post_tags" ("post_id", "tag_id", "profile_id") VALUES (${"p1"}, ${ref("tag.find", "id")}, ${ref("profile.find", "id")})`,
    outputs: { count: { kind: "rowCount" } },
  };
  return program(
    [
      {
        matches: [[author, tag], [profile]],
        writes: [updatePost(), link],
        premises: [existsPremise(author), existsPremise(tag)],
        inherited: [],
        boundary: { kind: "end" },
      },
    ],
    { result: "post.update", links: "post.tag" }
  );
}

/** One plain statement: the statement-atomic seam. */
export function singleStatementProgram(): Program {
  const write: WriteStep = {
    id: "post.title",
    kind: "write",
    model: "post",
    statement: sql`UPDATE "sim_posts" SET "title" = ${"t"} WHERE "id" = ${"p1"}`,
    outputs: { count: { kind: "rowCount" } },
  };
  return program(
    [
      {
        matches: [],
        writes: [write],
        premises: [],
        inherited: [],
        boundary: { kind: "end" },
      },
    ],
    { result: "post.title" }
  );
}

/**
 * A merge at the root (`upsert` / `connectOrCreate`), as the engine would
 * schedule it after the match phase decided the arm: the missing arm inserts
 * with the pin riding the write; the found arm updates the matched row.
 */
export function mergeProgram(arm: "missing" | "found"): Program {
  const probe = findAuthor("u1", false);
  const insert: WriteStep = {
    id: "author.create",
    kind: "write",
    model: "user",
    statement: sql`INSERT INTO "sim_users" ("id", "email") VALUES (${"u1"}, ${"a@b"})`,
    outputs: { count: { kind: "rowCount" } },
    racePin: AUTHOR_PIN,
  };
  const update: WriteStep = {
    id: "author.update",
    kind: "write",
    model: "user",
    statement: sql`UPDATE "sim_users" SET "email" = ${"a@b"} WHERE "id" = ${ref("author.find", "id")}`,
    outputs: { count: { kind: "rowCount" } },
  };
  return program(
    [
      {
        matches: [[probe]],
        writes: [arm === "missing" ? insert : update],
        premises: [
          arm === "missing"
            ? {
                premise: {
                  kind: "notExists",
                  row: 1,
                  raceable: true,
                  pin: AUTHOR_PIN,
                },
                match: probe,
              }
            : existsPremise(probe),
        ],
        inherited: [],
        boundary: { kind: "end" },
      },
    ],
    { result: arm === "missing" ? "author.create" : "author.update" },
    { model: "user", operation: "upsert" }
  );
}

/** A merge whose outcome governs a dependent subtree (`skipDuplicates` beside relation data). */
export function mergeOutcomeProgram(): Program {
  const root: WriteStep = {
    id: "user.create",
    kind: "write",
    model: "user",
    statement: sql`INSERT INTO "sim_users" ("id") VALUES (${"u9"}) ON CONFLICT DO NOTHING`,
    outputs: { count: { kind: "rowCount" } },
  };
  const child: WriteStep = {
    id: "post.create",
    kind: "write",
    model: "post",
    statement: sql`INSERT INTO "sim_posts" ("id", "author_id") VALUES (${"p9"}, ${"u9"})`,
    outputs: { count: { kind: "rowCount" } },
  };
  const tail: WriteStep = {
    id: "audit.create",
    kind: "write",
    statement: sql`INSERT INTO "sim_audit" ("what") VALUES (${"done"})`,
    outputs: { count: { kind: "rowCount" } },
  };
  return program(
    [
      {
        matches: [],
        writes: [root],
        premises: [],
        inherited: [],
        boundary: { kind: "mergeOutcome", row: 0 },
      },
      {
        matches: [],
        writes: [child],
        premises: [],
        inherited: [],
        // A dependent of the merge root; the group runs on to the next
        // member/end boundary.
        boundary: {
          kind: "executionBinding",
          variable: 0,
          statement: "post.create",
        },
      },
      {
        matches: [],
        writes: [tail],
        premises: [],
        inherited: [],
        boundary: { kind: "end" },
      },
    ],
    { root: "user.create", child: "post.create", tail: "audit.create" },
    { model: "user", operation: "createMany" }
  );
}

/**
 * A bulk write with relation payloads: a capture, then three members each
 * observing the previous one, every member re-asserting the parent's liveness
 * (the inherited premise). The parent's key is bound by the capture.
 */
export function memberedProgram(members = 3): Program {
  const capture: ReadStep = {
    id: "parent.capture",
    kind: "read",
    model: "user",
    statement: sql`SELECT "id" FROM "sim_users" WHERE "id" = ${"u1"}`,
    outputs: { id: { kind: "firstRowField", field: "id" } },
    expects: {
      kind: "exactlyOneRow",
      failure: { kind: "notFound", message: "parent gone", raceable: false },
    },
  };
  const liveness: BoundPremise = {
    premise: { kind: "exists", row: 0, raceable: false },
    match: capture,
  };
  const fragments: Fragment[] = [
    {
      matches: [[capture]],
      writes: [],
      premises: [],
      inherited: [],
      boundary: { kind: "member", index: 0 },
    },
  ];
  const outputs: string[] = [];
  for (let index = 0; index < members; index += 1) {
    const write: WriteStep = {
      id: `member#${index}.create`,
      kind: "write",
      model: "post",
      statement: sql`INSERT INTO "sim_posts" ("id", "author_id") VALUES (${`p${index}`}, ${ref("parent.capture", "id")})`,
      outputs: { count: { kind: "rowCount" } },
    };
    outputs.push(write.id);
    fragments.push({
      matches: [],
      writes: [write],
      premises: [],
      inherited: [liveness],
      boundary:
        index === members - 1
          ? { kind: "end" }
          : { kind: "member", index: index + 1 },
    });
  }
  return program(
    fragments,
    { result: outputs },
    { model: "user", operation: "update" }
  );
}

/**
 * A member program whose member `raceAt` inserts under a pin: the race test
 * for the current-member retry after a committed prefix.
 */
export function pinnedMemberProgram(raceAt: number, members = 2): Program {
  const base = memberedProgram(members);
  const fragments = base.fragments.map((fragment, index) => {
    if (index !== raceAt + 1) return fragment;
    const [write] = fragment.writes;
    if (write?.kind !== "write") return fragment;
    return { ...fragment, writes: [{ ...write, racePin: AUTHOR_PIN }] };
  });
  return { ...base, fragments };
}
