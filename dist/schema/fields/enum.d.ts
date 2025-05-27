import { BaseField } from "./base.js";
export declare class EnumField<TEnum extends readonly (string | number)[]> extends BaseField<TEnum[number]> {
    private enumValues;
    constructor(values: TEnum);
    protected createInstance<U>(): BaseField<U>;
    "~getEnumValues"(): TEnum;
}
//# sourceMappingURL=enum.d.ts.map