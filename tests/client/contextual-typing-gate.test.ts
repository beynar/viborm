/**
 * The contextual-typing gate (W8-B).
 *
 * ONE claim, checked on every public surface where a user writes an object
 * literal or a field-name string: a misspelled key is a COMPILE ERROR.
 *
 * Why a typo probe and not a "the editor completes this" assertion: completion
 * is not checkable from a test, but it has a checkable proxy. An editor offers
 * the keys of a CONCRETE contextual type; a surface that accepts an unknown key
 * had no concrete type to offer, so it offered nothing. Refusing the typo and
 * completing the key are the same property seen from two sides.
 *
 * The case study is `omit`, which shipped the gap TWICE — f842302 keyed the core
 * `createClient` config, and 2f7bd59 found the same hole still open in all
 * eleven driver-package wrappers, the entry point most apps actually import.
 * Both times the surface's RESULT types were already right; only the contextual
 * type while the literal was being written was wrong. That is why probes must
 * enter through the public API exactly as a user writes it — a probe that names
 * an internal type alias types the alias, not the call.
 *
 * THREE things make a probe honest here. The first two came from the commits
 * above; the third is what this file learned by falsifying its own first draft:
 *
 *  1. it enters through the PUBLIC surface (`s`, `createClient`, the driver
 *     wrapper, `client.<model>.<op>`), never an internal alias;
 *  2. there is a typo probe at EVERY nesting level, not just the outermost —
 *     `where` refusing a bad key says nothing about `where.title.contains`;
 *  3. **the typo sits BESIDE A REAL KEY.** A typo ALONE does not measure the
 *     surface at all. Every clause and config bag here is a WEAK type (all
 *     properties optional), and TypeScript refuses an object that shares NO
 *     property with a weak type — so `{ passwordHsh: true }` and
 *     `{ ttitle: "x" }` were rejected by weak-type detection no matter how
 *     unkeyed the surface was. Add one correct key and the detection stops:
 *     `{ passwordHash: true, passwordHsh: true }` and
 *     `{ title: "x", ttitle: "x" }` both compiled. That is the shape a real
 *     config and a real query have, so the alone-probes were measuring a
 *     TypeScript rule rather than this codebase's types. Every probe below is
 *     therefore paired: `…Alone` and `…BesideReal`, and only the second one is
 *     evidence.
 *
 * A `// @ts-expect-error` that stops being an error fails this file (TS2578),
 * so a regression that re-opens a surface is a red type-check, and every probe
 * is self-falsifying: correct the spelling and the directive goes unused.
 *
 * Nothing here is called; only the types matter.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { createClient } from "@client/client";
import {
  PGliteDriver,
  createClient as pgliteCreateClient,
} from "@drivers/pglite";
import { down } from "@migrations/apply/down";
import { push } from "@migrations/push";
import { createFsStorageDriver } from "@migrations/storage/fs";
import { s } from "@schema";
import { describe, expectTypeOf, test } from "vitest";
// Deliberately the published entry point, not `@schema/field-ref`: the alias
// would compile while the import the docs teach did not.
import { createModelFieldRefs } from "../../src/index";

const author = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
  books: s.oneToMany(() => book).name("writer"),
  tags: s.manyToMany(() => tag),
});

const tag = s.model({
  id: s.string().id(),
  label: s.string(),
  authors: s.manyToMany(() => author),
});

const book = s.model({
  id: s.string().id(),
  title: s.string(),
  pages: s.int(),
  authorId: s.string(),
  writer: s
    .manyToOne(() => author)
    .fields("authorId")
    .references("id")
    .name("writer"),
});

const schema = { author, book, tag };

const client = createClient({ schema, driver: new PGliteDriver() });

const cachedClient = createClient({
  schema,
  driver: new PGliteDriver(),
  cache: new MemoryCache(),
});

// ============================================================================
// MODEL BUILDER — field-name lists
// ============================================================================

describe("model builder field-name lists are keyed to the model's scalars", () => {
  const _keyed = () =>
    s
      .model({ a: s.string(), b: s.string() })
      .id(["a", "b"])
      .unique(["b"])
      .index(["a", "b"]);

  const _idTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar of this model
      .id(["a", "bb"]);

  const _uniqueTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar of this model
      .unique(["a", "bb"]);

  const _indexTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar of this model
      .index(["a", "bb"]);

  const _omitTypoAlone = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar of this model
      .omit({ bb: true });

  /**
   * The one that matters: `.omit()` refuses per KEY, so a real field beside the
   * typo does not rescue it. This is what `UnknownOmitKeys` was built for and
   * what the client-level `omit` was missing until this lane.
   */
  const _omitTypoBesideReal = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar, even next to the real "a"
      .omit({ a: true, bb: true });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_idTypo).toBeFunction();
    expectTypeOf(_uniqueTypo).toBeFunction();
    expectTypeOf(_indexTypo).toBeFunction();
    expectTypeOf(_omitTypoAlone).toBeFunction();
    expectTypeOf(_omitTypoBesideReal).toBeFunction();
  });
});

