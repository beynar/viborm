/**
 * The RBAC acceptance test from the published package alone (plan §1.1 and
 * the M2 exit, §6.2: "§1.1 verbatim from the packed tarball").
 *
 * The consumer is a packed-package application (`packed-consumer.mjs`). It
 * holds the acceptance fixture's schema, seed and independent oracle
 * (`fixtures/rbac-app`, which import nothing of VibORM), and §1.1's
 * `policy.ts` (`tests/types/rbac/acceptance-policy.ts`) with its imports
 * spelled as a consumer spells them, `viborm/rbac` and `viborm/validation`;
 * this script refuses any other import, so the policy provably needs
 * nothing private.
 *
 *   A. TYPES — `tsc --strict` over the consumer, against the published
 *              declarations: the policy, the composed `server.ts` chain and
 *              the blog type-check; `$as` is the governed client again;
 *              `can` takes each model's own actions; the `@ts-expect-error`
 *              lines are needed.
 *   B. RUN   — Node runs the same files (type stripping) on SQLite3 in
 *              memory. `acceptance.ts` is §1.1's `server.ts`: the seed is
 *              loaded through the base client, the policy is applied with
 *              soft delete and an audit stamp (rows steps first, plan §11.2
 *              F6), and every commented line behaves as its comment says,
 *              with rows from the oracle. `blog.ts` is §1.1's eight-line blog
 *              on a schema of its own.
 *
 * Run after `pnpm package:build`. `VIBORM_PACKAGE_TARBALL` names an existing
 * tarball instead of packing one.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

const FIXTURE = join(
  repositoryRoot,
  "tests",
  "package",
  "fixtures",
  "rbac-app"
);
const IMPORT_SPECIFIER = /^import\b[^;]*?\bfrom\s*"([^"]+)"/gm;
const RELATIVE_IMPORT = /from "(\.\.?\/[^"]+)"/g;

/** The specifiers `source` imports. */
const importsOf = (source) =>
  [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]);

/** A fixture module whose relative imports Node can run: `./seed` is `./seed.ts`. */
const runnable = (source) =>
  source.replace(RELATIVE_IMPORT, (_, specifier) =>
    specifier.endsWith(".ts") ? `from "${specifier}"` : `from "${specifier}.ts"`
  );

/** §1.1's policy, its imports spelled as a consumer spells them. */
function consumerPolicy() {
  let source = readFileSync(
    join(repositoryRoot, "tests", "types", "rbac", "acceptance-policy.ts"),
    "utf8"
  );
  const published = new Map([
    ["@src/rbac", "viborm/rbac"],
    ["@src/validation", "viborm/validation"],
  ]);
  const specifiers = importsOf(source);
  const unexpected = specifiers.filter(
    (specifier) => !published.has(specifier)
  );
  if (unexpected.length > 0) {
    throw new Error(
      `acceptance-policy.ts must import only viborm/rbac and viborm/validation, found ${unexpected.join(", ")}`
    );
  }
  for (const [internal, spelled] of published) {
    source = source.replace(`"${internal}"`, `"${spelled}"`);
  }
  return source;
}

/** The fixture's schema, seed and oracle: VibORM's `s` only, nothing else. */
function fixtureFiles() {
  const files = {};
  const schema = join(FIXTURE, "schema");
  for (const name of readdirSync(schema).filter((file) => file.endsWith(".ts")))
    files[`schema/${name}`] = runnable(
      readFileSync(join(schema, name), "utf8")
    );
  for (const name of ["seed.ts", "oracle.ts"])
    files[name] = runnable(readFileSync(join(FIXTURE, name), "utf8"));
  for (const [file, source] of Object.entries(files)) {
    const foreign = importsOf(source).filter(
      (specifier) => !(specifier === "viborm" || specifier.startsWith("."))
    );
    if (foreign.length > 0)
      throw new Error(
        `fixtures/rbac-app/${file} must import only viborm and its siblings, found ${foreign.join(", ")}`
      );
  }
  return files;
}

/**
 * §1.1's `server.ts`, one check per commented line. Each line's expected
 * outcome is its comment in the plan; rows come from the oracle, never from
 * an engine result. A line that does not hold is reported, and the run fails
 * after every line has run, naming them all.
 */
