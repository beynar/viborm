/** Every model the permissions page's sections name, in one schema. */
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";

export const user = s.model({
  id: s.string().id(),
  name: s.string(),
  admin: s.boolean().default(false),
  posts: s.toMany(() => post),
});
export const post = s.model({
  id: s.string().id(),
  title: s.string(),
  published: s.boolean().default(false),
  organizationId: s.string().nullable(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
export const organization = s.model({
  id: s.string().id(),
  name: s.string(),
  members: s.toMany(() => member),
  projects: s.toMany(() => project),
  documents: s.toMany(() => document),
});
export const member = s
  .model({
    organizationId: s.string(),
    organization: s
      .toOne(() => organization)
      .fields("organizationId")
      .references("id"),
    userId: s.string(),
    role: s.enum(["admin", "member", "reader"]),
  })
  .id(["organizationId", "userId"]);
export const project = s.model({
  id: s.string().id(),
  name: s.string(),
  organizationId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
  ownerId: s.string(),
  grants: s.toMany(() => accessGrant),
});
export const accessGrant = s.model({
  id: s.string().id(),
  projectId: s.string().nullable(),
  project: s
    .toOne(() => project)
    .fields("projectId")
    .references("id"),
  documentId: s.string().nullable(),
  document: s
    .toOne(() => document)
    .fields("documentId")
    .references("id"),
  teamId: s.string().nullable(),
  team: s
    .toOne(() => team)
    .fields("teamId")
    .references("id"),
  userId: s.string().nullable(),
  everyone: s.boolean().default(false),
  level: s.enum(["read", "update", "full"]),
});
export const document = s.model({
  id: s.string().id(),
  title: s.string(),
  organizationId: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationId")
    .references("id"),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => document)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => document),
  ownerId: s.string(),
  deletedAt: s.dateTime().nullable(),
  grants: s.toMany(() => accessGrant),
});
export const team = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => team)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => team),
  members: s.toMany(() => teamMember),
  grants: s.toMany(() => accessGrant),
});
export const teamMember = s
  .model({
    teamId: s.string(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id"),
    userId: s.string(),
  })
  .id(["teamId", "userId"]);

export const doc = s.model({
  id: s.string().id(),
  status: s.string(),
  ownerId: s.string(),
});

export const schema = {
  doc,
  user,
  post,
  organization,
  member,
  project,
  accessGrant,
  document,
  team,
  teamMember,
};
export const base = createClient({ schema });
