/**
 * What an author is told when a part is written wrong: a word in a key that
 * does not take it, a value where a word is wanted, a shape a part does not
 * read. Each refusal names the place, and comes where the extension is
 * applied (`$extends`) or, for an entry given lazily, where it is first read;
 * a builder handed no function refuses at once.
 *
 * The parts are written as plain JavaScript would write them (`as never`):
 * the types refuse most of these, and the runtime refusal is what is
 * checked.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import {
  accepts,
  arg,
  args,
  around,
  call,
  check,
  defaults,
  extension,
  facts,
  gate,
  keep,
  lazy,
  now,
  omitted,
  oneOf,
  only,
  provided,
  rule,
  unless,
  when,
} from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
  deletedAt: s.dateTime().nullable(),
  author: s
    .toOne(() => user)
    .fields("ownerId")
    .references("id"),
});
const schema = { user, post };

type Row = Record<string, unknown>;
interface Loose {
  post: { findMany(args?: object): Promise<Row[]> };
  $extends(definition: unknown): Loose;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

function base(): Loose {
  const client = createClient({
    schema,
    dataDir: ":memory:",
  }) as never as Loose;
  opened.push(client);
  return client;
}

/** The refusal applying one extension made of `parts` meets. */
function applying(...parts: unknown[]): unknown {
  try {
    base().$extends(Reflect.apply(extension, undefined, ["x", ...parts]));
  } catch (error) {
    return error;
  }
  throw new Error("expected $extends to refuse");
}

/** A refusal's message where it is the client's refusal; else nothing. */
const refusal = (error: unknown): string =>
  error instanceof ClientInitializationError ? error.message : "";

/** A part from a builder handed values its types refuse. */
const loose = (build: (value: never) => unknown, value: unknown): unknown =>
  Reflect.apply(build, undefined, [value]);

describe("a builder handed no function refuses at once", () => {
  test("call() and around() take a function of the call", () => {
    expect(() => loose(call, "handler")).toThrow(
      new TypeError("call() takes a function of the call")
    );
    expect(() => loose(around, {})).toThrow(
      new TypeError("around() takes a function of the call")
    );
  });

  test("an argument is declared with a builder or a Standard Schema", () => {
    expect(() => loose(args, { tenant: 3 })).toThrow(
      'Argument "tenant" is declared with oneOf'
    );
    expect(() => loose(args, { tenant: { spec: null } })).toThrow(TypeError);
    // A callable Standard Schema (ArkType's types are functions) is one.
    const callable = Object.assign(() => undefined, {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    });
    expect(() =>
      base().$extends(
        extension("x", loose(args, { tenant: callable }) as never)
      )
    ).not.toThrow();
  });

  test("when(), unless() and provided() test an argument written arg(name)", () => {
    expect(() => Reflect.apply(when, undefined, ["tenant", "a", {}])).toThrow(
      new TypeError("when() tests an argument written arg(name)")
    );
  });
});

describe("defaults: an entry's shape", () => {
  test("an entry is an object of defaults keys", () => {
    expect(refusal(applying(loose(defaults, { post: "newest" })))).toContain(
      "defaults.post: an entry is an object"
    );
    expect(
      refusal(applying(loose(defaults, { post: { sort: { title: "asc" } } })))
    ).toContain('defaults.post: "sort" is not a defaults key');
  });

  test("data is an object of fields", () => {
    expect(
      refusal(applying(loose(defaults, { post: { create: "stamp" } })))
    ).toContain("defaults.post: data is an object of fields");
  });

  test("fields is an object whose values are written omitted", () => {
    expect(
      refusal(applying(loose(defaults, { post: { fields: ["title"] } })))
    ).toContain("defaults.post: fields is an object");
    expect(
      refusal(applying(loose(defaults, { post: { fields: { title: true } } })))
    ).toContain("defaults.post: fields.title is written omitted");
  });

  test("a field of defaults takes omitted and no other word", () => {
    // Beside a rule part, a judging word reaches the refusal.
    expect(
      refusal(
        applying(
          loose(rule, { user: { root: {} } }),
          loose(defaults, { post: { fields: { title: check({}) } } })
        )
      )
    ).toContain("defaults.post: fields.title is written omitted");
  });

  test("omitted is a default, never a rule", () => {
    expect(
      refusal(
        applying(
          loose(rule, { post: { read: { fields: { title: omitted } } } })
        )
      )
    ).toContain("read.fields.title does not take omitted");
  });
});

