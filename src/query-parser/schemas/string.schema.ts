import { ArkError, BaseType, Type, type, scope, bindThis } from "arktype";
import { BaseCompletions } from "arktype/internal/parser/string.ts";

const stringSchema = type.string;
const nullableStringSchema = stringSchema.or("null");
const optionalStringSchema = stringSchema.optional;
const optionalNullableStringSchema = nullableStringSchema.optional;

const stringUpdateSchema = type({
  set: optionalStringSchema,
}).or(optionalStringSchema);

const stringFilterSchema = type({
  equals: nullableStringSchema,
  contains: stringSchema,
  startsWith: stringSchema,
  endsWith: stringSchema,
  lt: stringSchema,
  lte: stringSchema,
  gt: stringSchema,
  gte: stringSchema,
})
  .partial()
  .or(stringSchema);

const nullableStringFilterSchema = type({
  equals: nullableStringSchema,
  contains: nullableStringSchema,
  startsWith: nullableStringSchema,
  endsWith: nullableStringSchema,
  lt: nullableStringSchema,
  lte: nullableStringSchema,
  gt: nullableStringSchema,
  gte: nullableStringSchema,
})
  .partial()
  .or(nullableStringSchema.pipe((v) => ({ equals: v })));

const baseNullableFilter = <T, K>(t: BaseType<T, K>) => {
  return type({
    equals: t,
    contains: t,
    startsWith: t,
    endsWith: t,
    lt: t,
    lte: t,
    gt: t,
    gte: t,
  })
    .partial()
    .or(t.pipe((v) => ({ equals: v })));
};

const nullableStringFilter = baseNullableFilter(nullableStringSchema);

const value = nullableStringFilter({
  contains: "test",
});

if (value instanceof type.errors) {
  console.log(value);
} else {
  for (const key in value) {
    if (value[key]) {
      console.log(key, value[key]);
    }
  }
}

const user = type({
  name: stringSchema,
  email: stringSchema,
  friends: () => user.array(),
  posts: () => post.array(),
});

const post = type({
  title: stringSchema,
  content: stringSchema,
  author: () => user,
  comments: () => comment.array(),
  likers: () => user.array(),
});

const comment = type({
  content: stringSchema,
  author: () => user,
});
const out = user({});

const stringUpdate = type("string").or("null");

class Field {
  schemas = {
    update: stringUpdate,
  };
}
const field = new Field();

const test = type({
  string: field.schemas.update,
});

class Model<TFields extends Record<string, Field> = Record<string, Field>> {
  fields: TFields;

  constructor(fields: TFields) {
    this.fields = fields;
  }
}

const model = new Model({
  name: field,
});

type StringKeyof<T> = keyof T extends string ? keyof T : never;

export type KeyAsString<BaseType> = `${Extract<
  keyof BaseType,
  string | number
>}`;

type Infer<T extends Model> = T extends Model<infer F>
  ? {
      [K in keyof F]: F[K]["schemas"]["update"];
    }
  : any;

const buildTypeFor_____ = <const T extends Model>(model: T) => {
  const schema = Object.entries(model.fields).reduce((acc, [key, value]) => {
    Object.assign(acc, {
      [key]: value.schemas.update,
    });
    return acc;
  }, {});
  // return schema;
  return type(schema) as unknown as BaseType<Infer<T>>;
};

const modelUpdate = buildTypeFor_____(model);

type test1 = typeof modelUpdate.inferIn;
