// Operation Type Definitions
// For create, update, delete, and other database operations
// Error types
export class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = "NotFoundError";
    }
}
export class UniqueConstraintViolationError extends Error {
    constructor(message, field) {
        super(message);
        this.field = field;
        this.name = "UniqueConstraintViolationError";
    }
}
export class ForeignKeyConstraintViolationError extends Error {
    constructor(message, field) {
        super(message);
        this.field = field;
        this.name = "ForeignKeyConstraintViolationError";
    }
}
