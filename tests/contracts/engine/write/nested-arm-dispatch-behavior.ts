import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { hydrateSchemaNames, s } from "@schema";

/**
 * E3 — the shared slice for the `RelationUpsertPart` arm-dispatch wave.
 *
 * One root (`org`) whose `teams` upsert is the MIDDLE level: its update arm is where
 * every grandchild kind is dispatched. The team carries one relation of every
 * direction, so the arm's per-kind loop is exercised across all three:
 *
 *  · `notes` — a child-held one-to-many referencing the team's own primary key (the
 *    direction the arm's parent value speaks for);
 *  · `owner` — a PARENT-HELD to-one (the team holds `ownerId`), whose identity folds
 *    into the team's own SET rather than a child edge;
 *  · `tags` — a many-to-many, whose membership is a junction row.
 *
 * `slug` gives every level a second unique, so the same payload can be spelled with a
 * LITERAL arm parent (`where: { id }`) or a PLANNED one (`where: { slug }`) — the two
 * provenances the arm's carve-outs divide on.
 */
export const armDispatchSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      name: s.string(),
      teams: s.toMany(() => team),
      codeNotes: s.toMany(() => note).name("orgCodeNotes"),
    })
    .map("e3_orgs");
  const team = s
    .model({
      id: s.string().id(),
      label: s.string(),
      slug: s.string().unique(),
      orgId: s.string().nullable(),
      org: s
        .toOne(() => org)
        .fields("orgId")
        .references("id")
        .onUpdate("cascade"),
      ownerId: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
      notes: s.toMany(() => note),
      tags: s.toMany(() => tag),
    })
    .map("e3_teams");
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      tagName: s.string().unique(),
      teamId: s.string().nullable(),
      team: s
        .toOne(() => team)
        .fields("teamId")
        .references("id"),
      orgCode: s.string().nullable(),
      codeOrg: s
        .toOne(() => org)
        .fields("orgCode")
        .references("code")
        .onUpdate("restrict")
        .name("orgCodeNotes"),
    })
    .map("e3_notes");
  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.toMany(() => team),
    })
    .map("e3_owners");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.toMany(() => team),
    })
    .map("e3_tags");
  const node = s
    .model({
      id: s.string().id(),
      label: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("tree"),
      children: s.toMany(() => node).name("tree"),
    })
    .map("e3_nodes");
  return { org, team, note, owner, tag, node };
})();

hydrateSchemaNames(armDispatchSchema);

/** A driver that records every statement it sends while `recording` is on. */
export class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
  }
}

/** The atomic-batch substrate: no transactions, one batch per operation. */
export class BatchOnlyRecordingPGliteDriver extends RecordingPGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

/**
 * The measured payload: `org.update` whose `teams` upsert arm carries `relations`.
 * `locator` picks the arm's parent provenance — `{ id: "t1" }` is the LITERAL arm
 * parent, `{ slug: "team-1" }` the PLANNED one (the probe's captured key).
 */
export function armUpdate(
  relations: Record<string, unknown>,
  locator: Record<string, unknown> = { id: "t1" },
  updateScalars: Record<string, unknown> = { label: "T1b" },
  rootScalars: Record<string, unknown> = {}
) {
  // The create arm's row must be spellable whichever unique names the arm: a locator
  // that names an ABSENT row takes the create branch, and its INSERT must collide with
  // nothing seeded — on the primary key OR on the `slug` unique. Derived from the
  // locator so the two spellings (`{ id }`, the literal arm parent; `{ slug }`, the
  // planned one) can carry the same payload.
  const fresh =
    typeof locator.id === "string" ? locator.id : String(locator.slug ?? "t1");
  return {
    where: { id: "o1" },
    data: {
      ...rootScalars,
      teams: {
        upsert: [
          {
            where: locator,
            create: {
              id: fresh,
              label: "T1",
              slug:
                typeof locator.slug === "string" ? locator.slug : `s-${fresh}`,
            },
            update: { ...updateScalars, ...relations },
          },
        ],
      },
    },
  };
}
