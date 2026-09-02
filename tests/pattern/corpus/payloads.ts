/**
 * The corpus payloads (pattern-engine-ideal-state.md §13.3, unit A).
 *
 * A hand-authored, deterministic list of routed write operations over the
 * three corpus schemas. Every nested verb the operation schemas admit is
 * spelled on every storage kind that admits it, under each root operation
 * that admits it; the root bulk forms are spelled with and without relation
 * data (the latter route to a record series, ATOM §17); and a handful of
 * shapes whose REFUSAL is the contract are spelled with the `invalid:` prefix
 * so the summary test can see them.
 *
 * A payload's name is the golden file's stem: keep names stable, and add new
 * payloads at the end of their group rather than renaming existing ones.
 */
import type { DumpOptions } from "../harness/dump";
import type { SchemaName } from "./schemas";

export interface CorpusPayload {
  readonly name: string;
  readonly schema: SchemaName;
  readonly model: string;
  readonly operation: string;
  readonly args: Record<string, unknown>;
  readonly options?: DumpOptions;
}

/** A payload whose dump must be an error on every cell; the refusal is the contract. */
export const INVALID_PREFIX = "invalid:";

export function isInvalidPayload(payload: CorpusPayload): boolean {
  return payload.name.startsWith(INVALID_PREFIX);
}

const zoneKey = (region: string, code: string) => ({
  region_code: { region, code },
});

const fk = (
  name: string,
  model: string,
  operation: string,
  args: Record<string, unknown>,
  options?: DumpOptions
): CorpusPayload => ({ name, schema: "fk", model, operation, args, options });

const junction = (
  name: string,
  model: string,
  operation: string,
  args: Record<string, unknown>,
  options?: DumpOptions
): CorpusPayload => ({
  name,
  schema: "junction",
  model,
  operation,
  args,
  options,
});

const poly = (
  name: string,
  model: string,
  operation: string,
  args: Record<string, unknown>,
  options?: DumpOptions
): CorpusPayload => ({ name, schema: "poly", model, operation, args, options });

const keys = (
  name: string,
  model: string,
  operation: string,
  args: Record<string, unknown>,
  options?: DumpOptions
): CorpusPayload => ({ name, schema: "keys", model, operation, args, options });

// ---------------------------------------------------------------------------
// fk — root create
// ---------------------------------------------------------------------------

const fkCreate: readonly CorpusPayload[] = [
  fk("create:org:scalar", "org", "create", {
    data: { id: "o1", slug: "one", name: "One" },
    select: { id: true },
  }),
  fk("create:org:teams.create", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      teams: { create: [{ id: "t1", label: "A" }] },
    },
    select: { id: true },
  }),
  fk("create:org:teams.connect", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      teams: { connect: [{ id: "t1" }, { id: "t2" }] },
    },
    select: { id: true },
  }),
  fk("create:org:teams.connectOrCreate", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      teams: {
        connectOrCreate: [
          { where: { id: "t1" }, create: { id: "t1", label: "A" } },
        ],
      },
    },
    select: { id: true },
  }),
  fk("create:org:teams.createMany", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      teams: {
        createMany: {
          data: [
            { id: "t1", label: "A" },
            { id: "t2", label: "B" },
          ],
        },
      },
    },
    select: { id: true },
  }),
  fk("create:org:teams.createMany.skipDuplicates", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      teams: {
        createMany: {
          data: [{ id: "t1", label: "A" }],
          skipDuplicates: true,
        },
      },
    },
    select: { id: true },
  }),
  fk("create:org:profile.create", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      profile: { create: { id: "p1", bio: "bio" } },
    },
    select: { id: true },
  }),
  fk("create:org:profile.connect", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      profile: { connect: { id: "p1" } },
    },
    select: { id: true },
  }),
  fk("create:org:profile.connectOrCreate", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      profile: {
        connectOrCreate: {
          where: { id: "p1" },
          create: { id: "p1", bio: "bio" },
        },
      },
    },
    select: { id: true },
  }),
  fk("create:org:settings.create", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      settings: { create: { id: "s1", theme: "dark" } },
    },
    select: { id: true },
  }),
  fk("create:org:settings.connect", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      settings: { connect: { id: "s1" } },
    },
    select: { id: true },
  }),
  fk("create:team:org.create", "team", "create", {
    data: {
      id: "t1",
      label: "A",
      org: { create: { id: "o1", slug: "one", name: "One" } },
    },
    select: { id: true },
  }),
  fk("create:team:org.connect", "team", "create", {
    data: { id: "t1", label: "A", org: { connect: { id: "o1" } } },
    select: { id: true },
  }),
  fk("create:team:org.connect.by-slug", "team", "create", {
    data: { id: "t1", label: "A", org: { connect: { slug: "one" } } },
    select: { id: true },
  }),
  fk("create:team:org.connectOrCreate", "team", "create", {
    data: {
      id: "t1",
      label: "A",
      org: {
        connectOrCreate: {
          where: { slug: "one" },
          create: { id: "o1", slug: "one", name: "One" },
        },
      },
    },
    select: { id: true },
  }),
  fk("create:team:tickets.create", "team", "create", {
    data: {
      id: "t1",
      label: "A",
      tickets: { create: [{ title: "x" }, { title: "y" }] },
    },
    select: { id: true },
  }),
  fk("create:ticket:team.connect", "ticket", "create", {
    data: { title: "x", team: { connect: { id: "t1" } } },
    select: { id: true },
  }),
  fk("create:ticket:team.create", "ticket", "create", {
    data: { title: "x", team: { create: { id: "t1", label: "A" } } },
    select: { id: true },
  }),
  fk("create:zone:spots.create", "zone", "create", {
    data: {
      region: "r1",
      code: "z1",
      label: "Z",
      spots: { create: [{ id: "sp1", name: "one" }] },
    },
    select: { region: true, code: true },
  }),
  fk("create:zone:spots.connect", "zone", "create", {
    data: {
      region: "r1",
      code: "z1",
      label: "Z",
      spots: { connect: [{ id: "sp1" }] },
    },
    select: { region: true, code: true },
  }),
  fk("create:spot:zone.connect", "spot", "create", {
    data: { id: "sp1", name: "one", zone: { connect: zoneKey("r1", "z1") } },
    select: { id: true },
  }),
  fk("create:spot:zone.create", "spot", "create", {
    data: {
      id: "sp1",
      name: "one",
      zone: { create: { region: "r1", code: "z1", label: "Z" } },
    },
    select: { id: true },
  }),
  fk("create:org:deep", "org", "create", {
    data: {
      id: "o1",
      slug: "one",
      name: "One",
      teams: {
        create: [
          {
            id: "t1",
            label: "A",
            tickets: { create: [{ title: "x" }] },
          },
        ],
      },
      profile: { create: { id: "p1", bio: "bio" } },
    },
    select: { id: true, teams: { select: { id: true } } },
  }),
];

// ---------------------------------------------------------------------------
// fk — root update
// ---------------------------------------------------------------------------

const orgWhere = { where: { id: "o1" } };

