// findFirst with an opaque rule spread into `where` and an include whose
// nested `where` is the client's own grant `where` type.
import type { Database } from "../db";
import {
  type Caller,
  firstRole,
  type HasMember,
  levelOf,
  may,
  roleHere,
  theirGrants,
} from "../rules";

export async function collectionFor(
  database: Pick<Database, "collection"> & HasMember,
  caller: Caller,
  which: string | { readonly id: string }
) {
  const found = await database.collection.findFirst({
    where: {
      ...(typeof which === "string" ? { name: which } : { id: which.id }),
      ...may.collection(caller, "view"),
    },
    include: { grants: theirGrants(caller), organization: roleHere(caller) },
  });
  if (!found) {
    return null;
  }
  const { grants, organization, ...collection } = found;
  return {
    collection,
    level: levelOf(caller, firstRole(organization), collection.ownerId, grants),
  };
}