describe("rule: an entry's keys and the words they take", () => {
  test("an entry given as a function is written lazy(() => entry)", () => {
    expect(
      refusal(applying(loose(rule, { post: () => ({ root: {} }) })))
    ).toContain("an entry given as a function is written lazy(() => entry)");
    expect(refusal(applying(loose(rule, { post: "mine" })))).toContain(
      "an entry is an object"
    );
  });

  test("a key outside the rule's is refused", () => {
    expect(
      refusal(applying(loose(rule, { post: { sort: { title: "asc" } } })))
    ).toContain('"sort" is not a rule key');
  });

  test("a where a write takes is written only(where), any other key with its word", () => {
    expect(
      refusal(
        applying(loose(rule, { post: { update: { where: { title: "a" } } } }))
      )
    ).toContain("update.where is written only(where)");
    expect(
      refusal(
        applying(loose(rule, { post: { create: { check: { title: "a" } } } }))
      )
    ).toContain("create.check is written with a word");
  });

  test("each word is refused where it does not belong", () => {
    expect(
      refusal(applying(loose(rule, { post: { create: { check: only({}) } } })))
    ).toContain("create.check does not take only()");
    expect(
      refusal(applying(loose(rule, { post: { update: { where: check({}) } } })))
    ).toContain("update.where does not take check()");
    expect(
      refusal(
        applying(
          loose(rule, { post: { read: { select: { $seen: gate({}) } } } })
        )
      )
    ).toContain("read.select.$seen does not take gate()");
    expect(
      refusal(
        applying(
          loose(rule, {
            post: { read: { fields: { title: facts({ a: {} }) } } },
          })
        )
      )
    ).toContain("read.fields.title does not take facts()");
    expect(
      refusal(applying(loose(rule, { post: { update: { check: keep({}) } } })))
    ).toContain("update.check does not take keep()");
    expect(
      refusal(
        applying(
          loose(rule, {
            post: { read: { fields: { title: lazy(() => ({})) } } },
          })
        )
      )
    ).toContain("read.fields.title does not take lazy()");
  });

  test("read.select holds one projection key", () => {
    expect(
      refusal(
        applying(
          loose(rule, {
            post: {
              read: {
                select: { $a: facts({ x: {} }), $b: facts({ y: {} }) },
              },
            },
          })
        )
      )
    ).toContain("read.select holds one projection key");
  });

  test("a field's write slot is { where?, check? }", () => {
    expect(
      refusal(
        applying(loose(rule, { post: { update: { fields: { title: true } } } }))
      )
    ).toContain("update.fields.title is { where?, check? }");
  });

  test("acyclic lists relations, and is judged with a check beside it", () => {
    expect(
      refusal(
        applying(
          loose(rule, {
            post: { acyclic: "author", create: { check: check({}) } },
          })
        )
      )
    ).toContain("acyclic lists relations, or is a function returning them");
    expect(
      refusal(applying(loose(rule, { post: { acyclic: ["author"] } })))
    ).toContain("acyclic is judged with the rows a write produces");
  });

  test("a confinement states the model's own columns", () => {
    expect(
      refusal(
        applying(
          loose(rule, {
            post: { confine: { author: { is: { name: "Ann" } } } },
          })
        )
      )
    ).toContain(
      'rule.post.confine: names "author", which is not a scalar field'
    );
  });

  test("two rule parts of one extension do not both judge a model", () => {
    const judged = () =>
      loose(rule, { post: { create: { check: check({}) } } });
    expect(refusal(applying(judged(), judged()))).toContain(
      "two rule parts of one extension judge the model"
    );
    // An entry given lazily judges the model too.
    expect(
      refusal(
        applying(
          judged(),
          loose(rule, { post: lazy(() => ({ create: { check: check({}) } })) })
        )
      )
    ).toContain("two rule parts of one extension judge the model");
  });

  test("a test of an argument is a value or one filter test", () => {
    expect(
      refusal(
        applying(
          args({ tenant: oneOf("a", "b") }),
          loose(rule, {
            post: { read: { where: when(arg("tenant"), { near: "a" }, {}) } },
          })
        )
      )
    ).toContain(
      "a test is a value or exactly one of exists, equals, in, has, hasSome"
    );
  });
});