const fkUpdate: readonly CorpusPayload[] = [
  fk("update:org:scalar", "org", "update", {
    ...orgWhere,
    data: { name: "Renamed" },
    select: { id: true },
  }),
  fk("update:org:where.slug", "org", "update", {
    where: { slug: "one" },
    data: { name: "Renamed" },
    select: { id: true, slug: true },
  }),
  fk("update:org:teams.create", "org", "update", {
    ...orgWhere,
    data: { teams: { create: [{ id: "t9", label: "Z" }] } },
    select: { id: true },
  }),
  fk("update:org:teams.connect", "org", "update", {
    ...orgWhere,
    data: { teams: { connect: [{ id: "t1" }, { id: "t2" }] } },
    select: { id: true },
  }),
  fk("update:org:teams.connectOrCreate", "org", "update", {
    ...orgWhere,
    data: {
      teams: {
        connectOrCreate: [
          { where: { id: "t1" }, create: { id: "t1", label: "A" } },
        ],
      },
    },
    select: { id: true },
  }),
  fk("update:org:teams.disconnect", "org", "update", {
    ...orgWhere,
    data: { teams: { disconnect: [{ id: "t1" }] } },
    select: { id: true },
  }),
  fk("update:org:teams.set", "org", "update", {
    ...orgWhere,
    data: { teams: { set: [{ id: "t1" }, { id: "t2" }] } },
    select: { id: true },
  }),
  fk("update:org:teams.set.empty", "org", "update", {
    ...orgWhere,
    data: { teams: { set: [] } },
    select: { id: true },
  }),
  fk("update:org:teams.delete", "org", "update", {
    ...orgWhere,
    data: { teams: { delete: [{ id: "t1" }] } },
    select: { id: true },
  }),
  fk("update:org:teams.update", "org", "update", {
    ...orgWhere,
    data: {
      teams: { update: [{ where: { id: "t1" }, data: { label: "B" } }] },
    },
    select: { id: true },
  }),
  fk("update:org:teams.upsert", "org", "update", {
    ...orgWhere,
    data: {
      teams: {
        upsert: [
          {
            where: { id: "t1" },
            create: { id: "t1", label: "A" },
            update: { label: "B" },
          },
        ],
      },
    },
    select: { id: true },
  }),
  fk("update:org:teams.updateMany", "org", "update", {
    ...orgWhere,
    data: {
      teams: { updateMany: [{ where: { label: "A" }, data: { label: "B" } }] },
    },
    select: { id: true },
  }),
  fk("update:org:teams.deleteMany", "org", "update", {
    ...orgWhere,
    data: { teams: { deleteMany: [{ label: "A" }] } },
    select: { id: true },
  }),
  fk("update:org:teams.createMany", "org", "update", {
    ...orgWhere,
    data: {
      teams: {
        createMany: {
          data: [
            { id: "t1", label: "A" },
            { id: "t2", label: "B" },
          ],
          skipDuplicates: true,
        },
      },
    },
    select: { id: true },
  }),
  // relation-bearing nested bulk forms: one nested RecordSeriesStep each (ATOM §17)
  fk("update:org:teams.createMany.relations", "org", "update", {
    ...orgWhere,
    data: {
      teams: {
        createMany: {
          data: [
            { id: "t1", label: "A", tickets: { create: [{ title: "x" }] } },
            { id: "t2", label: "B" },
          ],
        },
      },
    },
    select: { id: true },
  }),
  fk("update:org:teams.updateMany.relations", "org", "update", {
    ...orgWhere,
    data: {
      teams: {
        updateMany: [
          {
            where: { label: "A" },
            data: { label: "B", tickets: { create: [{ title: "x" }] } },
          },
        ],
      },
    },
    select: { id: true },
  }),
  fk("update:org:teams.update.nested-tickets", "org", "update", {
    ...orgWhere,
    data: {
      teams: {
        update: [
          {
            where: { id: "t1" },
            data: { tickets: { create: [{ title: "x" }] } },
          },
        ],
      },
    },
    select: { id: true },
  }),
  fk("update:org:profile.create", "org", "update", {
    ...orgWhere,
    data: { profile: { create: { id: "p1", bio: "bio" } } },
    select: { id: true },
  }),
  fk("update:org:profile.connect", "org", "update", {
    ...orgWhere,
    data: { profile: { connect: { id: "p1" } } },
    select: { id: true },
  }),
  fk("update:org:profile.connectOrCreate", "org", "update", {
    ...orgWhere,
    data: {
      profile: {
        connectOrCreate: {
          where: { id: "p1" },
          create: { id: "p1", bio: "bio" },
        },
      },
    },
    select: { id: true },
  }),
  fk("update:org:profile.disconnect", "org", "update", {
    ...orgWhere,
    data: { profile: { disconnect: true } },
    select: { id: true },
  }),
  fk("update:org:profile.delete", "org", "update", {
    ...orgWhere,
    data: { profile: { delete: true } },
    select: { id: true },
  }),
  fk("update:org:profile.update", "org", "update", {
    ...orgWhere,
    data: { profile: { update: { bio: "new" } } },
    select: { id: true },
  }),
  fk("update:org:profile.upsert", "org", "update", {
    ...orgWhere,
    data: {
      profile: {
        upsert: { create: { id: "p1", bio: "bio" }, update: { bio: "new" } },
      },
    },
    select: { id: true },
  }),
  fk("update:org:profile.disconnect+create", "org", "update", {
    ...orgWhere,
    data: { profile: { disconnect: true, create: { id: "p2", bio: "bio" } } },
    select: { id: true },
  }),
  fk("update:org:profile.delete+connect", "org", "update", {
    ...orgWhere,
    data: { profile: { delete: true, connect: { id: "p2" } } },
    select: { id: true },
  }),
  fk("update:org:settings.update", "org", "update", {
    ...orgWhere,
    data: { settings: { update: { theme: "light" } } },
    select: { id: true },
  }),
  fk("update:org:settings.connect", "org", "update", {
    ...orgWhere,
    data: { settings: { connect: { id: "s2" } } },
    select: { id: true },
  }),
  fk("update:org:settings.upsert", "org", "update", {
    ...orgWhere,
    data: {
      settings: {
        upsert: {
          create: { id: "s1", theme: "dark" },
          update: { theme: "light" },
        },
      },
    },
    select: { id: true },
  }),
  fk("update:team:org.connect", "team", "update", {
    where: { id: "t1" },
    data: { org: { connect: { id: "o2" } } },
    select: { id: true },
  }),
  fk("update:team:org.disconnect", "team", "update", {
    where: { id: "t1" },
    data: { org: { disconnect: true } },
    select: { id: true },
  }),
  fk("update:team:org.create", "team", "update", {
    where: { id: "t1" },
    data: { org: { create: { id: "o2", slug: "two", name: "Two" } } },
    select: { id: true },
  }),
  fk("update:team:org.connectOrCreate", "team", "update", {
    where: { id: "t1" },
    data: {
      org: {
        connectOrCreate: {
          where: { slug: "two" },
          create: { id: "o2", slug: "two", name: "Two" },
        },
      },
    },
    select: { id: true },
  }),
  fk("update:team:org.update", "team", "update", {
    where: { id: "t1" },
    data: { org: { update: { name: "Renamed" } } },
    select: { id: true },
  }),
  fk("update:team:org.upsert", "team", "update", {
    where: { id: "t1" },
    data: {
      org: {
        upsert: {
          create: { id: "o2", slug: "two", name: "Two" },
          update: { name: "Renamed" },
        },
      },
    },
    select: { id: true },
  }),
  fk("update:team:org.delete", "team", "update", {
    where: { id: "t1" },
    data: { org: { delete: true } },
    select: { id: true },
  }),
  fk("update:team:org.disconnect+connect", "team", "update", {
    where: { id: "t1" },
    data: { org: { disconnect: true, connect: { id: "o2" } } },
    select: { id: true },
  }),
  fk("update:ticket:team.connect", "ticket", "update", {
    where: { id: 7 },
    data: { team: { connect: { id: "t2" } } },
    select: { id: true },
  }),
  fk("update:ticket:team.update", "ticket", "update", {
    where: { id: 7 },
    data: { team: { update: { label: "B" } } },
    select: { id: true },
  }),
  fk("update:ticket:scalar", "ticket", "update", {
    where: { id: 7 },
    data: { title: "renamed" },
    select: { id: true, title: true },
  }),
  fk("update:org:pk-transition.cascade", "org", "update", {
    ...orgWhere,
    data: { id: "o2" },
    select: { id: true },
  }),
  fk("update:org:pk-transition.cascade+teams.create", "org", "update", {
    ...orgWhere,
    data: { id: "o2", teams: { create: [{ id: "t9", label: "Z" }] } },
    select: { id: true },
  }),
  fk("update:org:pk-transition.cascade+teams.connect", "org", "update", {
    ...orgWhere,
    data: { id: "o2", teams: { connect: [{ id: "t1" }] } },
    select: { id: true },
  }),
  fk("update:org:pk-transition.cascade+profile.connect", "org", "update", {
    ...orgWhere,
    data: { id: "o2", profile: { connect: { id: "p1" } } },
    select: { id: true },
  }),
  fk("update:zone:pk-transition.restrict", "zone", "update", {
    where: zoneKey("r1", "z1"),
    data: { code: "z2" },
    select: { region: true, code: true },
  }),
  fk("update:zone:pk-transition.restrict+spots.create", "zone", "update", {
    where: zoneKey("r1", "z1"),
    data: { code: "z2", spots: { create: [{ id: "sp9", name: "nine" }] } },
    select: { region: true, code: true },
  }),
  fk("update:zone:spots.connect", "zone", "update", {
    where: zoneKey("r1", "z1"),
    data: { spots: { connect: [{ id: "sp1" }] } },
    select: { region: true, code: true },
  }),
  fk("update:zone:spots.set", "zone", "update", {
    where: zoneKey("r1", "z1"),
    data: { spots: { set: [{ id: "sp1" }] } },
    select: { region: true, code: true },
  }),
  fk("update:zone:spots.updateMany", "zone", "update", {
    where: zoneKey("r1", "z1"),
    data: {
      spots: {
        updateMany: [{ where: { name: "one" }, data: { name: "uno" } }],
      },
    },
    select: { region: true, code: true },
  }),
  fk("update:zone:spots.deleteMany", "zone", "update", {
    where: zoneKey("r1", "z1"),
    data: { spots: { deleteMany: [{ name: "one" }] } },
    select: { region: true, code: true },
  }),
  fk("update:spot:zone.connect", "spot", "update", {
    where: { id: "sp1" },
    data: { zone: { connect: zoneKey("r1", "z2") } },
    select: { id: true },
  }),
  fk("update:spot:zone.disconnect", "spot", "update", {
    where: { id: "sp1" },
    data: { zone: { disconnect: true } },
    select: { id: true },
  }),
  fk("update:spot:zone.update", "spot", "update", {
    where: { id: "sp1" },
    data: { zone: { update: { label: "relabelled" } } },
    select: { id: true },
  }),
];