const acceptance = `import assert from "node:assert/strict";
import {
  ClientInitializationError,
  defineExtension,
  ForbiddenError,
  NestedWriteError,
  NotFoundError,
  ValidationError,
} from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { softDelete } from "viborm/soft-delete";
import { createClient } from "viborm/sqlite3";
import { above, createOracle, type GovernedModel } from "./oracle.ts";
import { policy } from "./policy.ts";
import { schema } from "./schema/index.ts";
import { type Actor, actors, seed } from "./seed.ts";

// A delegate read through a string model name: the record of each line is
// what is checked, against the oracle.
type Loose = any;
const oracle = createOracle(seed);
const now = new Date();
const at = (actor: Actor, model: GovernedModel, action: string, options = {}) =>
  oracle.rows(actor, model, action, { now, ...options });

const base = createClient({ schema, dataDir: ":memory:" });
const loose: Loose = base;
const migrations = createMigrationClient(base);
const preview = await migrations.push({ dryRun: true });
await migrations.push({ consent: preview.consent });

// The seed, through the base client's public writes.
for (const model of [
  "organization", "user", "session", "apiKey", "member", "rolePermission",
  "team", "teamMember", "pageGroup", "page", "collection",
] as const)
  await loose[model].createMany({ data: seed[model] });
const parentsOf = new Map<string, string[]>();
for (const { childId, parentId } of seed.teamParent)
  parentsOf.set(childId, [...(parentsOf.get(childId) ?? []), parentId]);
for (const [childId, parentIds] of parentsOf)
  await loose.team.update({
    where: { id: childId },
    data: { parents: { connect: parentIds.map((id) => ({ id })) } },
  });
const parentOf = new Map(seed.document.map((d) => [d.id, d.parentId]));
const depthOf = (id: string) => {
  let depth = 1;
  for (let up = parentOf.get(id); up; up = parentOf.get(up)) depth += 1;
  return depth;
};
const byDepth = new Map<number, unknown[]>();
for (const row of seed.document)
  byDepth.set(depthOf(row.id), [...(byDepth.get(depthOf(row.id)) ?? []), row]);
for (const depth of [...byDepth.keys()].sort((a, b) => a - b))
  await loose.document.createMany({ data: byDepth.get(depth) });
await loose.accessGrant.createMany({ data: seed.accessGrant });
for (const { subjectType, subjectId, ...row } of seed.bookmark)
  await loose.bookmark.create({
    data:
      subjectType === null || subjectId === null
        ? row
        : { ...row, subject: { connect: { type: subjectType, where: { id: subjectId } } } },
  });

// server.ts
const tombstones = softDelete({
  models: Object.fromEntries(
    ["page", "member", "teamMember", "accessGrant"].map((m) => [m, { deletedAt: "deletedAt" }])
  ),
});
// §1.1 stamps \`updatedBy\`; the fixture's document has no such column, so
// the stamp writes \`searchKey\`, a string column (as W-C3 does).
const audit = defineExtension({
  name: "audit",
  data: { models: { document: { update: { searchKey: { control: "actor", path: "userId" } } } } },
});

const failures: string[] = [];
let lines = 0;
async function line(label: string, body: () => Promise<string | undefined>) {
  lines += 1;
  let failure: string | undefined;
  try {
    failure = await body();
  } catch (error) {
    failure = (error as Error).constructor.name + ": " + (error as Error).message;
  }
  if (failure !== undefined) failures.push(label + "\\n    " + failure.slice(0, 400));
}
/** The class of what \`body\` throws, or "ok". */
const outcome = async (body: () => Promise<unknown>) => {
  try {
    await body();
    return "ok";
  } catch (error) {
    return (error as Error).constructor.name;
  }
};
const ROLLBACK = new Error("rolled back");
/** The class of what \`body\` throws inside a transaction that rolls back, or "ok". */
const judged = async (call: Loose, body: (tx: Loose) => Promise<unknown>) => {
  try {
    await call.$transaction(async (tx: Loose) => {
      await body(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    return error === ROLLBACK ? "ok" : (error as Error).constructor.name;
  }
  return "ok";
};
const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
const differs = (got: unknown, expected: unknown) =>
  JSON.stringify(got) === JSON.stringify(expected)
    ? undefined
    : "got " + JSON.stringify(got).slice(0, 160) + ", expected " + JSON.stringify(expected).slice(0, 160);
/** The first row of \`model\` the actor holds at \`inside\` and not at \`outside\`. */
const pick = (actor: Actor, model: GovernedModel, inside: string, outside?: string) => {
  const outer = new Set(outside ? at(actor, model, outside) : []);
  return at(actor, model, inside).find((id) => !outer.has(id));
};
const READERS = ["u01", "u03", "u04", "u05", "u20", "u22", "u42", "u56"];
const KEYED = Object.keys(actors).filter((name) => actors[name]!.key !== undefined);

await line("policy(tombstones(base)).$extends(audit) is refused: every rows step goes first (§11.2 F6)", async () => {
  const got = await outcome(async () => policy(tombstones(base)).$extends(audit));
  return got === ClientInitializationError.name ? undefined : got;
});
const db: Loose = policy.methods(tombstones.methods(policy.rows(tombstones.rows(base)).$extends(audit)));

await line("page.findMany({ include: { group: true } }): pages the actor views; a hidden group reads null", async () => {
  for (const name of READERS) {
    const actor = actors[name]!;
    const pages = await db.$as(actor).page.findMany({ include: { group: true } });
    const failure = differs(ids(pages), at(actor, "page", "view"));
    if (failure) return name + ": " + failure;
    const groups = new Set(at(actor, "pageGroup", "view"));
    for (const page of pages)
      if ((page.group !== null) !== (page.groupId !== null && groups.has(page.groupId)))
        return name + ": page " + page.id + "'s group " + page.groupId;
  }
});

await line('page.findMany({ as: "given" }): given to me: P(view) ∧ given(view)', async () => {
  const wanted = above("page", "view");
  const below = (team: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(team)) return seen;
    seen.add(team);
    for (const edge of seed.teamParent) if (edge.parentId === team) below(edge.childId, seen);
    return seen;
  };
  let given = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const viewed = new Set(at(actor, "page", "view"));
    const names = (grant: (typeof seed.accessGrant)[number]) =>
      grant.userId === actor.userId ||
      grant.everyone ||
      (grant.granteeTeamId !== null &&
        seed.teamMember.some((tm) => tm.deletedAt === null && tm.userId === actor.userId && below(grant.granteeTeamId!).has(tm.teamId))) ||
      (grant.granteeRole !== null &&
        seed.member.some((m) => m.deletedAt === null && m.userId === actor.userId && m.organizationId === grant.organizationId && m.role === grant.granteeRole));
    const expected = [
      ...new Set(
        seed.accessGrant
          .filter(
            (grant) =>
              grant.deletedAt === null &&
              grant.pageId !== null &&
              viewed.has(grant.pageId) &&
              (grant.actions.some((a) => wanted.includes(a)) || (grant.level !== null && wanted.includes(grant.level))) &&
              names(grant)
          )
          .map((grant) => grant.pageId!)
      ),
    ].sort();
    given += expected.length;
    const failure = differs(ids(await db.$as(actor).page.findMany({ as: "given" })), expected);
    if (failure) return name + ": " + failure;
  }
  return given > 0 ? undefined : "no reader is given a page: the line proves nothing";
});

await line('page.findMany({ deleted: "with" }): tombstoned pages too; a tombstoned grant or membership still grants nothing', async () => {
  for (const name of READERS) {
    const actor = actors[name]!;
    const failure = differs(ids(await db.$as(actor).page.findMany({ deleted: "with" })), at(actor, "page", "view", { deleted: "with" }));
    if (failure) return name + ": " + failure;
  }
});

await line("document.findMany({ where: { parentId: null }, include: { $access: true, children: { include: { $access: true } } } })", async () => {
  const held = (row: Loose) =>
    Object.entries(row.$access ?? {}).filter(([, holds]) => holds === true).map(([action]) => action).sort();
  for (const name of READERS) {
    const actor = actors[name]!;
    const evidence = oracle.access(actor, "document", { now });
    const documents = await db.$as(actor).document.findMany({
      where: { parentId: null },
      include: { $access: true, children: { include: { $access: true } } },
    });
    for (const row of documents.flatMap((d: Loose) => [d, ...d.children])) {
      const failure = differs(held(row), [...(evidence.get(row.id) ?? [])].sort());
      if (failure) return name + " " + row.id + ": " + failure;
    }
  }
});

await line("page.update({ where: { id }, data: { title } }): edit; NotFoundError when not editable", async () => {
  let both = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const call = db.$as(actor);
    const editable = pick(actor, "page", "edit");
    const viewOnly = pick(actor, "page", "view", "edit");
    if (editable) {
      const got = await judged(call, (tx) => tx.page.update({ where: { id: editable }, data: { title: "t" } }));
      if (got !== "ok") return name + " " + editable + ": " + got;
    }
    if (viewOnly) {
      const got = await judged(call, (tx) => tx.page.update({ where: { id: viewOnly }, data: { title: "t" } }));
      if (got !== NotFoundError.name) return name + " " + viewOnly + ": " + got;
    }
    if (editable && viewOnly) both += 1;
  }
  return both > 0 ? undefined : "no reader has both an editable and a view-only page";
});

await line("page.update({ where: { id }, data: { ownerId } }): full; the new owner must be visible", async () => {
  let hidden = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const call = db.$as(actor);
    const full = pick(actor, "page", "full");
    const editOnly = pick(actor, "page", "edit", "full");
    if (editOnly) {
      const got = await judged(call, (tx) => tx.page.update({ where: { id: editOnly }, data: { ownerId: actor.userId } }));
      if (got !== NotFoundError.name) return name + " " + editOnly + " (edit, not full): " + got;
    }
    if (!full) continue;
    const row = seed.page.find((page) => page.id === full)!;
    const kept = oracle.produces(actor, "page", { ...row, ownerId: actor.userId }, ["ownerId"], ["full"], { now });
    const got = await judged(call, (tx) => tx.page.update({ where: { id: full }, data: { ownerId: actor.userId } }));
    if (got !== (kept ? "ok" : ForbiddenError.name)) return name + " " + full + " to the actor: " + got;
    const users = new Set(at(actor, "user", "view"));
    const stranger = seed.user.find((user) => !users.has(user.id));
    if (!stranger) continue;
    const refused = await judged(call, (tx) => tx.page.update({ where: { id: full }, data: { ownerId: stranger.id } }));
    if (refused !== ForbiddenError.name) return name + " " + full + " to hidden " + stranger.id + ": " + refused;
    hidden += 1;
  }
  return hidden > 0 ? undefined : "no reader holds full on a page and cannot see some user";
});

await line("page.update({ where: { id }, data: { groupId } }): edit on the page, the new group editable; else ForbiddenError", async () => {
  let refused = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const editable = pick(actor, "page", "edit");
    if (!editable) continue;
    const page = seed.page.find((row) => row.id === editable)!;
    const groups = new Set(at(actor, "pageGroup", "edit"));
    const target = seed.pageGroup.find((g) => g.organizationId === page.organizationId && g.id !== page.groupId && !groups.has(g.id));
    if (!target) continue;
    const got = await judged(db.$as(actor), (tx) => tx.page.update({ where: { id: editable }, data: { groupId: target.id } }));
    if (got !== ForbiddenError.name) return name + " " + editable + " into " + target.id + ": " + got;
    refused += 1;
  }
  return refused > 0 ? undefined : "no reader can edit a page and not some group of its organization";
});

await line("page.update({ where: { id }, data: { group: { connect: { id: hiddenGroup } } } }): NestedWriteError", async () => {
  let cases = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const editable = pick(actor, "page", "edit");
    const groups = new Set(at(actor, "pageGroup", "view"));
    const hidden = seed.pageGroup.find((g) => !groups.has(g.id));
    if (!(editable && hidden)) continue;
    const got = await judged(db.$as(actor), (tx) => tx.page.update({ where: { id: editable }, data: { group: { connect: { id: hidden.id } } } }));
    if (got !== NestedWriteError.name) return name + ": " + got;
    cases += 1;
  }
  return cases > 0 ? undefined : "no case";
});

await line("document.update({ where: { id }, data: { archivedAt: now } }): archive alone (audit's updatedBy takes no action)", async () => {
  let archivers = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const archiveOnly = pick(actor, "document", "archive", "edit");
    if (!archiveOnly) continue;
    const got = await judged(db.$as(actor), async (tx) => {
      await tx.document.update({ where: { id: archiveOnly }, data: { archivedAt: now } });
      const row = await tx.document.findUnique({ where: { id: archiveOnly }, select: { searchKey: true } });
      assert.equal(row?.searchKey, actor.userId);
    });
    if (got !== "ok") return name + " " + archiveOnly + ": " + got;
    archivers += 1;
  }
  return archivers > 0 ? undefined : "no reader may archive without editing";
});

await line("document.update({ where: { id }, data: { parentId: childId } }): ForbiddenError: a parent inside its own subtree", async () => {
  let cases = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const share = new Set(at(actor, "document", "share"));
    const child = seed.document.find((d) => d.parentId !== null && share.has(d.id) && share.has(d.parentId));
    if (!child) continue;
    const got = await judged(db.$as(actor), (tx) => tx.document.update({ where: { id: child.parentId }, data: { parentId: child.id } }));
    if (got !== ForbiddenError.name) return name + " " + child.parentId + " under " + child.id + ": " + got;
    cases += 1;
  }
  return cases > 0 ? undefined : "no reader shares a parent and its child";
});

await line('document.delete({ where: { id }, as: "edit" }): still judged at share: NotFoundError for an editor', async () => {
  let cases = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const editor = pick(actor, "document", "edit", "share");
    if (!editor) continue;
    const got = await judged(db.$as(actor), (tx) => tx.document.delete({ where: { id: editor }, as: "edit" }));
    if (got !== NotFoundError.name) return name + " " + editor + ": " + got;
    cases += 1;
  }
  return cases > 0 ? undefined : "no reader edits a document it cannot share";
});

await line("member.update({ where: { id }, data: { organizationId: otherOrg } }): ForbiddenError unless admin of both", async () => {
  let cases = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const editable = pick(actor, "member", "edit");
    if (!editable) continue;
    const row = seed.member.find((m) => m.id === editable)!;
    const runs = new Set(at(actor, "organization", "invite"));
    const other = seed.organization.find((o) => o.id !== row.organizationId && !runs.has(o.id));
    if (!other) continue;
    const got = await judged(db.$as(actor), (tx) => tx.member.update({ where: { id: editable }, data: { organizationId: other.id } }));
    if (got !== ForbiddenError.name) return name + " " + editable + " into " + other.id + ": " + got;
    cases += 1;
  }
  return cases > 0 ? undefined : "no case";
});

await line("page.create({ data: { title, organizationId, ownerId, groupId } }): ForbiddenError unless the group is editable and every key's target visible", async () => {
  let allowed = 0;
  let refused = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    for (const group of seed.pageGroup.filter((g) => g.organizationId === actor.organizationId).slice(0, 6)) {
      const data = { id: "new-" + name + "-" + group.id, title: "t", organizationId: group.organizationId, ownerId: actor.userId, groupId: group.id, position: 0 };
      const expected = oracle.places(actor, "page", { ...data, personal: false, deletedAt: null }, { now }) ? "ok" : ForbiddenError.name;
      const got = await judged(db.$as(actor), (tx) => tx.page.create({ data }));
      if (got !== expected) return name + " in " + group.id + ": " + got + ", expected " + expected;
      if (got === "ok") allowed += 1;
      else refused += 1;
    }
  }
  return allowed > 0 && refused > 0 ? undefined : "allowed " + allowed + ", refused " + refused;
});

await line('accessGrant.create({ data: { organizationId, documentId, userId: me, actions: ["export"] } }): ForbiddenError for a sharer without export', async () => {
  let cases = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const shared = pick(actor, "document", "share", "export");
    if (!shared) continue;
    const document = seed.document.find((d) => d.id === shared)!;
    const got = await judged(db.$as(actor), (tx) =>
      tx.accessGrant.create({ data: { id: "g-" + name, key: "g-" + name, organizationId: document.organizationId, documentId: shared, userId: actor.userId, actions: ["export"] } })
    );
    if (got !== ForbiddenError.name) return name + " " + shared + ": " + got;
    cases += 1;
  }
  return cases > 0 ? undefined : "no reader shares a document it cannot export";
});

await line('accessGrant.create({ data: { organizationId, pageId: myPage, groupId: theirGroup, userId: me, level: "full" } }): ForbiddenError', async () => {
  let cases = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const mine = pick(actor, "page", "full");
    if (!mine) continue;
    const page = seed.page.find((p) => p.id === mine)!;
    const held = new Set(at(actor, "pageGroup", "full"));
    const theirs = seed.pageGroup.find((g) => g.organizationId === page.organizationId && !held.has(g.id));
    if (!theirs) continue;
    const got = await judged(db.$as(actor), (tx) =>
      tx.accessGrant.create({ data: { id: "g2-" + name, key: "g2-" + name, organizationId: page.organizationId, pageId: mine, groupId: theirs.id, userId: actor.userId, level: "full", actions: [] } })
    );
    if (got !== ForbiddenError.name) return name + " " + mine + " and " + theirs.id + ": " + got;
    cases += 1;
  }
  return cases > 0 ? undefined : "no case";
});

await line("teamMember.create({ data: { teamId, userId } }): invite on the team; the user visible", async () => {
  let allowed = 0;
  let refused = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const users = at(actor, "user", "view");
    for (const team of seed.team.filter((t) => t.organizationId === actor.organizationId).slice(0, 4)) {
      const user = users.find((u) => !seed.teamMember.some((tm) => tm.teamId === team.id && tm.userId === u));
      if (!user) continue;
      const data = { teamId: team.id, userId: user };
      const expected = oracle.places(actor, "teamMember", { ...data, role: "member", deletedAt: null }, { now }) ? "ok" : ForbiddenError.name;
      const got = await judged(db.$as(actor), (tx) => tx.teamMember.create({ data }));
      if (got !== expected) return name + " " + team.id + " " + user + ": " + got + ", expected " + expected;
      if (got === "ok") allowed += 1;
      else refused += 1;
    }
  }
  return allowed > 0 && refused > 0 ? undefined : "allowed " + allowed + ", refused " + refused;
});

await line("team.update({ where: { id: myTeam }, data: { parents: { connect: { id: admins } } } }): NotFoundError for a lead", async () => {
  let cases = 0;
  for (const name of Object.keys(actors)) {
    const actor = actors[name]!;
    const lead = seed.teamMember.find((tm) => tm.userId === actor.userId && tm.role === "lead" && tm.deletedAt === null);
    if (!(lead && at(actor, "team", "view").includes(lead.teamId)) || at(actor, "team", "edit").includes(lead.teamId)) continue;
    const other = seed.team.find((t) => t.organizationId === actor.organizationId && t.id !== lead.teamId);
    if (!other) continue;
    const got = await judged(db.$as(actor), (tx) => tx.team.update({ where: { id: lead.teamId }, data: { parents: { connect: { id: other.id } } } }));
    if (got !== NotFoundError.name) return name + " " + lead.teamId + ": " + got;
    cases += 1;
  }
  return cases > 0 ? undefined : "no lead who is not an admin";
});

await line('team.can("invite", { id: teamId }): boolean, one statement', async () => {
  for (const name of READERS) {
    const actor = actors[name]!;
    const invite = new Set(at(actor, "team", "invite"));
    for (const team of seed.team) {
      const got = await db.$as(actor).team.can("invite", { id: team.id });
      if (got !== invite.has(team.id)) return name + " " + team.id + ": " + got;
    }
  }
});

await line('document.can(["comment", "edit", "share"], { id }): { comment, edit, share }, one statement', async () => {
  for (const name of READERS) {
    const actor = actors[name]!;
    const holds = (action: string) => new Set(at(actor, "document", action));
    const [comment, edit, share] = [holds("comment"), holds("edit"), holds("share")];
    for (const document of seed.document.slice(0, 20)) {
      const got = await db.$as(actor).document.can(["comment", "edit", "share"], { id: document.id });
      const failure = differs(got, { comment: comment.has(document.id), edit: edit.has(document.id), share: share.has(document.id) });
      if (failure) return name + " " + document.id + ": " + failure;
    }
  }
});

await line('organization.assert("export", { id: orgId }): ForbiddenError unless admin, plan pro, office network', async () => {
  let passed = 0;
  let refused = 0;
  for (const name of Object.keys(actors)) {
    const actor = actors[name]!;
    const exports = new Set(at(actor, "organization", "export"));
    for (const organization of seed.organization) {
      const got = await outcome(() => db.$as(actor).organization.assert("export", { id: organization.id }));
      const expected = exports.has(organization.id) ? "ok" : ForbiddenError.name;
      if (got !== expected) return name + " " + organization.id + ": " + got + ", expected " + expected;
      if (got === "ok") passed += 1;
      else refused += 1;
    }
  }
  return passed > 0 && refused > 0 ? undefined : "passed " + passed + ", refused " + refused;
});

await line("collection.findMany({ select: { id: true, budget: true } }): ValidationError if a returned row lacks full", async () => {
  let refused = 0;
  for (const name of READERS) {
    const actor = actors[name]!;
    const full = new Set(at(actor, "collection", "full"));
    const lacking = at(actor, "collection", "view").some((id) => !full.has(id));
    const got = await outcome(() => db.$as(actor).collection.findMany({ select: { id: true, budget: true } }));
    if (got !== (lacking ? ValidationError.name : "ok")) return name + ": " + got;
    if (lacking) refused += 1;
    // Without the explicit select, budget is present exactly where full holds.
    for (const row of await db.$as(actor).collection.findMany())
      if ("budget" in row !== full.has(row.id)) return name + " " + row.id + ": budget " + ("budget" in row ? "present" : "absent");
  }
  return refused > 0 ? undefined : "no reader views a collection without full";
});

await line('call.$queryRaw\\\`SELECT * FROM "page"\\\`: EVERY row: raw SQL is not filtered (§10)', async () => {
  const rows = await db.$as(actors.u05!).$queryRaw\`SELECT * FROM "page"\`;
  return differs(rows.length, seed.page.length);
});

const keyedAs = (actor: Actor) =>
  db.$as({ ...actor, session: undefined, key: { ...actor.key!, scopes: { page: ["view"] } } });
await line("keyed.page.findMany(): pages, if the key row is live (enabled, not expired)", async () => {
  for (const name of KEYED) {
    const actor = actors[name]!;
    const keyed = { ...actor, session: undefined, key: { ...actor.key!, scopes: { page: ["view"] } } };
    const failure = differs(ids(await keyedAs(actor).page.findMany()), at(keyed, "page", "view"));
    if (failure) return name + ": " + failure;
  }
  return KEYED.length > 0 ? undefined : "no key actor";
});
await line("keyed.page.create({ data: { title, organizationId, ownerId } }): ForbiddenError: the key does not hold edit (create)", async () => {
  for (const name of KEYED) {
    const actor = actors[name]!;
    const got = await judged(keyedAs(actor), (tx) =>
      tx.page.create({ data: { id: "k-" + name, title: "t", organizationId: actor.organizationId, ownerId: actor.userId, personal: true, position: 0 } })
    );
    if (got !== ForbiddenError.name) return name + ": " + got;
  }
});
await line("keyed.member.findMany(): []: member is not in the key's scopes", async () => {
  for (const name of KEYED) {
    const got = await keyedAs(actors[name]!).member.findMany();
    if (got.length !== 0) return name + ": " + got.length + " members";
  }
});
await line("db.page.findMany({ actor }): ValidationError: actor is bound only", async () => {
  const got = await outcome(() => db.page.findMany({ actor: actors.u01 }));
  return got === ValidationError.name ? undefined : got;
});
await line('db.page.findMany(): ValidationError: control "actor" is required', async () => {
  const got = await outcome(() => db.page.findMany());
  return got === ValidationError.name ? undefined : got;
});
await line("db.page.create({ data: { title, organizationId } }): ValidationError: required on creates too", async () => {
  const got = await outcome(() => db.page.create({ data: { title: "t", organizationId: "org-1", position: 0 } }));
  return got === ValidationError.name ? undefined : got;
});

await base.$disconnect();
assert.deepEqual(failures, [], lines - failures.length + "/" + lines + " §1.1 lines as commented; failing:\\n  " + failures.join("\\n  "));
console.log("rbac acceptance consumer: pass");
`;

