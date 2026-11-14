/** The schema the opt-ins page's blocks read: a folder tree, pages, teams. */
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";

export const folder = s.model({
  id: s.string().id(),
  name: s.string(),
  parentId: s.string().nullable(),
  parent: s.toOne(() => folder).fields("parentId").references("id"),
  children: s.toMany(() => folder),
});
export const team = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  parent: s.toOne(() => team).fields("parentId").references("id"),
  children: s.toMany(() => team),
  members: s.toMany(() => teamMember),
  grants: s.toMany(() => grant),
});
export const teamMember = s
  .model({
    teamId: s.string(),
    team: s.toOne(() => team).fields("teamId").references("id"),
    userId: s.string(),
  })
  .id(["teamId", "userId"]);
export const page = s.model({
  id: s.string().id(),
  title: s.string(),
  grants: s.toMany(() => grant),
});
export const grant = s.model({
  id: s.string().id(),
  level: s.enum(["read", "full"]),
  pageId: s.string(),
  page: s.toOne(() => page).fields("pageId").references("id"),
  teamId: s.string(),
  team: s.toOne(() => team).fields("teamId").references("id"),
});
export const client = createClient({
  schema: { folder, team, teamMember, page, grant },
});
