// Relation Class Implementation
// Based on specification: readme/1.4_relation_class.md
export class Relation {
    constructor() { }
    // Relation type setters
    one(target) {
        const newRelation = new Relation();
        this.copyPropertiesTo(newRelation);
        newRelation.relationType = "one";
        newRelation.targetModel = target;
        return newRelation;
    }
    many(target) {
        const newRelation = new Relation();
        this.copyPropertiesTo(newRelation);
        newRelation.relationType = "many";
        newRelation.targetModel = target;
        return newRelation;
    }
    // Field mapping
    on(fieldName) {
        this.onField = fieldName;
        return this;
    }
    ref(fieldName) {
        this.refField = fieldName;
        return this;
    }
    // Cascade options
    cascade(options) {
        this.cascadeOptions = options;
        return this;
    }
    // Many-to-many junction table configuration
    junctionTable(tableName) {
        this.junctionTableName = tableName;
        return this;
    }
    junctionField(fieldName) {
        this.junctionFieldName = fieldName;
        return this;
    }
    // Validation execution - accepts any number of validators
    async validate(data, ...validators) {
        const errors = [];
        for (const validator of validators) {
            try {
                if (typeof validator === "function") {
                    const result = await validator(data);
                    if (result !== true) {
                        errors.push(typeof result === "string" ? result : "Validation failed");
                    }
                }
            }
            catch (error) {
                errors.push(`Validation error: ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        }
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
    // Helper methods
    clone() {
        const newRelation = new Relation();
        newRelation.relationType = this.relationType;
        newRelation.targetModel = this.targetModel;
        newRelation.onField = this.onField;
        newRelation.refField = this.refField;
        newRelation.cascadeOptions = this.cascadeOptions;
        newRelation.junctionTableName = this.junctionTableName;
        newRelation.junctionFieldName = this.junctionFieldName;
        return newRelation;
    }
    // Internal getters for introspection (prefixed with ~ to keep them out of autocompletion)
    "~getRelationType"() {
        return this.relationType;
    }
    "~getTargetModel"() {
        return this.targetModel;
    }
    "~getOnField"() {
        return this.onField;
    }
    "~getRefField"() {
        return this.refField;
    }
    "~getCascadeOptions"() {
        return this.cascadeOptions;
    }
    "~getJunctionTableName"() {
        return this.junctionTableName;
    }
    "~getJunctionFieldName"() {
        return this.junctionFieldName;
    }
    copyPropertiesTo(newRelation) {
        newRelation.relationType = this.relationType;
        newRelation.targetModel = this.targetModel;
        newRelation.onField = this.onField;
        newRelation.refField = this.refField;
        newRelation.cascadeOptions = this.cascadeOptions;
        newRelation.junctionTableName = this.junctionTableName;
        newRelation.junctionFieldName = this.junctionFieldName;
    }
}
//# sourceMappingURL=relation.js.map