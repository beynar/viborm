// Number Field Class
// Number-specific field with validation methods for numeric data
import { BaseField } from "./base.js";
export class NumberField extends BaseField {
    constructor(fieldType = "int") {
        super();
        this.fieldType = fieldType;
    }
    createInstance() {
        return new NumberField(this.fieldType);
    }
    // Number-specific validation methods
    min(value) {
        this.minValue = value;
        return this;
    }
    max(value) {
        this.maxValue = value;
        return this;
    }
    // Precision and scale for decimal fields
    setPrecision(precision, scale) {
        this.precision = precision;
        if (scale !== undefined) {
            this.scale = scale;
        }
        return this;
    }
    // Auto-generation for numbers
    get auto() {
        return {
            increment: () => {
                this.autoGenerate = "increment";
                return this;
            },
        };
    }
    // Override validation to include number-specific checks
    async validate(value, ...validators) {
        const baseResult = await super.validate(value, ...validators);
        const errors = [...(baseResult.errors || [])];
        if ((this.fieldType === "int" ||
            this.fieldType === "float" ||
            this.fieldType === "decimal") &&
            typeof value === "number") {
            if (this.minValue !== undefined && value < this.minValue) {
                errors.push(`Value must be at least ${this.minValue}`);
            }
            if (this.maxValue !== undefined && value > this.maxValue) {
                errors.push(`Value must be at most ${this.maxValue}`);
            }
            // Integer-specific validation
            if (this.fieldType === "int" && !Number.isInteger(value)) {
                errors.push("Value must be an integer");
            }
        }
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
    copyPropertiesTo(target) {
        super.copyPropertiesTo(target);
        if (target instanceof NumberField) {
            target.minValue = this.minValue;
            target.maxValue = this.maxValue;
            target.precision = this.precision;
            target.scale = this.scale;
        }
    }
    "~getMinValue"() {
        return this.minValue;
    }
    "~getMaxValue"() {
        return this.maxValue;
    }
    "~getPrecision"() {
        return this.precision;
    }
    "~getScale"() {
        return this.scale;
    }
}
//# sourceMappingURL=number.js.map