// ---------------------------------------------------------------------------
// fk — root upsert (both arms carry relation data)
// ---------------------------------------------------------------------------

const fkUpsert: readonly CorpusPayload[] = [
  fk("upsert:org:scalar", "org", "upsert", {
    ...orgWhere,
    create: { id: "o1", slug: "one", name: "One" },
    update: { name: "Renamed" },
    select: { id: true },
  }),
  fk("upsert:org:teams", "org", "upsert", {
    ...orgWhere,
    create: {
      id: "o1",
      slug: "one",
      name: "One",
      teams: { create: [{ id: "t1", label: "A" }] },
    },
    update: { teams: { connect: [{ id: "t2" }] } },
    select: { id: true },
  }),
  fk("upsert:org:profile", "org", "upsert", {
    ...orgWhere,
    create: {
      id: "o1",
      slug: "one",
      name: "One",
      profile: {
        connectOrCreate: {
          where: { id: "p1" },
          create: { id: "p1", bio: "bio" },
        },
      },
    },
    update: {
      profile: {
        upsert: { create: { id: "p1", bio: "bio" }, update: { bio: "new" } },
      },
    },
    select: { id: true },
  }),
  fk("upsert:team:org", "team", "upsert", {
    where: { id: "t1" },
    create: { id: "t1", label: "A", org: { connect: { id: "o1" } } },
    update: { org: { update: { name: "Renamed" } } },
    select: { id: true },
  }),
  fk("upsert:zone:spots", "zone", "upsert", {
    where: zoneKey("r1", "z1"),
    create: {
      region: "r1",
      code: "z1",
      label: "Z",
      spots: { create: [{ id: "sp1", name: "one" }] },
    },
    update: { spots: { set: [{ id: "sp1" }] } },
    select: { region: true, code: true },
  }),
  fk("upsert:org:where.slug", "org", "upsert", {
    where: { slug: "one" },
    create: { id: "o1", slug: "one", name: "One" },
    update: { name: "Renamed", teams: { deleteMany: [{ label: "A" }] } },
    select: { id: true },
  }),
];

// ---------------------------------------------------------------------------
// fk — root bulk forms and delete
// ---------------------------------------------------------------------------

