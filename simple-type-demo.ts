// Simplified Type System Demo
// Shows basic type inference with field configuration

// Basic field state type
interface FieldConfig<
  T,
  IsNullable extends boolean = false,
  IsList extends boolean = false
> {
  baseType: T;
  isNullable: IsNullable;
  isList: IsList;
}

// Type inference helper
type InferFieldType<Config extends FieldConfig<any, any, any>> =
  Config["isList"] extends true
    ? Config["isNullable"] extends true
      ? Config["baseType"][] | null
      : Config["baseType"][]
    : Config["isNullable"] extends true
    ? Config["baseType"] | null
    : Config["baseType"];

// Basic field class with type inference
class Field<Config extends FieldConfig<any, any, any>> {
  constructor(private config: Config) {}

  nullable(): Field<FieldConfig<Config["baseType"], true, Config["isList"]>> {
    return new Field({
      baseType: this.config.baseType,
      isNullable: true,
      isList: this.config.isList,
    });
  }

  list(): Field<FieldConfig<Config["baseType"], Config["isNullable"], true>> {
    return new Field({
      baseType: this.config.baseType,
      isNullable: this.config.isNullable,
      isList: true,
    });
  }

  get infer(): InferFieldType<Config> {
    return {} as InferFieldType<Config>;
  }
}

// Factory function
function string(): Field<FieldConfig<string, false, false>> {
  return new Field({ baseType: "", isNullable: false, isList: false });
}

// Demonstration
const name = string();
type NameType = typeof name.infer; // string

const optionalName = string().nullable();
type OptionalNameType = typeof optionalName.infer; // string | null

const tags = string().list();
type TagsType = typeof tags.infer; // string[]

const optionalTags = string().list().nullable();
type OptionalTagsType = typeof optionalTags.infer; // string[] | null

// Show usage
function demonstrateSimpleTypes() {
  const nameValue: NameType = "Alice";
  const optionalNameValue: OptionalNameType = null;
  const tagsValue: TagsType = ["tag1", "tag2"];
  const optionalTagsValue: OptionalTagsType = null;

  console.log({
    nameValue,
    optionalNameValue,
    tagsValue,
    optionalTagsValue,
  });
}

// Schema example
const userSchema = {
  id: string(),
  email: string(),
  name: string(),
  bio: string().nullable(),
  tags: string().list(),
  categories: string().list().nullable(),
};

// Infer user type from schema
type UserFromSchema = {
  [K in keyof typeof userSchema]: (typeof userSchema)[K]["infer"];
};

// This resolves to:
// type UserFromSchema = {
//   id: string;
//   email: string;
//   name: string;
//   bio: string | null;
//   tags: string[];
//   categories: string[] | null;
// }

export { demonstrateSimpleTypes, userSchema };
export type { UserFromSchema };
