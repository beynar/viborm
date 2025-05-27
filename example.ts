import { s } from "baseorm";

const user = s.model("user", {
  id: s.string().id().auto.ulid(),
  name: s.string(),
  email: s.string(),
  password: s.string(),
  friends: s.relation.many(() => user),
  lover: s.relation
    .one(() => user)
    .on("id")
    .ref("id"),
});