/**
 * The option bags of the same three calls — the SECOND nesting level, and the
 * one that had shipped open. `{ name: "i", uniqu: true }` records an index that
 * is not unique; nothing downstream ever reads `uniqu`.
 *
 * Each is probed twice, fresh and non-fresh, because excess-property checking —
 * the only thing that refused these before — needs a fresh object literal. A bag
 * held in a variable (the "share one options object across two indexes" shape)
 * is exactly the case it waves through.
 */
const sharedCompoundOptions = { name: "ab", nmae: "ab" };
const sharedIndexOptions = { name: "i", uniqu: true };

describe("model builder option bags refuse a key they do not read", () => {
  const _keyed = () =>
    s
      .model({ a: s.string(), b: s.string() })
      .id(["a", "b"], { name: "pk" })
      .unique(["a"], { name: "uq" })
      .index(["b"], {
        name: "ix",
        unique: true,
        type: "btree",
        where: "b > 0",
      });

  const _idOptionTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .id()
      .id(["a", "b"], { nmae: "ab" });

  const _idOptionTypoBesideReal = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .id()
      .id(["a", "b"], { name: "ab", nmae: "ab" });

  const _idOptionTypoNonFresh = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .id()
      .id(["a", "b"], sharedCompoundOptions);

  const _uniqueOptionTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .unique()
      .unique(["a", "b"], { nmae: "ab" });

  const _uniqueOptionTypoNonFresh = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .unique()
      .unique(["a", "b"], sharedCompoundOptions);

  const _indexOptionTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "uniqu" is not an index option
      .index(["a"], { name: "i", uniqu: true });

  const _indexOptionTypoNonFresh = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "uniqu" is not an index option
      .index(["a"], sharedIndexOptions);

  const _indexOptionValueTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "btre" is not an IndexType
      .index(["a"], { type: "btre" });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_idOptionTypo).toBeFunction();
    expectTypeOf(_idOptionTypoBesideReal).toBeFunction();
    expectTypeOf(_idOptionTypoNonFresh).toBeFunction();
    expectTypeOf(_uniqueOptionTypo).toBeFunction();
    expectTypeOf(_uniqueOptionTypoNonFresh).toBeFunction();
    expectTypeOf(_indexOptionTypo).toBeFunction();
    expectTypeOf(_indexOptionTypoNonFresh).toBeFunction();
    expectTypeOf(_indexOptionValueTypo).toBeFunction();
  });
});

/**
 * `.id()` / `.unique()` name the constraint they build, and the name must survive
 * the option bag's new keying — a bag typed only for its refusal would widen the
 * name and lose the compound key's identity.
 */
describe("a named compound key keeps its literal name", () => {
  test("the explicit name is the constraint key", () => {
    const model = s
      .model({ a: s.string(), b: s.string() })
      .id(["a", "b"], { name: "pk_ab" });
    expectTypeOf<
      keyof NonNullable<(typeof model)["~"]["state"]["compoundId"]>
    >().toEqualTypeOf<"pk_ab">();
  });

  test("with no name the joined field names are", () => {
    const model = s.model({ a: s.string(), b: s.string() }).unique(["a", "b"]);
    expectTypeOf<
      keyof NonNullable<(typeof model)["~"]["state"]["compoundUniques"]>
    >().toEqualTypeOf<"a_b">();
  });
});

// ============================================================================
// BUILDER STRINGS THAT NAME SOMETHING VIBORM CREATES — free-form by design
// ============================================================================

/**
 * Not every string on the builder has a key set to check against, and the ones
 * below genuinely do not. `.map()` names the physical TABLE, `.through()` the
 * junction table and `.A()` / `.B()` its two columns, `.name()` on an enum the
 * database enum type. Every one of those objects is created BY viborm from the
 * name given — `serializeModels` builds the junction `TableDef` from
 * `.through()` — so there is no prior set a spelling could disagree with.
 * `.map("uesrs")` is not a typo, it is a request for a table called `uesrs`.
 *
 * A relation's `.name()` is the one with a partner: the two sides of a pair must
 * agree, and a mismatch is real. But the other side is a sibling of the very
 * object literal being typed, so it has no type yet — the same obstacle as
 * `.fields()` below. Schema validation catches it at construction.
 *
 * These probes carry NO `@ts-expect-error`. They are arbitrary strings that
 * compile, and their compiling is the pin: if any of them ever gains a key set,
 * the line stays green while the claim in this comment becomes false, so the
 * claim is written out here to be checked by eye against the code.
 */