describe("keep(): what a delete writes instead", () => {
  const kept = (data: unknown, ...more: unknown[]) =>
    applying(
      ...more,
      loose(rule, { post: { delete: { instead: keep(data) } } })
    );

  test("keep() takes the data the row is updated with", () => {
    expect(refusal(kept("deleted"))).toContain(
      "keep() takes the data the row is updated with"
    );
    // provided() is a filter of rows, not a condition on what keep() writes.
    expect(
      refusal(
        kept(
          provided(arg("trash"), "keep", { deletedAt: now }),
          args({ trash: oneOf("keep", "remove") })
        )
      )
    ).toContain("keep() takes the data the row is updated with");
  });

  test("keep() writes constants and now, now in one field", () => {
    expect(
      refusal(
        kept(
          { deletedAt: arg("at") },
          args({
            at: accepts({
              "~standard": {
                version: 1,
                vendor: "t",
                validate: (value: unknown) => ({ value }),
              },
            }),
          })
        )
      )
    ).toContain("keep() writes constants and now");
    expect(refusal(kept({ deletedAt: now, title: now }))).toContain(
      "keep() writes now in one field"
    );
  });

  test("a condition on keep() reads an argument with two values, or names the one that removes", () => {
    // Three values: which one removes the row is not said.
    expect(
      refusal(
        kept(
          when(arg("trash"), "keep", { deletedAt: now }),
          args({ trash: oneOf("keep", "remove", "purge").default("keep") })
        )
      )
    ).toContain("keep() takes data, or unless(arg(name), value, data)");
    // A path into an argument is no argument's value.
    expect(
      refusal(
        kept(
          unless(arg("trash", "mode"), "remove", { deletedAt: now }),
          args({
            trash: accepts({
              "~standard": {
                version: 1,
                vendor: "t",
                validate: (value: unknown) => ({ value }),
              },
            }),
          })
        )
      )
    ).toContain("keep() takes data, or unless(arg(name), value, data)");
  });

  test("one extension's keep() parts name one physical delete", () => {
    expect(
      refusal(
        applying(
          args({ trash: oneOf("keep", "remove", "purge").default("keep") }),
          loose(rule, {
            post: {
              delete: {
                instead: keep(
                  unless(arg("trash"), "remove", { deletedAt: now })
                ),
              },
            },
            user: {
              delete: {
                instead: keep(unless(arg("trash"), "purge", { name: "gone" })),
              },
            },
          })
        )
      )
    ).toContain("one extension's keep() parts name the same physical delete");
  });
});

describe("an entry given lazily is checked where it is first read", () => {
  async function firstRead(entry: () => unknown): Promise<unknown> {
    const client = base();
    await syncLiveSchema(client as never);
    const extended = client.$extends(
      extension("x", loose(rule, { post: lazy(entry) }) as never)
    );
    return extended.post.findMany({}).then(
      () => undefined,
      (error: unknown) => error
    );
  }

  test("it holds no confine", async () => {
    expect(
      refusal(await firstRead(() => ({ confine: { title: "a" } })))
    ).toContain("an entry given lazily holds no confine");
  });

  test("it holds no keep(), and no lazy() of its own", async () => {
    expect(
      refusal(
        await firstRead(() => ({
          delete: { instead: keep({ deletedAt: now }) },
        }))
      )
    ).toContain("keep() is written in an entry, not one given as a function");
    expect(refusal(await firstRead(() => lazy(() => ({}))))).toContain(
      "the entry does not take lazy()"
    );
  });
});
