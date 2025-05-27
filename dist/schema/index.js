// Schema Builder Entry Point
// Based on specification: readme/1_schema_builder.md
import { Model } from "./model.js";
import { BaseField, StringField, NumberField, BooleanField, BigIntField, DateTimeField, JsonField, BlobField, EnumField, } from "./fields/index.js";
import { string } from "./fields/string.js";
import { int, float, decimal } from "./fields/number.js";
import { boolean } from "./fields/boolean.js";
import { bigint } from "./fields/bigint.js";
import { datetime } from "./fields/datetime.js";
import { json } from "./fields/json.js";
import { blob } from "./fields/blob.js";
import { enumField } from "./fields/enum.js";
import { Relation } from "./relation.js";
export class SchemaBuilder {
    // Create a new model
    model(name, fields) {
        return new Model(name, fields);
    }
    // Create specific field types
    string() {
        return string();
    }
    boolean() {
        return boolean();
    }
    int() {
        return int();
    }
    bigInt() {
        return bigint();
    }
    float() {
        return float();
    }
    decimal() {
        return decimal();
    }
    dateTime() {
        return datetime();
    }
    json() {
        return json();
    }
    blob() {
        return blob();
    }
    enum(values) {
        return enumField(values);
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