describe("names viborm itself creates take any string", () => {
  const _tableAndJunctionNames = () =>
    s
      .model({
        id: s.string().id(),
        tags: s
          .manyToMany(() => tag)
          .through("t_a_g")
          .A("aId")
          .B("bId"),
      })
      .map("any_table_name_at_all");

  const _enumTypeName = () => s.enum(["A", "B"]).name("any_enum_name");

  const _relationPairName = () =>
    s.model({
      id: s.string().id(),
      books: s.oneToMany(() => book).name("wrtier"),
    });

  test("the three probes above compile, which is the pin", () => {
    expectTypeOf(_tableAndJunctionNames).toBeFunction();
    expectTypeOf(_enumTypeName).toBeFunction();
    expectTypeOf(_relationPairName).toBeFunction();
  });
});

/** The enum's MEMBERS are a key set, and a default outside them is refused. */
describe("enum members are keyed", () => {
  const _keyed = () => s.enum(["A", "B"]).default("A");
  // @ts-expect-error - "C" is not a member of this enum
  const _typo = () => s.enum(["A", "B"]).default("C");

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_typo).toBeFunction();
  });
});

// ============================================================================
// RELATION BUILDER
// ============================================================================

/**
 * `.fields()` and `.references()` take bare `string`, and BOTH are pinned here as
 * accepting a typo — a negative pin, not an oversight. See the doc comments on
 * `ToOneRelation.fields` / `.references` for why: `.fields()` names siblings of
 * the very object literal being typed (no type exists yet), and keying
 * `.references()` through the getter resolves the target model mid-inference,
 * which is precisely what `RelationState.getter: any` exists to prevent — it was
 * measured at 123 estate type errors, with a self-referential relation reporting
 * its own correct `"id"` as `never`.
 *
 * Both are refused at RUNTIME by schema validation (FK001 for `.fields`, FK002
 * for `.references`, both severity `error`).
 *
 * The two probes below therefore carry NO `@ts-expect-error`: they are misspelled
 * calls that compile, and their compiling IS the pin. The day either surface gets
 * keyed, the line turns red — at which point delete the probe, move it up into
 * the keyed sections, and correct the doc comment that says it cannot be done.
 */
describe("relation FK spellings are runtime-checked, not type-checked", () => {
  const _fieldsTypoCompiles = () =>
    s.model({
      authorId: s.string(),
      // "authorIdd" is a typo the TYPE cannot catch — FK001 catches it.
      writer: s
        .manyToOne(() => author)
        .fields("authorIdd")
        .references("id"),
    });

  const _referencesTypoCompiles = () =>
    s.model({
      authorId: s.string(),
      // "idd" is a typo the TYPE cannot catch — FK002 catches it.
      writer: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("idd"),
    });

  const _onDeleteTypo = () =>
    s.model({
      authorId: s.string(),
      writer: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("id")
        // @ts-expect-error - "cascde" is not a referential action
        .onDelete("cascde"),
    });

  const _junctionOnDeleteTypo = () =>
    s.model({
      id: s.string().id(),
      // @ts-expect-error - "cascde" is not a referential action
      tags: s.manyToMany(() => tag).onDelete("cascde"),
    });

  test("the two FK probes are the pinned negative, the actions are positive", () => {
    expectTypeOf(_fieldsTypoCompiles).toBeFunction();
    expectTypeOf(_referencesTypoCompiles).toBeFunction();
    expectTypeOf(_onDeleteTypo).toBeFunction();
    expectTypeOf(_junctionOnDeleteTypo).toBeFunction();
  });
});

// ============================================================================
// CLIENT CONFIG — core and driver wrapper, at BOTH levels
// ============================================================================

/**
 * The surface the case-study commits fixed, extended from `omit`'s KEYS to the
 * config's own keys. `createClient` infers `Config` from the literal, so the
 * literal's keys are "known" by construction and excess-property checking has
 * nothing to say — `cacheVerison: 1` used to compile and be read by no one.
 *
 * Probed on both entry points, because 2f7bd59's whole finding was that fixing
 * the core one left the eleven wrappers open.
 */
const sharedConfig = {
  schema,
  driver: new PGliteDriver(),
  cacheVerison: 1,
};

describe("createClient config refuses a key it does not read", () => {
  const _keyed = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      cacheVersion: 1,
      decimal: "string",
      omit: { author: { passwordHash: true } },
    });

  const _configTypo = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      // @ts-expect-error - "cacheVerison" is not a config key
      cacheVerison: 1,
    });

  const _configTypoBesideReal = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      cacheVersion: 1,
      // @ts-expect-error - "cacheVerison" is not a config key
      cacheVerison: 1,
    });

  // @ts-expect-error - "cacheVerison" is not a config key, fresh literal or not
  const _configTypoNonFresh = () => createClient(sharedConfig);

  const _decimalValueTypo = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      // @ts-expect-error - "strng" is not a decimal mode
      decimal: "strng",
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_configTypo).toBeFunction();
    expectTypeOf(_configTypoBesideReal).toBeFunction();
    expectTypeOf(_configTypoNonFresh).toBeFunction();
    expectTypeOf(_decimalValueTypo).toBeFunction();
  });
});

