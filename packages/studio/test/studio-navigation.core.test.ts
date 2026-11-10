import { expect, test } from "vitest";
import { legacyPath } from "../ui/src/lib/legacy-url";
import { readScope } from "../ui/src/lib/route-scope";

test.each([
  ["/#/schema", "/schema"],
  ["/#/data/profile", "/data/profile"],
  ["/#/data/odd%2Fname?view=a%2Bb", "/data/odd%2Fname?view=a%2Bb"],
  [
    "/#/data/user?scope=%7B%22where%22%3A%7B%22id%22%3A7%7D%7D",
    "/data/user?scope=%7B%22where%22%3A%7B%22id%22%3A7%7D%7D",
  ],
  ["/#/query?query=001%2F%3F%23", "/query/001%2F%3F%23"],
  ["/query?query=saved&extra=kept", "/query/saved?extra=kept"],
  ["/data/profile", undefined],
  ["/data/%", "/not-found"],
  ["/#/data/%E0%A4", "/not-found"],
  ["/query/saved", undefined],
  ["/schema#table", undefined],
  ["/#//other.example/path", undefined],
  ["/#/\\other.example/path", undefined],
])("upgrades a local bookmark %s", (path, expected) => {
  expect(legacyPath(new URL(path, "http://127.0.0.1:5577"))).toBe(expected);
});

test("relation links retain their filter and label", () => {
  expect(readScope(null)).toBeUndefined();
  const scope = {
    where: { authorId: 7, name: { contains: "a?b#c" } },
    label: "User 7's posts",
  };
  expect(readScope(JSON.stringify(scope))).toEqual(scope);
});

test.each([
  "",
  "{",
  "null",
  "[]",
  "42",
  '{"where":[]}',
  '{"where":null,"label":"bad"}',
  '{"where":{},"label":3}',
])("refuses a malformed relation filter: %s", (value) => {
  expect(() => readScope(value)).toThrow();
});
