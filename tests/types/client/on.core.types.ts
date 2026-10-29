/**
 * `viborm/on` typing, probed through the public surface as a user spells it:
 * model names, hook names and each hook's rows come from the receiving
 * client's schema, with a typo probe at every nesting level beside a valid
 * sibling. A hook's row is the model's schema row: `defaultOmit()` hides no
 * field from it and computed `result` fields are not on it. Applying `on`
 * changes nothing else about the client's type.
 *
 * Nothing in this file is called. Only the types matter.
 */

import { defaultOmit } from "@src/client/exports";
import { PGliteDriver } from "@src/drivers/pglite";
import { createClient, defineExtension, s } from "@src/index";
import { type OnEvent, type OnOperation, type OnRow, on } from "@src/on";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const user = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
  age: s.int().nullable(),
  posts: s.toMany(() => post).name("author"),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  createdAt: s.dateTime(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .name("author")
    .fields("authorId")
    .references("id"),
  deletedAt: s.dateTime().nullable(),
});
const schema = { user, post };

const base = createClient({ schema, driver: new PGliteDriver() });

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  age: number | null;
};
type PostRow = {
  id: string;
  title: string;
  createdAt: Date;
  authorId: string;
  deletedAt: Date | null;
};

// Rows and event, contextually typed from the receiving client.
const hooked = base.$extends(
  on({
    user: {
      update: (rows, written) => {
        expectTypeOf(rows).toEqualTypeOf<readonly OnRow<typeof user>[]>();
        expectTypeOf(rows).toEqualTypeOf<readonly UserRow[]>();
        expectTypeOf(written.model).toEqualTypeOf<"user" | "post">();
        expectTypeOf(written.operation).toEqualTypeOf<OnOperation>();
        expectTypeOf(written.certainty).toEqualTypeOf<
          "committed" | "may-have-committed"
        >();
        return Promise.resolve();
      },
    },
    post: {
      create: (rows) => {
        expectTypeOf(rows).toEqualTypeOf<readonly PostRow[]>();
      },
      delete: (rows) => {
        expectTypeOf(rows).toEqualTypeOf<readonly PostRow[]>();
      },
    },
  })
);

// Applying `on` changes nothing else about the client.
type _Same = Expect<Equal<typeof hooked, typeof base>>;
export const updated = hooked.user.update({
  where: { id: "u1" },
  data: { email: "e" },
});

// A misspelt model, beside a valid one.
base.$extends(
  on({
    user: { update: () => undefined },
    // @ts-expect-error - "usr" is not a model of the schema
    usr: { update: () => undefined },
  })
);

// A misspelt hook name, beside a valid one.
base.$extends(
  on({
    user: {
      create: () => undefined,
      // @ts-expect-error - "updated" is not a hook name
      updated: () => undefined,
    },
  })
);

// A row field that does not exist.
base.$extends(
  on({
    user: {
      update: (rows) => {
        // @ts-expect-error - "nickname" is not a field of user
        expectTypeOf(rows[0]?.nickname).toBeUnknown();
        expectTypeOf(rows[0]?.email).toEqualTypeOf<string | undefined>();
      },
    },
  })
);

// `defaultOmit()` hides a field from the caller, not from a hook.
const omitting = base.$extends(
  defaultOmit<typeof schema>()({ user: { passwordHash: true } })
);
omitting.$extends(
  on({
    user: {
      update: (rows) => {
        expectTypeOf(rows).toEqualTypeOf<readonly UserRow[]>();
      },
    },
  })
);

// A computed field reaches the caller, never a hook.
const computed = base.$extends({
  name: "labels",
  result: {
    user: {
      label: {
        needs: { email: true },
        compute: (row: { email: string }) => `<${row.email}>`,
      },
    },
  },
});
computed.$extends(
  on({
    user: {
      update: (rows) => {
        expectTypeOf(rows).toEqualTypeOf<readonly UserRow[]>();
      },
    },
  })
);

// After soft delete: the restore methods stay, and soft delete's controls too.
const tombstoned = softDelete({
  models: { post: { deletedAt: "deletedAt" } },
})(base).$extends(
  on({
    post: {
      update: (rows) => {
        expectTypeOf(rows).toEqualTypeOf<readonly PostRow[]>();
      },
    },
  })
);
export const restored = tombstoned.post.restore({ where: { id: "p1" } });
export const bin = tombstoned.post.findMany({ deleted: "only" });

// Declared apart from a client: any model, plain rows; applied later, it
// returns the client it is given.
const standalone = on({
  anything: {
    update: (rows, written) => {
      expectTypeOf(rows).toEqualTypeOf<readonly Record<string, unknown>[]>();
      expectTypeOf(written.model).toEqualTypeOf<string>();
    },
  },
});
type _Applied = Expect<
  Equal<ReturnType<typeof standalone<typeof base>>, typeof base>
>;
const appliedLater = base.$extends(standalone);
type _AppliedLater = Expect<Equal<typeof appliedLater, typeof base>>;

// A hook written apart, typed with the plain event, fits any model.
const logAll = (_rows: readonly Record<string, unknown>[], _event: OnEvent) =>
  undefined;
base.$extends(on({ user: { update: logAll }, post: { delete: logAll } }));

// The event type names its own fields.
type _Event = Expect<
  Equal<keyof OnEvent, "model" | "operation" | "args" | "certainty">
>;

// A field a `rows` extension's `reads` gates is optional in a hook's row: the
// row carries it only where the call may read it. A default omit stays.
const gating = base.$extends(
  defineExtension({
    name: "gating",
    controls: { viewer: { schema: v.string() } },
    rows: {
      control: "as",
      default: "default",
      models: { post: { default: {} } },
      verbs: {
        post: {
          predicates: { own: { authorId: { control: "viewer" } } },
          reads: { title: "own" },
        },
      },
    },
  } as const)
);
gating.$extends(
  on({
    post: {
      update: (rows) => {
        expectTypeOf(rows[0]!).toEqualTypeOf<
          Omit<PostRow, "title"> & { title?: string }
        >();
      },
    },
  })
);