/** §1.1's blog, verbatim, on a schema of its own: the author edits, an admin deletes. */
const blog = `import assert from "node:assert/strict";
import { ForbiddenError, NotFoundError, s, ValidationError } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { owner, rbac } from "viborm/rbac";
import { createClient } from "viborm/sqlite3";
import { v } from "viborm/validation";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s.toOne(() => user).fields("authorId").references("id"),
});
const base = createClient({ schema: { user, post }, dataDir: ":memory:" });
const migrations = createMigrationClient(base);
const preview = await migrations.push({ dryRun: true });
await migrations.push({ consent: preview.consent });
await base.user.createMany({ data: [{ id: "u1", name: "Ada" }, { id: "u2", name: "Grace" }] });
await base.post.createMany({ data: [{ id: "p1", title: "a", authorId: "u1" }, { id: "p2", title: "b", authorId: "u2" }] });

const blog = rbac({
  actor: v.object({ userId: v.string(), admin: v.boolean() }),   // \`admin\`: an identity-provider claim, not a row of this database
  models: {
    post: { view: {}, edit: owner("authorId"), delete: { actor: { admin: true } }, create: { authorId: { actor: "userId" } } },
    user: { view: {} },
  },
});
const session = { userId: "u1", admin: false };
const db = blog(base);
const call = blog(base).$as({ userId: session.userId, admin: session.admin });
const admin = db.$as({ userId: "u2", admin: true });

const outcome = async (body: () => Promise<unknown>) => {
  try {
    await body();
    return "ok";
  } catch (error) {
    return (error as Error).constructor.name;
  }
};
const titles = async () => (await base.post.findMany({ orderBy: { id: "asc" } })).map((p) => p.title);

assert.deepEqual((await call.post.findMany({ orderBy: { id: "asc" } })).map((p) => p.id), ["p1", "p2"]);
assert.equal((await call.post.update({ where: { id: "p1" }, data: { title: "a2" } })).title, "a2");
assert.equal(await outcome(() => call.post.update({ where: { id: "p2" }, data: { title: "x" } })), NotFoundError.name);
assert.deepEqual(await call.post.updateMany({ data: { title: "all" } }), { count: 1 });
assert.deepEqual(await titles(), ["all", "b"]);
assert.equal(await outcome(() => call.post.delete({ where: { id: "p1" } })), NotFoundError.name);
assert.equal(await outcome(() => call.post.create({ data: { id: "p3", title: "c", authorId: "u2" } })), ForbiddenError.name);
assert.equal((await call.post.create({ data: { id: "p3", title: "c", authorId: "u1" } })).authorId, "u1");
assert.equal(await call.post.can("edit", { id: "p1" }), true);
assert.equal(await call.post.can("edit", { id: "p2" }), false);
assert.equal(await outcome(() => call.post.assert("delete", { id: "p1" })), ForbiddenError.name);
assert.equal((await admin.post.delete({ where: { id: "p2" } })).id, "p2");
assert.equal(await outcome(() => db.post.findMany()), ValidationError.name);
assert.equal(await outcome(() => call.$as({ userId: 1 as never, admin: false }).post.findMany()), ValidationError.name);
assert.equal((await base.post.findMany()).length, 2);

// The governed view is the governed client again, and its answers take each model's actions.
export const same: typeof db = call;
export async function flagged() {
  // @ts-expect-error "publish" is not an action of post
  await call.post.can("publish", { id: "p1" });
  // @ts-expect-error the actor's userId is required
  db.$as({ admin: true });
}

await base.$disconnect();
console.log("rbac blog consumer: pass");
`;

const fixture = fixtureFiles();
const files = {
  "policy.ts": consumerPolicy(),
  "acceptance.ts": acceptance,
  "blog.ts": blog,
};
withPackedConsumer(
  "viborm-rbac-consumer",
  files,
  ({ typeCheck, run, root }) => {
    mkdirSync(join(root, "schema"));
    for (const [file, source] of Object.entries(fixture))
      writeFileSync(join(root, file), source);
    typeCheck(["blog.ts", "acceptance.ts"]);
    run("blog.ts", "rbac blog consumer");
    run("acceptance.ts", "rbac acceptance consumer");
  }
);
console.log("packed rbac consumer: §1.1 and the blog pass");