const fkBulk: readonly CorpusPayload[] = [
  fk("createMany:org:scalar", "org", "createMany", {
    data: [
      { id: "o1", slug: "one", name: "One" },
      { id: "o2", slug: "two", name: "Two" },
    ],
  }),
  fk("createMany:org:scalar.skipDuplicates", "org", "createMany", {
    data: [
      { id: "o1", slug: "one", name: "One" },
      { id: "o2", slug: "two", name: "Two" },
    ],
    skipDuplicates: true,
  }),
  fk("createMany:org:scalar.select", "org", "createMany", {
    data: [
      { id: "o1", slug: "one", name: "One" },
      { id: "o2", slug: "two", name: "Two" },
    ],
    select: { id: true, name: true },
  }),
  fk("createMany:org:relations", "org", "createMany", {
    data: [
      {
        id: "o1",
        slug: "one",
        name: "One",
        teams: { create: [{ id: "t1", label: "A" }] },
      },
      {
        id: "o2",
        slug: "two",
        name: "Two",
        teams: { connect: [{ id: "t2" }] },
      },
    ],
  }),
  fk("createMany:org:relations.skipDuplicates", "org", "createMany", {
    data: [
      {
        id: "o1",
        slug: "one",
        name: "One",
        teams: { create: [{ id: "t1", label: "A" }] },
      },
    ],
    skipDuplicates: true,
  }),
  fk("createMany:org:relations.select", "org", "createMany", {
    data: [
      {
        id: "o1",
        slug: "one",
        name: "One",
        profile: { create: { id: "p1", bio: "bio" } },
      },
      { id: "o2", slug: "two", name: "Two" },
    ],
    select: { id: true, slug: true },
  }),
  fk("createMany:team:org.connect", "team", "createMany", {
    data: [
      { id: "t1", label: "A", org: { connect: { id: "o1" } } },
      { id: "t2", label: "B", org: { connect: { slug: "one" } } },
    ],
  }),
  fk("createMany:ticket:scalar", "ticket", "createMany", {
    data: [
      { title: "x", teamId: "t1" },
      { title: "y", teamId: "t1" },
    ],
  }),
  fk("createMany:ticket:scalar.select", "ticket", "createMany", {
    data: [{ title: "x", teamId: "t1" }],
    select: { id: true },
  }),
  fk("createMany:zone:scalar", "zone", "createMany", {
    data: [
      { region: "r1", code: "z1", label: "Z1" },
      { region: "r1", code: "z2", label: "Z2" },
    ],
    skipDuplicates: true,
  }),
  fk("updateMany:org:scalar", "org", "updateMany", {
    where: { name: { contains: "x" } },
    data: { name: "Renamed" },
  }),
  fk("updateMany:org:scalar.limit", "org", "updateMany", {
    where: { name: { contains: "x" } },
    data: { name: "Renamed" },
    limit: 5,
  }),
  fk("updateMany:org:scalar.select", "org", "updateMany", {
    where: { name: { contains: "x" } },
    data: { name: "Renamed" },
    select: { id: true, name: true },
  }),
  fk("updateMany:org:relations", "org", "updateMany", {
    where: { name: { contains: "x" } },
    data: { name: "Renamed", teams: { create: [{ id: "t9", label: "Z" }] } },
  }),
  fk("updateMany:org:relations.select", "org", "updateMany", {
    where: { name: { contains: "x" } },
    data: { teams: { create: [{ id: "t9", label: "Z" }] } },
    select: { id: true, name: true },
  }),
  fk("updateMany:org:relations.limit", "org", "updateMany", {
    where: { name: { contains: "x" } },
    data: { teams: { deleteMany: [{ label: "A" }] } },
    limit: 2,
  }),
  fk(
    "updateMany:org:relations.roots=2",
    "org",
    "updateMany",
    {
      where: { name: { contains: "x" } },
      data: { teams: { create: [{ id: "t9", label: "Z" }] } },
    },
    { capturedRoots: 2 }
  ),
  fk(
    "updateMany:org:teams.set.empty.roots=2",
    "org",
    "updateMany",
    {
      where: { name: { contains: "x" } },
      data: { teams: { set: [] } },
    },
    { capturedRoots: 2 }
  ),
  fk(
    "updateMany:team:org.connect.roots=2",
    "team",
    "updateMany",
    {
      where: { label: "A" },
      data: { org: { connect: { id: "o2" } } },
    },
    { capturedRoots: 2 }
  ),
  fk("updateMany:org:pk-transition+teams.create", "org", "updateMany", {
    where: { name: { contains: "x" } },
    data: { id: "o9", teams: { create: [{ id: "t9", label: "Z" }] } },
  }),
  fk("updateMany:org:profile.connect", "org", "updateMany", {
    where: { name: { contains: "x" } },
    data: { profile: { connect: { id: "p1" } } },
  }),
  fk("updateMany:zone:scalar", "zone", "updateMany", {
    where: { region: "r1" },
    data: { label: "Relabelled" },
  }),
  fk("deleteMany:org:scalar", "org", "deleteMany", {
    where: { name: { contains: "x" } },
  }),
  fk("deleteMany:org:relation-filter", "org", "deleteMany", {
    where: { teams: { some: { label: "A" } } },
  }),
  fk("deleteMany:org:all", "org", "deleteMany", {}),
  fk("deleteMany:zone:scalar", "zone", "deleteMany", {
    where: { region: "r1" },
    limit: 3,
  }),
  fk("delete:org", "org", "delete", {
    ...orgWhere,
    select: { id: true },
  }),
  fk("delete:org:where.slug", "org", "delete", {
    where: { slug: "one" },
    select: { id: true, slug: true },
  }),
  fk("delete:zone:compound", "zone", "delete", {
    where: zoneKey("r1", "z1"),
    select: { region: true, code: true },
  }),
  fk("delete:ticket:generated-key", "ticket", "delete", {
    where: { id: 7 },
    select: { id: true },
  }),
];

// ---------------------------------------------------------------------------
// junction
// ---------------------------------------------------------------------------

const studentWhere = { where: { id: "s1" } };

const junctionPayloads: readonly CorpusPayload[] = [
  junction("create:student:scalar", "student", "create", {
    data: { id: "s1", name: "S", email: "s@x" },
    select: { id: true },
  }),
  junction("create:student:courses.create", "student", "create", {
    data: {
      id: "s1",
      name: "S",
      email: "s@x",
      courses: { create: [{ id: "c1", title: "C", code: "C1" }] },
    },
    select: { id: true },
  }),
  junction("create:student:courses.connect", "student", "create", {
    data: {
      id: "s1",
      name: "S",
      email: "s@x",
      courses: { connect: [{ id: "c1" }, { code: "C2" }] },
    },
    select: { id: true },
  }),
  junction("create:student:courses.connectOrCreate", "student", "create", {
    data: {
      id: "s1",
      name: "S",
      email: "s@x",
      courses: {
        connectOrCreate: [
          {
            where: { code: "C1" },
            create: { id: "c1", title: "C", code: "C1" },
          },
        ],
      },
    },
    select: { id: true },
  }),
  junction("create:student:courses.createMany", "student", "create", {
    data: {
      id: "s1",
      name: "S",
      email: "s@x",
      courses: {
        createMany: {
          data: [
            { id: "c1", title: "C", code: "C1" },
            { id: "c2", title: "D", code: "C2" },
          ],
        },
      },
    },
    select: { id: true },
  }),
  junction(
    "create:student:courses.createMany.skipDuplicates",
    "student",
    "create",
    {
      data: {
        id: "s1",
        name: "S",
        email: "s@x",
        courses: {
          createMany: {
            data: [{ id: "c1", title: "C", code: "C1" }],
            skipDuplicates: true,
          },
        },
      },
      select: { id: true },
    }
  ),
  junction("update:student:courses.connect", "student", "update", {
    ...studentWhere,
    data: { courses: { connect: [{ id: "c1" }, { id: "c2" }] } },
    select: { id: true },
  }),
  junction("update:student:courses.disconnect", "student", "update", {
    ...studentWhere,
    data: { courses: { disconnect: [{ id: "c1" }] } },
    select: { id: true },
  }),
  junction("update:student:courses.set", "student", "update", {
    ...studentWhere,
    data: { courses: { set: [{ id: "c1" }, { code: "C2" }] } },
    select: { id: true },
  }),
  junction("update:student:courses.set.empty", "student", "update", {
    ...studentWhere,
    data: { courses: { set: [] } },
    select: { id: true },
  }),
  junction("update:student:courses.delete", "student", "update", {
    ...studentWhere,
    data: { courses: { delete: [{ id: "c1" }] } },
    select: { id: true },
  }),
  junction("update:student:courses.update", "student", "update", {
    ...studentWhere,
    data: {
      courses: { update: [{ where: { id: "c1" }, data: { title: "D" } }] },
    },
    select: { id: true },
  }),
  junction("update:student:courses.upsert", "student", "update", {
    ...studentWhere,
    data: {
      courses: {
        upsert: [
          {
            where: { id: "c1" },
            create: { id: "c1", title: "C", code: "C1" },
            update: { title: "D" },
          },
        ],
      },
    },
    select: { id: true },
  }),
  junction("update:student:courses.updateMany", "student", "update", {
    ...studentWhere,
    data: {
      courses: {
        updateMany: [{ where: { title: "C" }, data: { title: "D" } }],
      },
    },
    select: { id: true },
  }),
  junction("update:student:courses.deleteMany", "student", "update", {
    ...studentWhere,
    data: { courses: { deleteMany: [{ title: "C" }] } },
    select: { id: true },
  }),
  junction("update:student:courses.create", "student", "update", {
    ...studentWhere,
    data: { courses: { create: [{ id: "c9", title: "Z", code: "C9" }] } },
    select: { id: true },
  }),
  junction("update:student:courses.createMany", "student", "update", {
    ...studentWhere,
    data: {
      courses: {
        createMany: {
          data: [{ id: "c9", title: "Z", code: "C9" }],
          skipDuplicates: true,
        },
      },
    },
    select: { id: true },
  }),
  junction("update:student:courses.connectOrCreate", "student", "update", {
    ...studentWhere,
    data: {
      courses: {
        connectOrCreate: [
          {
            where: { code: "C1" },
            create: { id: "c1", title: "C", code: "C1" },
          },
        ],
      },
    },
    select: { id: true },
  }),
  junction("update:student:courses.mixed", "student", "update", {
    ...studentWhere,
    data: {
      name: "Renamed",
      courses: {
        disconnect: [{ id: "c1" }],
        connect: [{ id: "c2" }],
        create: [{ id: "c9", title: "Z", code: "C9" }],
      },
    },
    select: { id: true },
  }),
  junction("update:student:pk-transition", "student", "update", {
    ...studentWhere,
    data: { id: "s2" },
    select: { id: true },
  }),
  junction(
    "update:student:pk-transition+courses.connect",
    "student",
    "update",
    {
      ...studentWhere,
      data: { id: "s2", courses: { connect: [{ id: "c1" }] } },
      select: { id: true },
    }
  ),
  junction("upsert:student:courses", "student", "upsert", {
    ...studentWhere,
    create: {
      id: "s1",
      name: "S",
      email: "s@x",
      courses: { connect: [{ id: "c1" }] },
    },
    update: { courses: { set: [{ id: "c2" }] } },
    select: { id: true },
  }),
  junction(
    "updateMany:student:courses.connect.roots=2",
    "student",
    "updateMany",
    {
      where: { name: { contains: "x" } },
      data: { courses: { connect: [{ id: "c1" }] } },
    },
    { capturedRoots: 2 }
  ),
  junction("createMany:student:courses.connect", "student", "createMany", {
    data: [
      {
        id: "s1",
        name: "S",
        email: "s@x",
        courses: { connect: [{ id: "c1" }] },
      },
      { id: "s2", name: "T", email: "t@x" },
    ],
  }),
  junction("createMany:student:scalar", "student", "createMany", {
    data: [
      { id: "s1", name: "S", email: "s@x" },
      { id: "s2", name: "T", email: "t@x" },
    ],
  }),
  junction("delete:student", "student", "delete", {
    ...studentWhere,
    select: { id: true },
  }),
  junction("deleteMany:student:relation-filter", "student", "deleteMany", {
    where: { courses: { some: { code: "C1" } } },
  }),
];