/**
 * INSIDE `omit` — the level the case study never reached, and the one where a
 * silently-ignored key is a leaked column.
 *
 * `{ passwordHsh: true }` alone was refused before this lane, but only by
 * weak-type detection; `{ passwordHash: true, passwordHsh: true }` compiled and
 * hid exactly one of the two secrets. Two secrets with one misspelled is the
 * realistic case — it is the case `UnknownOmitKeys` cites at the model level —
 * so the `BesideReal` probes are the ones with evidentiary weight here.
 */
describe("client omit is keyed per KEY at both of its levels", () => {
  const _keyed = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      omit: {
        author: { passwordHash: true, email: true },
        book: { pages: true },
      },
    });

  const _fieldTypoAlone = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      // @ts-expect-error - "passwordHsh" is not a field of author
      omit: { author: { passwordHsh: true } },
    });

  const _fieldTypoBesideReal = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      omit: {
        // @ts-expect-error - "passwordHsh" is refused next to the real "passwordHash"
        author: { passwordHash: true, passwordHsh: true },
      },
    });

  const _modelTypoAlone = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      // @ts-expect-error - "reader" is not a model of this schema
      omit: { reader: { passwordHash: true } },
    });

  const _modelTypoBesideReal = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      omit: {
        author: { passwordHash: true },
        // @ts-expect-error - "authro" is refused next to the real "author"
        authro: { passwordHash: true },
      },
    });

  const _relationKey = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      // @ts-expect-error - relations are not omittable, only scalars
      omit: { book: { writer: true } },
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_fieldTypoAlone).toBeFunction();
    expectTypeOf(_fieldTypoBesideReal).toBeFunction();
    expectTypeOf(_modelTypoAlone).toBeFunction();
    expectTypeOf(_modelTypoBesideReal).toBeFunction();
    expectTypeOf(_relationKey).toBeFunction();
  });
});

/**
 * INSIDE `instrumentation`, and inside each of its three sub-bags. Same shape of
 * gap, same fix: `{ tracing: true, loging: true }` used to compile and start no
 * logger, because `tracing: true` satisfied weak-type detection for the whole
 * object.
 */
describe("instrumentation is keyed at every level", () => {
  const _keyed = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      instrumentation: {
        tracing: { includeSql: true },
        logging: { query: true },
        diagnostics: { includeSql: true },
      },
    });

  const _typoAlone = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      // @ts-expect-error - "enabld" is not an instrumentation key
      instrumentation: { enabld: true },
    });

  const _typoBesideReal = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      instrumentation: {
        tracing: true,
        // @ts-expect-error - "loging" is refused next to the real "tracing"
        loging: true,
      },
    });

  const _tracingTypo = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      instrumentation: {
        // @ts-expect-error - "includeSqll" is not a TracingConfig key
        tracing: { includeSql: true, includeSqll: true },
      },
    });

  const _loggingTypo = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      instrumentation: {
        // @ts-expect-error - "queyr" is not a LoggingConfig key
        logging: { query: true, queyr: true },
      },
    });

  const _diagnosticsTypo = () =>
    createClient({
      schema,
      driver: new PGliteDriver(),
      instrumentation: {
        // @ts-expect-error - "includeSqll" is not a DiagnosticDisclosure key
        diagnostics: { includeSql: true, includeSqll: true },
      },
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_typoAlone).toBeFunction();
    expectTypeOf(_typoBesideReal).toBeFunction();
    expectTypeOf(_tracingTypo).toBeFunction();
    expectTypeOf(_loggingTypo).toBeFunction();
    expectTypeOf(_diagnosticsTypo).toBeFunction();
  });
});

describe("the driver-package createClient is keyed the same way, all levels", () => {
  const _keyed = () =>
    pgliteCreateClient({
      schema,
      dataDir: "memory://",
      cacheVersion: 1,
      omit: { author: { passwordHash: true } },
    });

  const _driverOptionTypo = () =>
    pgliteCreateClient({
      schema,
      // @ts-expect-error - "dataDr" is not a pglite option
      dataDr: "memory://",
    });

  const _sharedConfigKeyTypo = () =>
    pgliteCreateClient({
      schema,
      // @ts-expect-error - "cacheVerison" is not a config key
      cacheVerison: 1,
    });

  const _omitTypoBesideReal = () =>
    pgliteCreateClient({
      schema,
      dataDir: "memory://",
      omit: {
        // @ts-expect-error - "passwordHsh" is refused next to the real "passwordHash"
        author: { passwordHash: true, passwordHsh: true },
      },
    });

  const _instrumentationTypoBesideReal = () =>
    pgliteCreateClient({
      schema,
      dataDir: "memory://",
      instrumentation: {
        tracing: true,
        // @ts-expect-error - "loging" is refused next to the real "tracing"
        loging: true,
      },
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_driverOptionTypo).toBeFunction();
    expectTypeOf(_sharedConfigKeyTypo).toBeFunction();
    expectTypeOf(_omitTypoBesideReal).toBeFunction();
    expectTypeOf(_instrumentationTypoBesideReal).toBeFunction();
  });
});

