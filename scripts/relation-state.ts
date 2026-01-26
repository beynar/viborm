import {
  GetInverseRelationFields,
  getInverseRelationFields,
} from "@schema/relation/types";
import { s } from "../src/schema";

const postsOneToManyOne = s.oneToMany(() => post).name("one");
const postsOneToManyTwo = s.oneToMany(() => post).name("two");

const user = s.model({
  id: s.string().id(),
  posts: postsOneToManyOne,
  authored: postsOneToManyTwo,
});

const post = s.model({
  id: s.string().id(),
  authorId: s.string(),
  co_authorId: s.string(),
  author: s
    .manyToOne(() => user)
    .fields("authorId")
    .references("id")
    .name("one"),
  co_author: s
    .manyToOne(() => user)
    .fields("co_authorId")
    .references("id")
    .name("two"),
});

const inverseOne = getInverseRelationFields(
  postsOneToManyOne["~"]["state"],
  user,
);
type InverseOne = GetInverseRelationFields<
  (typeof postsOneToManyOne)["~"]["state"],
  typeof user
>;

console.log("Found inverse relation:", inverseOne);
console.log('Expected: ["authorId"]');

const inverseTwo = getInverseRelationFields(
  postsOneToManyTwo["~"]["state"],
  user,
);
type InverseTwo = GetInverseRelationFields<
  (typeof postsOneToManyTwo)["~"]["state"],
  typeof user
>;

console.log("Found inverse relation:", inverseTwo);
console.log('Expected: ["co_authorId"]');