// ---------------------------------------------------------------------------
// poly — row-held polymorphic reference (optional and required)
// ---------------------------------------------------------------------------

const commentWhere = { where: { id: 5 } };

const polyRowHeld: readonly CorpusPayload[] = [
  poly("create:comment:commentable.connect", "comment", "create", {
    data: {
      body: "b",
      commentable: { connect: { type: "post", where: { id: 1 } } },
    },
    select: { id: true },
  }),
  poly("create:comment:commentable.connect.by-slug", "comment", "create", {
    data: {
      body: "b",
      commentable: { connect: { type: "post", where: { slug: "one" } } },
    },
    select: { id: true },
  }),
  poly("create:comment:commentable.create", "comment", "create", {
    data: {
      body: "b",
      commentable: { create: { type: "video", data: { title: "V" } } },
    },
    select: { id: true },
  }),
  poly("create:comment:commentable.connectOrCreate", "comment", "create", {
    data: {
      body: "b",
      commentable: {
        connectOrCreate: {
          type: "post",
          where: { slug: "one" },
          create: { slug: "one", title: "P" },
        },
      },
    },
    select: { id: true },
  }),
  poly("create:comment:no-target", "comment", "create", {
    data: { body: "b" },
    select: { id: true },
  }),
  poly("create:spotlight:subject.connect", "spotlight", "create", {
    data: {
      id: "sl1",
      caption: "c",
      subject: { connect: { type: "video", where: { id: 2 } } },
    },
    select: { id: true },
  }),
  poly("create:spotlight:subject.create", "spotlight", "create", {
    data: {
      id: "sl1",
      caption: "c",
      subject: { create: { type: "post", data: { slug: "one", title: "P" } } },
    },
    select: { id: true },
  }),
  poly("create:post:comments.create", "post", "create", {
    data: {
      slug: "one",
      title: "P",
      comments: { create: [{ body: "a" }, { body: "b" }] },
    },
    select: { id: true },
  }),
  poly("create:post:comments.connect", "post", "create", {
    data: { slug: "one", title: "P", comments: { connect: [{ id: 5 }] } },
    select: { id: true },
  }),
  poly("create:post:spotlight.create", "post", "create", {
    data: {
      slug: "one",
      title: "P",
      spotlight: { create: { id: "sl1", caption: "c" } },
    },
    select: { id: true },
  }),
  poly("create:post:spotlight.connect", "post", "create", {
    data: { slug: "one", title: "P", spotlight: { connect: { id: "sl1" } } },
    select: { id: true },
  }),
  poly("update:comment:commentable.connect", "comment", "update", {
    ...commentWhere,
    data: { commentable: { connect: { type: "post", where: { id: 1 } } } },
    select: { id: true },
  }),
  poly(
    "update:comment:commentable.connect.switch-variant",
    "comment",
    "update",
    {
      ...commentWhere,
      data: {
        body: "moved",
        commentable: { connect: { type: "video", where: { id: 2 } } },
      },
      select: { id: true },
    }
  ),
  poly("update:comment:commentable.disconnect", "comment", "update", {
    ...commentWhere,
    data: { commentable: { disconnect: true } },
    select: { id: true },
  }),
  // `post` is the first declared variant: the harness's found world stores its
  // discriminator, so a typed delete on `post` takes the found arm.
  poly("update:comment:commentable.delete", "comment", "update", {
    ...commentWhere,
    data: { commentable: { delete: { type: "post" } } },
    select: { id: true },
  }),
  poly("update:comment:commentable.create", "comment", "update", {
    ...commentWhere,
    data: { commentable: { create: { type: "video", data: { title: "V" } } } },
    select: { id: true },
  }),
  poly("update:comment:commentable.connectOrCreate", "comment", "update", {
    ...commentWhere,
    data: {
      commentable: {
        connectOrCreate: {
          type: "post",
          where: { slug: "one" },
          create: { slug: "one", title: "P" },
        },
      },
    },
    select: { id: true },
  }),
  poly("update:comment:commentable.update", "comment", "update", {
    ...commentWhere,
    data: {
      commentable: {
        update: { type: "post", where: { title: "P" }, data: { title: "Q" } },
      },
    },
    select: { id: true },
  }),
  poly("update:comment:commentable.upsert", "comment", "update", {
    ...commentWhere,
    data: {
      commentable: {
        upsert: {
          type: "video",
          create: { title: "V" },
          update: { title: "W" },
        },
      },
    },
    select: { id: true },
  }),
  poly("update:spotlight:subject.connect", "spotlight", "update", {
    where: { id: "sl1" },
    data: { subject: { connect: { type: "post", where: { id: 1 } } } },
    select: { id: true },
  }),
  poly("update:spotlight:subject.update", "spotlight", "update", {
    where: { id: "sl1" },
    data: {
      subject: {
        update: { type: "post", where: { title: "P" }, data: { title: "Q" } },
      },
    },
    select: { id: true },
  }),
  poly("update:spotlight:subject.upsert", "spotlight", "update", {
    where: { id: "sl1" },
    data: {
      subject: {
        upsert: {
          type: "post",
          create: { slug: "one", title: "P" },
          update: { title: "Q" },
        },
      },
    },
    select: { id: true },
  }),
  poly("update:post:comments.connect", "post", "update", {
    where: { id: 1 },
    data: { comments: { connect: [{ id: 5 }] } },
    select: { id: true },
  }),
  poly("update:post:comments.disconnect", "post", "update", {
    where: { id: 1 },
    data: { comments: { disconnect: [{ id: 5 }] } },
    select: { id: true },
  }),
  poly("update:post:comments.set", "post", "update", {
    where: { id: 1 },
    data: { comments: { set: [{ id: 5 }, { id: 6 }] } },
    select: { id: true },
  }),
  poly("update:post:comments.delete", "post", "update", {
    where: { id: 1 },
    data: { comments: { delete: [{ id: 5 }] } },
    select: { id: true },
  }),
  poly("update:post:comments.update", "post", "update", {
    where: { id: 1 },
    data: { comments: { update: [{ where: { id: 5 }, data: { body: "x" } }] } },
    select: { id: true },
  }),
  poly("update:post:comments.upsert", "post", "update", {
    where: { id: 1 },
    data: {
      comments: {
        upsert: [
          { where: { id: 5 }, create: { body: "a" }, update: { body: "x" } },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:post:comments.updateMany", "post", "update", {
    where: { id: 1 },
    data: {
      comments: {
        updateMany: [
          { where: { body: { contains: "a" } }, data: { body: "x" } },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:post:comments.deleteMany", "post", "update", {
    where: { id: 1 },
    data: { comments: { deleteMany: [{ body: "x" }] } },
    select: { id: true },
  }),
  poly("update:post:comments.createMany", "post", "update", {
    where: { id: 1 },
    data: {
      comments: { createMany: { data: [{ body: "a" }, { body: "b" }] } },
    },
    select: { id: true },
  }),
  poly("update:post:comments.connectOrCreate", "post", "update", {
    where: { id: 1 },
    data: {
      comments: {
        connectOrCreate: [{ where: { id: 5 }, create: { body: "a" } }],
      },
    },
    select: { id: true },
  }),
  poly("update:post:spotlight.connect", "post", "update", {
    where: { id: 1 },
    data: { spotlight: { connect: { id: "sl2" } } },
    select: { id: true },
  }),
  poly("update:post:spotlight.update", "post", "update", {
    where: { id: 1 },
    data: { spotlight: { update: { caption: "d" } } },
    select: { id: true },
  }),
  poly("update:post:spotlight.delete", "post", "update", {
    where: { id: 1 },
    data: { spotlight: { delete: true } },
    select: { id: true },
  }),
  poly("update:post:spotlight.upsert", "post", "update", {
    where: { id: 1 },
    data: {
      spotlight: {
        upsert: {
          create: { id: "sl1", caption: "c" },
          update: { caption: "d" },
        },
      },
    },
    select: { id: true },
  }),
  poly("update:post:pk-transition+comments.create", "post", "update", {
    where: { id: 1 },
    data: { id: 11, comments: { create: [{ body: "a" }] } },
    select: { id: true },
  }),
  poly("upsert:comment:commentable", "comment", "upsert", {
    ...commentWhere,
    create: {
      body: "b",
      commentable: { connect: { type: "post", where: { id: 1 } } },
    },
    update: { commentable: { disconnect: true } },
    select: { id: true },
  }),
  poly("upsert:post:comments", "post", "upsert", {
    where: { slug: "one" },
    create: { slug: "one", title: "P", comments: { create: [{ body: "a" }] } },
    update: { comments: { deleteMany: [{ body: "x" }] } },
    select: { id: true },
  }),
  poly("createMany:comment:commentable.connect", "comment", "createMany", {
    data: [
      {
        body: "a",
        commentable: { connect: { type: "post", where: { id: 1 } } },
      },
      {
        body: "b",
        commentable: { connect: { type: "video", where: { id: 2 } } },
      },
      { body: "c" },
    ],
  }),
  poly(
    "createMany:comment:commentable.connect.skipDuplicates",
    "comment",
    "createMany",
    {
      data: [
        {
          body: "a",
          commentable: { connect: { type: "post", where: { id: 1 } } },
        },
      ],
      skipDuplicates: true,
    }
  ),
  poly(
    "createMany:comment:commentable.connect.select",
    "comment",
    "createMany",
    {
      data: [
        {
          body: "a",
          commentable: { connect: { type: "post", where: { id: 1 } } },
        },
      ],
      select: { id: true },
    }
  ),
  poly("createMany:comment:scalar", "comment", "createMany", {
    data: [{ body: "a" }, { body: "b" }],
  }),
  poly("updateMany:comment:commentable.connect", "comment", "updateMany", {
    where: { body: { contains: "a" } },
    data: { commentable: { connect: { type: "post", where: { id: 1 } } } },
  }),
  poly("updateMany:comment:commentable.disconnect", "comment", "updateMany", {
    where: { body: { contains: "a" } },
    data: { commentable: { disconnect: true } },
  }),
  poly("updateMany:post:comments.create", "post", "updateMany", {
    where: { title: { contains: "a" } },
    data: { comments: { create: [{ body: "a" }] } },
  }),
  poly("delete:comment", "comment", "delete", {
    ...commentWhere,
    select: { id: true },
  }),
  poly("delete:post:generated-key", "post", "delete", {
    where: { slug: "one" },
    select: { id: true },
  }),
];

// ---------------------------------------------------------------------------
// poly — collection with a plural and a singular inverse member
// ---------------------------------------------------------------------------

const shelfWhere = { where: { id: "sh1" } };
const postItem = { type: "post" as const, where: { id: 1 } };
const clipItem = { type: "clip" as const, where: { id: 3 } };

const polyCollection: readonly CorpusPayload[] = [
  poly("create:shelf:items.connect", "shelf", "create", {
    data: { id: "sh1", label: "L", items: { connect: [postItem, clipItem] } },
    select: { id: true },
  }),
  poly("create:shelf:items.create", "shelf", "create", {
    data: {
      id: "sh1",
      label: "L",
      items: {
        create: [
          { type: "post", data: { slug: "one", title: "P" } },
          { type: "clip", data: { id: 3, title: "C" } },
        ],
      },
    },
    select: { id: true },
  }),
  poly("create:shelf:items.connectOrCreate", "shelf", "create", {
    data: {
      id: "sh1",
      label: "L",
      items: {
        connectOrCreate: [
          {
            type: "post",
            where: { slug: "one" },
            create: { slug: "one", title: "P" },
          },
          { type: "clip", where: { id: 3 }, create: { id: 3, title: "C" } },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:shelf:items.connect", "shelf", "update", {
    ...shelfWhere,
    data: { items: { connect: [postItem, clipItem] } },
    select: { id: true },
  }),
  poly("update:shelf:items.connect.duplicate", "shelf", "update", {
    ...shelfWhere,
    data: { items: { connect: [clipItem, clipItem] } },
    select: { id: true },
  }),
  poly("update:shelf:items.disconnect", "shelf", "update", {
    ...shelfWhere,
    data: { items: { disconnect: [postItem, clipItem] } },
    select: { id: true },
  }),
  poly("update:shelf:items.set", "shelf", "update", {
    ...shelfWhere,
    data: { items: { set: [postItem, clipItem] } },
    select: { id: true },
  }),
  poly("update:shelf:items.set.empty", "shelf", "update", {
    ...shelfWhere,
    data: { items: { set: [] } },
    select: { id: true },
  }),
  poly("update:shelf:items.delete", "shelf", "update", {
    ...shelfWhere,
    data: { items: { delete: [postItem, clipItem] } },
    select: { id: true },
  }),
  poly("update:shelf:items.update", "shelf", "update", {
    ...shelfWhere,
    data: {
      items: {
        update: [
          { type: "post", where: { id: 1 }, data: { title: "Q" } },
          { type: "clip", where: { id: 3 }, data: { title: "D" } },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:shelf:items.upsert", "shelf", "update", {
    ...shelfWhere,
    data: {
      items: {
        upsert: [
          {
            type: "clip",
            where: { id: 3 },
            create: { id: 3, title: "C" },
            update: { title: "D" },
          },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:shelf:items.updateMany", "shelf", "update", {
    ...shelfWhere,
    data: {
      items: {
        updateMany: [
          { type: "post", where: { title: "P" }, data: { title: "Q" } },
          { type: "clip", data: { title: "D" } },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:shelf:items.deleteMany", "shelf", "update", {
    ...shelfWhere,
    data: { items: { deleteMany: [{ type: "post", where: {} }] } },
    select: { id: true },
  }),
  poly("update:shelf:items.create", "shelf", "update", {
    ...shelfWhere,
    data: {
      items: {
        create: [
          { type: "post", data: { slug: "one", title: "P" } },
          { type: "clip", data: { id: 3, title: "C" } },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:shelf:items.createMany", "shelf", "update", {
    ...shelfWhere,
    data: {
      items: {
        createMany: [
          {
            type: "clip",
            data: [
              { id: 3, title: "C" },
              { id: 4, title: "D" },
            ],
          },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:shelf:items.createMany.skipDuplicates", "shelf", "update", {
    ...shelfWhere,
    data: {
      items: {
        createMany: [
          {
            type: "post",
            skipDuplicates: true,
            data: [{ slug: "one", title: "P" }],
          },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:shelf:items.connectOrCreate", "shelf", "update", {
    ...shelfWhere,
    data: {
      items: {
        connectOrCreate: [
          { type: "clip", where: { id: 3 }, create: { id: 3, title: "C" } },
        ],
      },
    },
    select: { id: true },
  }),
  poly("update:shelf:items.mixed", "shelf", "update", {
    ...shelfWhere,
    data: {
      label: "M",
      items: { disconnect: [postItem], connect: [clipItem] },
    },
    select: { id: true },
  }),
  poly("upsert:shelf:items", "shelf", "upsert", {
    ...shelfWhere,
    create: { id: "sh1", label: "L", items: { connect: [clipItem] } },
    update: { items: { set: [postItem] } },
    select: { id: true },
  }),
  poly("createMany:shelf:items.connect", "shelf", "createMany", {
    data: [
      { id: "sh1", label: "L", items: { connect: [clipItem] } },
      { id: "sh2", label: "M" },
    ],
  }),
  poly("updateMany:shelf:items.connect", "shelf", "updateMany", {
    where: { label: "L" },
    data: { items: { connect: [postItem] } },
  }),
  poly("delete:shelf", "shelf", "delete", {
    ...shelfWhere,
    select: { id: true },
  }),
  // singular inverse member
  poly("create:clip:shelf.connect", "clip", "create", {
    data: { id: 3, title: "C", shelf: { connect: { id: "sh1" } } },
    select: { id: true },
  }),
  poly("create:clip:shelf.create", "clip", "create", {
    data: { id: 3, title: "C", shelf: { create: { id: "sh1", label: "L" } } },
    select: { id: true },
  }),
  poly("update:clip:shelf.connect", "clip", "update", {
    where: { id: 3 },
    data: { shelf: { connect: { id: "sh2" } } },
    select: { id: true },
  }),
  poly("update:clip:shelf.disconnect", "clip", "update", {
    where: { id: 3 },
    data: { shelf: { disconnect: true } },
    select: { id: true },
  }),
  poly("update:clip:shelf.create", "clip", "update", {
    where: { id: 3 },
    data: { shelf: { create: { id: "sh2", label: "M" } } },
    select: { id: true },
  }),
  poly("update:clip:shelf.connectOrCreate", "clip", "update", {
    where: { id: 3 },
    data: {
      shelf: {
        connectOrCreate: {
          where: { id: "sh2" },
          create: { id: "sh2", label: "M" },
        },
      },
    },
    select: { id: true },
  }),
  poly("update:clip:shelf.update", "clip", "update", {
    where: { id: 3 },
    data: { shelf: { update: { label: "N" } } },
    select: { id: true },
  }),
  poly("update:clip:shelf.upsert", "clip", "update", {
    where: { id: 3 },
    data: {
      shelf: {
        upsert: { create: { id: "sh2", label: "M" }, update: { label: "N" } },
      },
    },
    select: { id: true },
  }),
  poly("update:clip:shelf.delete", "clip", "update", {
    where: { id: 3 },
    data: { shelf: { delete: true } },
    select: { id: true },
  }),
  poly("update:clip:shelf.disconnect+create", "clip", "update", {
    where: { id: 3 },
    data: { shelf: { disconnect: true, create: { id: "sh2", label: "M" } } },
    select: { id: true },
  }),
  poly("upsert:clip:shelf", "clip", "upsert", {
    where: { id: 3 },
    create: { id: 3, title: "C", shelf: { connect: { id: "sh1" } } },
    update: { shelf: { connect: { id: "sh2" } } },
    select: { id: true },
  }),
  // plural inverse member
  poly("update:post:shelves.connect", "post", "update", {
    where: { id: 1 },
    data: { shelves: { connect: [{ id: "sh1" }] } },
    select: { id: true },
  }),
  poly("update:post:shelves.set", "post", "update", {
    where: { id: 1 },
    data: { shelves: { set: [{ id: "sh1" }] } },
    select: { id: true },
  }),
  poly("update:post:shelves.disconnect", "post", "update", {
    where: { id: 1 },
    data: { shelves: { disconnect: [{ id: "sh1" }] } },
    select: { id: true },
  }),
  poly("update:post:shelves.create", "post", "update", {
    where: { id: 1 },
    data: { shelves: { create: [{ id: "sh2", label: "M" }] } },
    select: { id: true },
  }),
  poly("update:post:shelves.updateMany", "post", "update", {
    where: { id: 1 },
    data: {
      shelves: { updateMany: [{ where: {}, data: { label: "Swept" } }] },
    },
    select: { id: true },
  }),
];

// ---------------------------------------------------------------------------
// keys — the key shapes the other schemas cannot spell
// ---------------------------------------------------------------------------

const keysPayloads: readonly CorpusPayload[] = [
  keys("create:reading:scalar", "reading", "create", {
    data: { id: 1.5, label: "one" },
    select: { id: true },
  }),
  // The shared-key edge, supplied by a `connect`: the record's own primary key
  // comes from the located row, which resolves to ONE value.
  keys("create:calibration:shared-key.connect", "calibration", "create", {
    data: { offset: "o", device: { connect: { id: 1 } } },
    select: { deviceId: true },
  }),
  keys("invalid:update:device:calibration.create", "device", "update", {
    where: { id: 1 },
    data: { calibration: { create: { offset: "o" } } },
    select: { id: true },
  }),
  keys("update:sample:reading.connect", "sample", "update", {
    where: { id: 1 },
    data: { reading: { connect: { id: 1.5 } } },
    select: { id: true },
  }),
  // A merge supplying the reference that IS this record's primary key. Today
  // ACCEPTS it — the target's write is ordered first and its returned key
  // read — so it is a valid payload; the shared-primary-key refusal fires only
  // where that value cannot be resolved, which is a substrate fact.
  keys(
    "create:calibration:shared-key.connectOrCreate",
    "calibration",
    "create",
    {
      data: {
        offset: "o",
        device: {
          connectOrCreate: {
            where: { id: 1 },
            create: { name: "D" },
          },
        },
      },
      select: { deviceId: true },
    }
  ),
];

// ---------------------------------------------------------------------------
// invalid — the refusal is the contract
// ---------------------------------------------------------------------------

const invalid: readonly CorpusPayload[] = [
  fk("invalid:update:org:teams.connect.empty-selector", "org", "update", {
    ...orgWhere,
    data: { teams: { connect: [{}] } },
    select: { id: true },
  }),
  fk("invalid:update:org:teams.connect.non-unique", "org", "update", {
    ...orgWhere,
    data: { teams: { connect: [{ label: "A" }] } },
    select: { id: true },
  }),
  fk("invalid:update:org:teams.disconnect.boolean", "org", "update", {
    ...orgWhere,
    data: { teams: { disconnect: true } },
    select: { id: true },
  }),
  fk("invalid:update:org:teams.update.no-where", "org", "update", {
    ...orgWhere,
    data: { teams: { update: [{ data: { label: "B" } }] } },
    select: { id: true },
  }),
  // own-write feedback: the nested connectOrCreate's decision read names the
  // root the enclosing create is writing (ATOM §13, "split these operations")
  fk(
    "invalid:create:org:teams.create.org.connectOrCreate.same-root",
    "org",
    "create",
    {
      data: {
        id: "o1",
        slug: "one",
        name: "One",
        teams: {
          create: [
            {
              id: "t1",
              label: "A",
              org: {
                connectOrCreate: {
                  where: { id: "o1" },
                  create: { id: "o1", slug: "one", name: "One" },
                },
              },
            },
          ],
        },
      },
      select: { id: true },
    }
  ),
  fk("invalid:update:org:settings.disconnect.required", "org", "update", {
    ...orgWhere,
    data: { settings: { disconnect: true } },
    select: { id: true },
  }),
  fk("invalid:update:ticket:team.disconnect.required", "ticket", "update", {
    where: { id: 7 },
    data: { team: { disconnect: true } },
    select: { id: true },
  }),
  fk("invalid:create:ticket:missing-required-team", "ticket", "create", {
    data: { title: "x" },
    select: { id: true },
  }),
  fk("invalid:create:org:unknown-field", "org", "create", {
    data: { id: "o1", slug: "one", name: "One", nope: 1 },
    select: { id: true },
  }),
  fk("invalid:create:zone:partial-compound-key", "zone", "create", {
    data: { region: "r1", label: "Z" },
    select: { region: true },
  }),
  fk("invalid:update:spot:zone.connect.partial-compound", "spot", "update", {
    where: { id: "sp1" },
    data: { zone: { connect: { region_code: { region: "r1" } } } },
    select: { id: true },
  }),
  // N>1 root child-held move under updateMany
  fk(
    "invalid:updateMany:org:profile.connect.roots=2",
    "org",
    "updateMany",
    {
      where: { name: { contains: "x" } },
      data: { profile: { connect: { id: "p1" } } },
    },
    { capturedRoots: 2 }
  ),
  fk(
    "invalid:updateMany:org:teams.set.roots=2",
    "org",
    "updateMany",
    {
      where: { name: { contains: "x" } },
      data: { teams: { set: [{ id: "t1" }] } },
    },
    { capturedRoots: 2 }
  ),
  // disconnect current on a junction: the plural junction has no "current"
  junction(
    "invalid:update:student:courses.disconnect.boolean",
    "student",
    "update",
    {
      ...studentWhere,
      data: { courses: { disconnect: true } },
      select: { id: true },
    }
  ),
  junction(
    "invalid:update:student:courses.connect.non-unique",
    "student",
    "update",
    {
      ...studentWhere,
      data: { courses: { connect: [{ title: "C" }] } },
      select: { id: true },
    }
  ),
  poly(
    "invalid:update:comment:commentable.connect.unknown-variant",
    "comment",
    "update",
    {
      ...commentWhere,
      data: {
        commentable: { connect: { type: "shelf", where: { id: "sh1" } } },
      },
      select: { id: true },
    }
  ),
  poly(
    "invalid:update:comment:commentable.connect.no-type",
    "comment",
    "update",
    {
      ...commentWhere,
      data: { commentable: { connect: { where: { id: 1 } } } },
      select: { id: true },
    }
  ),
  poly(
    "invalid:update:spotlight:subject.disconnect.required",
    "spotlight",
    "update",
    {
      where: { id: "sl1" },
      data: { subject: { disconnect: true } },
      select: { id: true },
    }
  ),
  poly(
    "invalid:updateMany:clip:shelf.connect.roots=2",
    "clip",
    "updateMany",
    {
      where: { title: { contains: "x" } },
      data: { shelf: { connect: { id: "sh1" } } },
    },
    { capturedRoots: 2 }
  ),
  // the row-held polymorphic membership is a single-target move too
  poly(
    "invalid:updateMany:comment:commentable.connect.roots=2",
    "comment",
    "updateMany",
    {
      where: { body: { contains: "a" } },
      data: { commentable: { connect: { type: "post", where: { id: 1 } } } },
    },
    { capturedRoots: 2 }
  ),
  poly(
    "invalid:update:shelf:items.connect.unknown-variant",
    "shelf",
    "update",
    {
      ...shelfWhere,
      data: { items: { connect: [{ type: "video", where: { id: 2 } }] } },
      select: { id: true },
    }
  ),
  // A float primary key: arithmetic on it is not portable (§19).
  keys("invalid:update:reading:pk-arithmetic", "reading", "update", {
    where: { id: 1.5 },
    data: { id: { increment: 1 } },
    select: { id: true },
  }),
  // The one non-literal spelling of a relation key: a numeric foreign key
  // written with `{ increment }` while its own relation is written.
  keys("invalid:update:sample:fk-non-literal", "sample", "update", {
    where: { id: 1 },
    data: {
      readingId: { increment: 1 },
      reading: { connect: { id: 1.5 } },
    },
    select: { id: true },
  }),
];

export const payloads: readonly CorpusPayload[] = [
  ...fkCreate,
  ...fkUpdate,
  ...fkUpsert,
  ...fkBulk,
  ...junctionPayloads,
  ...polyRowHeld,
  ...polyCollection,
  ...keysPayloads,
  ...invalid,
];

const names = new Set<string>();
for (const payload of payloads) {
  if (names.has(payload.name)) {
    throw new Error(`duplicate corpus payload name: ${payload.name}`);
  }
  names.add(payload.name);
}