/**
 * The driver's own nested `options` bag is the third-party library's type
 * (`PGliteOptions`, `pg.PoolConfig`, mysql2's `PoolOptions`, …), not viborm's.
 * It is deliberately NOT keyed: those libraries own their option sets, several
 * of them accept extra keys on purpose, and refusing on viborm's behalf would
 * make viborm the reason a valid driver option stops compiling.
 *
 * Pinned as a compiling misspelling so the choice stays visible.
 */
describe("a driver's own options bag is the library's surface, not ours", () => {
  const _thirdPartyOptionTypoCompiles = () =>
    pgliteCreateClient({
      schema,
      options: { relaxedDurability: true, relaxedDurabilty: true },
    });

  test("the probe above compiles, which is the pin", () => {
    expectTypeOf(_thirdPartyOptionTypoCompiles).toBeFunction();
  });
});

// ============================================================================
// QUERY ARGS — the operation's keys and each guarded clause
// ============================================================================

/**
 * These types are derived from the validation schemas rather than written by
 * hand, so they are the surface most likely to be ASSUMED safe — and the first
 * draft of this gate did assume it, reporting "query args were already tight at
 * every level probed". They were not. Every probe had the typo ALONE, so every
 * one of them was weak-type detection: `where: { title: "x", ttitle: "x" }`
 * compiled and filtered on `title` only, returning rows the caller did not ask
 * for.
 *
 * `where` / `select` / `include` / `orderBy` / `omit` are now keyed at the clause
 * level. The rest of the clauses, and every level below the first, are pinned
 * below as compiling — with the measured obstacle.
 *
 * Read the depth of each `where` probe at exactly its strength. The FIELD level
 * — a typo among the model's own keys — is refused both alone and beside a real
 * key, by the clause guard. The OPERATOR level one step deeper (`{ gt: 1,
 * ltt: 100 }`) is refused only when every key is wrong; beside a correct
 * operator it still compiles, because the operand is a union and excess-property
 * checking does not fire through one. That is the pinned negative directly below
 * this block, and it is where the guard stops.
 */
describe("query args refuse a typo beside a real key, per guarded clause", () => {
  const _keyed = () =>
    client.book.findMany({
      where: { title: { contains: "x" }, writer: { is: { email: "e" } } },
      select: { id: true, writer: { select: { email: true } } },
      orderBy: { title: "asc" },
      distinct: ["title"],
      cursor: { id: "1" },
    });

  const _operationKeyTypo = () =>
    // @ts-expect-error - "wher" is not an operation key
    client.book.findMany({ wher: { title: "x" } });

  const _operationKeyTypoBesideReal = () =>
    // @ts-expect-error - "takee" is refused next to the real "take"
    client.book.findMany({ take: 1, takee: 1 });

  const _whereTypoAlone = () =>
    // @ts-expect-error - "ttitle" is not a field of book
    client.book.findMany({ where: { ttitle: "x" } });

  const _whereTypoBesideReal = () =>
    // @ts-expect-error - "ttitle" is refused next to the real "title"
    client.book.findMany({ where: { title: "x", ttitle: "x" } });

  const _selectTypoBesideReal = () =>
    // @ts-expect-error - "ttitle" is refused next to the real "title"
    client.book.findMany({ select: { title: true, ttitle: true } });

  const _includeTypoBesideReal = () =>
    client.author.findMany({
      // @ts-expect-error - "bokos" is refused next to the real "books"
      include: { books: true, bokos: true },
    });

  const _orderByTypoBesideReal = () =>
    // @ts-expect-error - "ttitle" is refused next to the real "title"
    client.book.findMany({ orderBy: { title: "asc", ttitle: "asc" } });

  const _orderByValueTypo = () =>
    // @ts-expect-error - "ascending" is not a sort order
    client.book.findMany({ orderBy: { title: "ascending" } });

  const _omitTypoBesideReal = () =>
    // @ts-expect-error - "ttitle" is refused next to the real "title"
    client.book.findMany({ omit: { title: true, ttitle: true } });

  const _distinctTypo = () =>
    // @ts-expect-error - "ttitle" is not a field of book
    client.book.findMany({ distinct: ["title", "ttitle"] });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_operationKeyTypo).toBeFunction();
    expectTypeOf(_operationKeyTypoBesideReal).toBeFunction();
    expectTypeOf(_whereTypoAlone).toBeFunction();
    expectTypeOf(_whereTypoBesideReal).toBeFunction();
    expectTypeOf(_selectTypoBesideReal).toBeFunction();
    expectTypeOf(_includeTypoBesideReal).toBeFunction();
    expectTypeOf(_orderByTypoBesideReal).toBeFunction();
    expectTypeOf(_orderByValueTypo).toBeFunction();
    expectTypeOf(_omitTypoBesideReal).toBeFunction();
    expectTypeOf(_distinctTypo).toBeFunction();
  });
});

