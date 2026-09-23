import { s } from "@schema";
import type {
  GeneratedRecurrenceOperation,
  RecurrenceRecipe,
  RecurrenceWorld,
} from "./recurrence-world";
import { compareText } from "./recurrence-world";

function chapterId(recipe: RecurrenceRecipe, operation: number, path: string) {
  return `c-${recipe.seed}-${operation}-${path}`;
}

function chapterBody(
  recipe: RecurrenceRecipe,
  operation: number,
  level: number,
  region: string,
  code: string,
  root: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: chapterId(recipe, operation, `s${level}`),
    title: `chapter-${level}`,
    ...(root ? {} : { bookRegion: region, bookCode: code }),
  };
  if (level >= recipe.depth) return body;
  body.children = {
    create: [
      chapterBody(recipe, operation, level + 1, region, code, false),
      ...Array.from({ length: recipe.fanout }, (_, index) => ({
        id: chapterId(recipe, operation, `s${level}-f${index}`),
        title: `chapter-leaf-${level}-${index}`,
        bookRegion: region,
        bookCode: code,
      })),
    ],
  };
  return body;
}

function expectedChapterRows(
  recipe: RecurrenceRecipe,
  operation: number,
  region: string,
  code: string
) {
  const rows: {
    id: string;
    title: string;
    bookRegion: string;
    bookCode: string;
    parentId: string | null;
  }[] = [];
  for (let level = 0; level <= recipe.depth; level++) {
    const id = chapterId(recipe, operation, `s${level}`);
    rows.push({
      id,
      title: `chapter-${level}`,
      bookRegion: region,
      bookCode: code,
      parentId:
        level === 0 ? null : chapterId(recipe, operation, `s${level - 1}`),
    });
    if (level === recipe.depth) continue;
    for (let index = 0; index < recipe.fanout; index++)
      rows.push({
        id: chapterId(recipe, operation, `s${level}-f${index}`),
        title: `chapter-leaf-${level}-${index}`,
        bookRegion: region,
        bookCode: code,
        parentId: id,
      });
  }
  return rows;
}

export function recurrenceCompoundWorld(
  recipe: RecurrenceRecipe
): RecurrenceWorld {
  const book = s
    .model({
      region: s.string(),
      code: s.string(),
      isbn: s.string().unique(),
      title: s.string(),
      chapters: s.toMany(() => chapter),
    })
    .id(["region", "code"])
    .map("g3_generated_recurrence_books");
  const chapter = s
    .model({
      id: s.string().id(),
      title: s.string(),
      bookRegion: s.string(),
      bookCode: s.string(),
      book: s
        .toOne(() => book)
        .fields("bookRegion", "bookCode")
        .references("region", "code"),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => chapter)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => chapter),
    })
    .map("g3_generated_recurrence_chapters");
  const schema = { book, chapter };
  const initialBooks = Array.from(
    { length: recipe.operations },
    (_, operation) => ({
      region: `old-r-${operation}`,
      code: `old-c-${operation}`,
      isbn: `isbn-${recipe.seed}-${operation}`,
      title: "before",
    })
  );
  const operations = initialBooks.map(
    (stored, operation): GeneratedRecurrenceOperation => {
      const region = `new-r-${operation}`;
      const code = `new-c-${operation}`;
      return {
        model: "book",
        operation: "update",
        args: {
          where: { isbn: stored.isbn },
          data: {
            region,
            code,
            title: "after",
            chapters: {
              create: chapterBody(recipe, operation, 0, region, code, true),
            },
          },
          select: { region: true, code: true },
        },
        expected: { region, code },
      };
    }
  );
  const compareBook = (
    left: { region: string; code: string },
    right: { region: string; code: string }
  ) => {
    const regionOrder = compareText(left.region, right.region);
    return regionOrder === 0
      ? compareText(left.code, right.code)
      : regionOrder;
  };
  const finalBooks = initialBooks
    .map((stored, operation) =>
      recipe.fault !== "none" && operation === 0
        ? stored
        : {
            region: `new-r-${operation}`,
            code: `new-c-${operation}`,
            isbn: stored.isbn,
            title: "after",
          }
    )
    .sort(compareBook);
  const finalChapters = initialBooks
    .flatMap((_, operation) =>
      recipe.fault !== "none" && operation === 0
        ? []
        : expectedChapterRows(
            recipe,
            operation,
            `new-r-${operation}`,
            `new-c-${operation}`
          )
    )
    .sort((left, right) => compareText(left.id, right.id));
  const initial = {
    books: [...initialBooks].sort(compareBook),
    chapters: [],
  };
  const final = { books: finalBooks, chapters: finalChapters };
  return {
    schema,
    operations,
    initial,
    final,
    seed(database) {
      database.exec(`
        CREATE TABLE g3_generated_recurrence_books(
          region TEXT NOT NULL,
          code TEXT NOT NULL,
          isbn TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          PRIMARY KEY(region,code)
        ) STRICT;
        CREATE TABLE g3_generated_recurrence_chapters(
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          bookRegion TEXT NOT NULL,
          bookCode TEXT NOT NULL,
          parentId TEXT REFERENCES g3_generated_recurrence_chapters(id),
          FOREIGN KEY(bookRegion,bookCode)
            REFERENCES g3_generated_recurrence_books(region,code)
            ON UPDATE CASCADE
        ) STRICT;
      `);
      const insert = database.prepare(
        "INSERT INTO g3_generated_recurrence_books VALUES(?,?,?,?)"
      );
      for (const row of initialBooks)
        insert.run(row.region, row.code, row.isbn, row.title);
    },
    inspect(database) {
      return {
        books: database
          .prepare(
            "SELECT region,code,isbn,title FROM g3_generated_recurrence_books ORDER BY region,code"
          )
          .all(),
        chapters: database
          .prepare(
            "SELECT id,title,bookRegion,bookCode,parentId FROM g3_generated_recurrence_chapters ORDER BY id"
          )
          .all(),
      };
    },
  };
}
