import { s } from "@schema";
import type {
  GeneratedRecurrenceOperation,
  RecurrenceRecipe,
  RecurrenceWorld,
} from "./recurrence-world";
import { compareText } from "./recurrence-world";

type VariantEntry =
  | { type: "book"; data: { id: string; title: string } }
  | { type: "note"; data: { id: string; body: string } };

function crateId(recipe: RecurrenceRecipe, operation: number, level: number) {
  return `crate-${recipe.seed}-${operation}-${level}`;
}

function variantEntry(
  recipe: RecurrenceRecipe,
  operation: number,
  level: number,
  index: number
): VariantEntry {
  const kind = (level + index) % 2 === 0 ? "book" : "note";
  const id = `${kind}-${recipe.seed}-${operation}-${level}-${index}`;
  return kind === "book"
    ? { type: kind, data: { id, title: `title-${level}-${index}` } }
    : { type: kind, data: { id, body: `body-${level}-${index}` } };
}

function crateBody(
  recipe: RecurrenceRecipe,
  operation: number,
  level: number
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: crateId(recipe, operation, level),
    label: `crate-${level}`,
    items: {
      create: Array.from({ length: recipe.fanout + 1 }, (_, index) =>
        variantEntry(recipe, operation, level, index)
      ),
    },
  };
  if (level < recipe.depth)
    body.children = {
      create: crateBody(recipe, operation, level + 1),
    };
  return body;
}

export function recurrenceVariantWorld(
  recipe: RecurrenceRecipe
): RecurrenceWorld {
  const book = s
    .model({ id: s.string().id(), title: s.string() })
    .map("g3_generated_recurrence_variant_books");
  const note = s
    .model({ id: s.string().id(), body: s.string() })
    .map("g3_generated_recurrence_variant_notes");
  const crate = s
    .model({
      id: s.string().id(),
      label: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => crate)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => crate),
      items: s
        .toMany(
          { book: () => book, note: () => note },
          { values: { book: "g3.book", note: "g3.note" } }
        )
        .through({
          book: {
            table: "g3_generated_recurrence_crate_books",
            source: "crateId",
            target: "bookId",
          },
          note: {
            table: "g3_generated_recurrence_crate_notes",
            source: "crateId",
            target: "noteId",
          },
        }),
    })
    .map("g3_generated_recurrence_crates");
  const schema = { crate, book, note };
  const operations = Array.from(
    { length: recipe.operations },
    (_, operation): GeneratedRecurrenceOperation => ({
      model: "crate",
      operation: "create",
      args: {
        data: {
          ...crateBody(recipe, operation, 0),
        },
        select: { id: true },
      },
      expected: { id: crateId(recipe, operation, 0) },
    })
  );
  const crates: {
    id: string;
    label: string;
    parentId: string | null;
  }[] = [];
  const books: { id: string; title: string }[] = [];
  const notes: { id: string; body: string }[] = [];
  const crateBooks: { crateId: string; bookId: string }[] = [];
  const crateNotes: { crateId: string; noteId: string }[] = [];
  for (let operation = 0; operation < recipe.operations; operation++) {
    if (recipe.fault !== "none" && operation === 0) continue;
    for (let level = 0; level <= recipe.depth; level++) {
      const currentCrate = crateId(recipe, operation, level);
      crates.push({
        id: currentCrate,
        label: `crate-${level}`,
        parentId: level === 0 ? null : crateId(recipe, operation, level - 1),
      });
      for (let index = 0; index <= recipe.fanout; index++) {
        const entry = variantEntry(recipe, operation, level, index);
        if (entry.type === "book") {
          books.push(entry.data);
          crateBooks.push({ crateId: currentCrate, bookId: entry.data.id });
        } else {
          notes.push(entry.data);
          crateNotes.push({ crateId: currentCrate, noteId: entry.data.id });
        }
      }
    }
  }
  const byId = <T extends { id: string }>(left: T, right: T) =>
    compareText(left.id, right.id);
  const initial = {
    crates: [],
    books: [],
    notes: [],
    crateBooks: [],
    crateNotes: [],
  };
  const final = {
    crates: crates.sort(byId),
    books: books.sort(byId),
    notes: notes.sort(byId),
    crateBooks: crateBooks.sort((left, right) =>
      compareText(
        `${left.crateId}:${left.bookId}`,
        `${right.crateId}:${right.bookId}`
      )
    ),
    crateNotes: crateNotes.sort((left, right) =>
      compareText(
        `${left.crateId}:${left.noteId}`,
        `${right.crateId}:${right.noteId}`
      )
    ),
  };
  return {
    schema,
    operations,
    initial,
    final,
    seed(database) {
      database.exec(`
        CREATE TABLE g3_generated_recurrence_crates(
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          parentId TEXT REFERENCES g3_generated_recurrence_crates(id)
        ) STRICT;
        CREATE TABLE g3_generated_recurrence_variant_books(
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL
        ) STRICT;
        CREATE TABLE g3_generated_recurrence_variant_notes(
          id TEXT PRIMARY KEY,
          body TEXT NOT NULL
        ) STRICT;
        CREATE TABLE g3_generated_recurrence_crate_books(
          crateId TEXT NOT NULL REFERENCES g3_generated_recurrence_crates(id),
          bookId TEXT NOT NULL UNIQUE REFERENCES g3_generated_recurrence_variant_books(id),
          PRIMARY KEY(crateId,bookId)
        ) STRICT;
        CREATE TABLE g3_generated_recurrence_crate_notes(
          crateId TEXT NOT NULL REFERENCES g3_generated_recurrence_crates(id),
          noteId TEXT NOT NULL UNIQUE REFERENCES g3_generated_recurrence_variant_notes(id),
          PRIMARY KEY(crateId,noteId)
        ) STRICT;
      `);
    },
    inspect(database) {
      return {
        crates: database
          .prepare(
            "SELECT id,label,parentId FROM g3_generated_recurrence_crates ORDER BY id"
          )
          .all(),
        books: database
          .prepare(
            "SELECT id,title FROM g3_generated_recurrence_variant_books ORDER BY id"
          )
          .all(),
        notes: database
          .prepare(
            "SELECT id,body FROM g3_generated_recurrence_variant_notes ORDER BY id"
          )
          .all(),
        crateBooks: database
          .prepare(
            "SELECT crateId,bookId FROM g3_generated_recurrence_crate_books ORDER BY crateId,bookId"
          )
          .all(),
        crateNotes: database
          .prepare(
            "SELECT crateId,noteId FROM g3_generated_recurrence_crate_notes ORDER BY crateId,noteId"
          )
          .all(),
      };
    },
  };
}