/**
 * THE MEASURED BOUNDARY. Everything below compiles WITH THE TYPO, and each line
 * is a pin on a limit that was measured, not assumed. See `NoExtraOperationKeys`
 * in `src/client/types.ts` for the numbers:
 *
 *  - guarding every clause by mapping over `keyof Arg` CRASHES tsc 5.8.3
 *    (`TypeError: Cannot read properties of undefined (reading 'kind')`);
 *  - naming `data` / `create` / `update` turns six estate sites into
 *    `TS2589: Type instantiation is excessively deep` and takes the estate
 *    type-check from 34s to 172s;
 *  - naming `cursor` / `having` / `cache` adds three more TS2589 sites;
 *  - depth 3 (`where.title.contians`, `select.books.select`) walks INTO a
 *    relation, resolving the target model mid-inference — the thing
 *    `RelationState.getter: any` exists to prevent.
 *
 * These are refused at RUNTIME: validation is the single home for payload
 * normalization, and an unknown key fails the parse. What is missing is only the
 * editor-time refusal. When a future TypeScript can carry the deeper form, these
 * lines turn red — delete them, move them up, and correct the numbers above.
 */
describe("the unguarded query levels are pinned as compiling", () => {
  const _writeClauseTypoCompiles = () =>
    client.book.create({
      // "ttitle" is NOT a compile error — `data` is unguarded (TS2589)
      data: { id: "1", title: "x", ttitle: "x", pages: 1, authorId: "a" },
    });

  const _updateClauseTypoCompiles = () =>
    client.book.updateMany({
      where: {},
      // "ttitle" is NOT a compile error — `data` is unguarded (TS2589)
      data: { title: "x", ttitle: "x" },
    });

  const _cursorTypoCompiles = () =>
    // "idd" is NOT a compile error — `cursor` is unguarded (TS2589)
    client.book.findMany({ cursor: { id: "1", idd: "1" } });

  const _havingTypoCompiles = () =>
    client.book.groupBy({
      by: ["title"],
      // "pagess" is NOT a compile error — `having` is unguarded (TS2589)
      having: { pages: { _sum: { gt: 1 } }, pagess: { _sum: { gt: 1 } } },
    });

  const _cacheTypoCompiles = () =>
    cachedClient.book.create({
      data: { id: "1", title: "t", pages: 1, authorId: "a" },
      // "autoInvalidat" is NOT a compile error — `cache` is unguarded (TS2589)
      cache: { autoInvalidate: true, autoInvalidat: true },
    });

  const _operatorLevelTypoCompiles = () =>
    // depth 3: "contians" is NOT a compile error
    client.book.findMany({
      where: { title: { contains: "x", contians: "x" } },
    });

  const _booleanGroupTypoCompiles = () =>
    // depth 3 again: `AND` is a real `where` key, so the guard stops there and
    // the objects INSIDE the array are unchecked.
    client.book.findMany({ where: { AND: [{ title: "x", ttitle: "x" }] } });

  const _nestedRelationTypoCompiles = () =>
    client.author.findMany({
      // depth 3 through a relation: "ttitle" is NOT a compile error
      select: { id: true, books: { select: { title: true, ttitle: true } } },
    });

  test("the probes above compile, which is the pin", () => {
    expectTypeOf(_writeClauseTypoCompiles).toBeFunction();
    expectTypeOf(_updateClauseTypoCompiles).toBeFunction();
    expectTypeOf(_cursorTypoCompiles).toBeFunction();
    expectTypeOf(_havingTypoCompiles).toBeFunction();
    expectTypeOf(_cacheTypoCompiles).toBeFunction();
    expectTypeOf(_operatorLevelTypoCompiles).toBeFunction();
    expectTypeOf(_booleanGroupTypoCompiles).toBeFunction();
    expectTypeOf(_nestedRelationTypoCompiles).toBeFunction();
  });
});

/**
 * A clause built dynamically and forwarded — `Record<string, unknown>` — is
 * exempt on purpose: it declares no spelled key, and a key nobody spelled cannot
 * be misspelled. Without the exemption the guard would refuse every test helper
 * and every "build the filter from user input" call site.
 */
