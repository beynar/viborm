// Schema Builder Entry Point
// Based on specification: readme/1_schema_builder.md
import { Model } from "./model.js";
import { BaseField, StringField, NumberField, BooleanField, BigIntField, DateTimeField, JsonField, BlobField, EnumField, } from "./field.js";
import { Relation } from "./relation.js";
export class SchemaBuilder {
    // Create a new model
    model(name, fields) {
        return new Model(name, fields);
    }
    // Create specific field types
    string() {
        return new StringField();
    }
    boolean() {
        return new BooleanField();
    }
    int() {
        return new NumberField("int");
    }
    bigInt() {
        return new BigIntField();
    }
    float() {
        return new NumberField("float");
    }
    decimal(precision, scale) {
        return new NumberField("decimal");
    }
    dateTime() {
        return new DateTimeField();
    }
    json() {
        return new JsonField();
    }
    blob() {
        return new BlobField();
    }
    enum(values) {
        return new EnumField(values);
    }
    // Relation factory
    get relation() {
        return {
            one: (target) => new Relation().one(target),
            many: (target) => new Relation().many(target),
        };
    }
}
// Export the main schema builder instance
export const s = new SchemaBuilder();
// Re-export classes for advanced usage
export { Model, BaseField, StringField, NumberField, BooleanField, BigIntField, DateTimeField, JsonField, BlobField, EnumField, Relation, };
//# sourceMappingURL=index.js.map