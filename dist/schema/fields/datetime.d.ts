import { BaseField } from "./base.js";
export declare class DateTimeField extends BaseField<Date> {
    constructor();
    protected createInstance<U>(): BaseField<U>;
    get auto(): {
        now: () => this;
        updatedAt: () => this;
    };
}
//# sourceMappingURL=datetime.d.ts.map