describe("an index-signature clause is exempt", () => {
  const _dynamicWhereCompiles = (where: Record<string, unknown>) =>
    client.book.findMany({ where });

  test("the probe above compiles, which is the pin", () => {
    expectTypeOf(_dynamicWhereCompiles).toBeFunction();
  });
});

/**
 * Where the `where` guard stops — the exact depth, measured at the merge of W8-A
 * (operand callbacks) and W8-B (this file), because the two lanes read as
 * contradicting each other and did not.
 *
 * FIELD level (`where: { title: "x", ttitle: "y" }`): refused, beside a real key
 * and alone, by the clause guard — `_whereTypoBesideReal` above is that
 * assertion. When the lanes were written separately this was the open hole both
 * described; the clause guard closed it, and this block no longer pins it.
 *
 * OPERATOR level, one step deeper (`{ gt: 1, ltt: 100 }`): still NOT refused. The
 * operand is a UNION — plain value, field-ref token, SQL fragment, callback — and
 * excess-property checking does not fire through a union: the literal matches the
 * filter member and the extra key rides along. Only a literal whose keys are ALL
 * wrong is reported, because then no member matches at all. That is the pair
 * below, and it is the same depth-3 obstacle the clause guard was measured
 * against and left standing (`where.title.contians` in the deliberately-unfixed
 * list) — walking into the operand resolves types the model consts must not
 * resolve mid-inference.
 *
 * The union is not what the callback cost. These probes were run against 2f7bd59
 * — pre-merge, plain values only, no callback in the union — and against the
 * merged tree, with byte-identical outcomes. Widening the operand to accept a
 * callback changed nothing here.
 *
 * The doctrine holds where it must — at RUNTIME the strict object schemas refuse
 * these keys, identically beside a plain value, a token, a fragment and a
 * callback ("an unknown key is refused the same way beside every operand kind"
 * in tests/query-engine/operand-callback-sql.test.ts). The gap is DX-only.
 *
 * Same convention as the FK pins above: no `@ts-expect-error` on the two
 * compiling probes, because their compiling IS the pin. The day the operand union
 * gets excess-property checking those lines turn red — delete them and correct
 * this comment.
 */
describe("an OPERATOR typo beside a correct operator is the pinned negative", () => {
  const _numericOperatorTypoAlone = () =>
    // @ts-expect-error - "gtt" alone matches no member of the operand union
    client.book.findMany({ where: { pages: { gtt: 1 } } });

  const _numericOperatorTypoBesideCompiles = () =>
    client.book.findMany({ where: { pages: { gt: 1, ltt: 100 } } });

  const _stringOperatorTypoBesideCompiles = () =>
    client.book.findMany({
      where: { title: { contains: "x", startsWit: "y" } },
    });

  const _operandCallbackStillTyped = () =>
    client.book.findMany({
      where: { pages: { gt: (ctx) => ctx.fields.pages } },
    });

  test("all-wrong is refused; operator-beside-correct is pinned as compiling", () => {
    expectTypeOf(_numericOperatorTypoAlone).toBeFunction();
    expectTypeOf(_numericOperatorTypoBesideCompiles).toBeFunction();
    expectTypeOf(_stringOperatorTypoBesideCompiles).toBeFunction();
    expectTypeOf(_operandCallbackStillTyped).toBeFunction();
  });
});

// ============================================================================
// TRANSACTION AND MIGRATION OPTIONS
// ============================================================================

const nonFreshPushOptions = { dryRun: true, dryRnu: true };
const nonFreshDownOptions = {
  storageDriver: createFsStorageDriver("./migrations"),
  steps: 1,
  steeps: 1,
};

describe("$transaction and push option bags are keyed", () => {
  const _keyed = () =>
    client.$transaction(async () => 1, {
      isolationLevel: "Serializable",
      timeout: 1,
      maxWait: 1,
    });

  const _txOptionTypo = () =>
    // @ts-expect-error - "timeut" is not a transaction option
    client.$transaction(async () => 1, { timeut: 1 });

  const _txOptionTypoBesideReal = () =>
    // @ts-expect-error - "timeut" is refused next to the real "timeout"
    client.$transaction(async () => 1, { timeout: 1, timeut: 1 });

  const _txIsolationValueTypo = () =>
    // @ts-expect-error - "Serializble" is not an isolation level
    client.$transaction(async () => 1, { isolationLevel: "Serializble" });

  const _batchTxOptionTypo = () =>
    // @ts-expect-error - the sequential form takes isolationLevel only
    client.$transaction([client.book.findMany()], { timeout: 1 });

  const _pushOptionTypo = () =>
    // @ts-expect-error - "dryRnu" is not a push option
    push(client, { dryRun: true, dryRnu: true });

  /**
   * push is the migration entry point where an ignored key destroys data, so it
   * refuses structurally rather than by excess-property checking — a bag held in
   * a variable is refused too.
   */
  // @ts-expect-error - "dryRnu" is not a push option, fresh literal or not
  const _pushOptionTypoNonFresh = () => push(client, nonFreshPushOptions);

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_txOptionTypo).toBeFunction();
    expectTypeOf(_txOptionTypoBesideReal).toBeFunction();
    expectTypeOf(_txIsolationValueTypo).toBeFunction();
    expectTypeOf(_batchTxOptionTypo).toBeFunction();
    expectTypeOf(_pushOptionTypo).toBeFunction();
    expectTypeOf(_pushOptionTypoNonFresh).toBeFunction();
  });
});

/**
 * The file-based migration commands — `down`, `reset`, `apply`, `squash`,
 * `generate`, `preview`, `createMigrationClient`, `MigrationContext` — take a
 * plain options interface. A FRESH literal is refused by excess-property
 * checking (probed below); a bag held in a variable is NOT, and is pinned as
 * such.
 *
 * They were left on excess-property checking deliberately, and the reason is
 * consequence, not difficulty: each of these reads its options and reports what
 * it did, so a dropped `steps` shows up in the result the caller prints. `push`
 * is different — `dryRun` dropped means the DDL RAN — so `push` alone was made
 * structural. Closing the rest is a mechanical repeat of `ExactPushOptions`,
 * one generic per function, if the maintainer wants the uniformity.
 */
describe("file-based migration options are fresh-literal keyed only", () => {
  const _freshTypo = () =>
    // @ts-expect-error - "steeps" is not a down option
    down(client, { storageDriver: createFsStorageDriver("./m"), steeps: 1 });

  // "steeps" is NOT a compile error here — the bag is not a fresh literal.
  const _nonFreshTypoCompiles = () => down(client, nonFreshDownOptions);

  test("the fresh probe is the assertion, the non-fresh one is the pin", () => {
    expectTypeOf(_freshTypo).toBeFunction();
    expectTypeOf(_nonFreshTypoCompiles).toBeFunction();
  });
});

/**
 * `$invalidate` takes CACHE KEYS, not model names — arbitrary strings, and a
 * prefix may end in `*`. There is no key set, so nothing to misspell against.
 */
describe("$invalidate takes cache keys, not model names", () => {
  const _anyStringCompiles = () => cachedClient.$invalidate("anything:at:all*");

  test("the probe above compiles, which is the pin", () => {
    expectTypeOf(_anyStringCompiles).toBeFunction();
  });
});

// ============================================================================
// FIELD REFERENCES
// ============================================================================

/**
 * `client.$fields` — which this gate probed when W8-B was written — no longer
 * exists: W8-A removed it (register D-8) and left two ways to name a column, both
 * probed here because both are surfaces a user types a field name into.
 *
 * `createModelFieldRefs` is the standing token table, and it is the import the
 * filtering docs teach, so the probe enters through `src/index` on purpose rather
 * than through `@schema/field-ref` — the alias would have compiled while the
 * documented import did not, which is the hole c3e8160 found and fixed.
 *
 * Its FIRST argument is a model NAME the caller supplies, not a key into a schema
 * — the same case as `.map()` and `.through()` elsewhere in this file. There is
 * no key set to misspell against, so the `$fields.bok` model-level probe this
 * block used to carry has no successor and is not silently dropped: it is
 * recorded here as a surface with nothing to check.
 */
describe("a field reference is keyed to the model's scalars", () => {
  const bookFields = createModelFieldRefs("book", book);

  const _keyed = () =>
    client.book.findMany({ where: { title: { equals: bookFields.title } } });

  // @ts-expect-error - "ttitle" is not a scalar of book
  const _typo = () => bookFields.ttitle;

  /**
   * The operand callback reaches the same tokens without a token table, and its
   * `ctx.fields` IS keyed — scoped to the model being filtered at that depth.
   * Probed through the client with no annotation on `ctx`, because an annotated
   * `ctx` would type the annotation rather than the call.
   */
  const _callbackKeyed = () =>
    client.book.findMany({
      where: { pages: { gt: (ctx) => ctx.fields.pages } },
    });

  const _callbackTypo = () =>
    client.book.findMany({
      // @ts-expect-error - "pagess" is not a scalar of book
      where: { pages: { gt: (ctx) => ctx.fields.pagess } },
    });

  const _callbackScope = () =>
    client.author.findMany({
      where: {
        // @ts-expect-error - inside `books.some` the ctx is book, which has no "email"
        books: { some: { title: { equals: (ctx) => ctx.fields.email } } },
      },
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_typo).toBeFunction();
    expectTypeOf(_callbackKeyed).toBeFunction();
    expectTypeOf(_callbackTypo).toBeFunction();
    expectTypeOf(_callbackScope).toBeFunction();
  });
});
