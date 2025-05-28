import { AdapterInterface } from "../client";
import { Operation } from "../types/client/operations/defintion";

interface StoredRecord {
  [key: string]: any;
}

export class MockAdapter implements AdapterInterface {
  private storage = new Map<string, Map<string, StoredRecord>>();
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
    console.log("MockAdapter: Connected");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    console.log("MockAdapter: Disconnected");
  }

  private ensureConnected() {
    if (!this.connected) {
      throw new Error("Adapter not connected. Call connect() first.");
    }
  }

  private getModelStorage(modelName: string): Map<string, StoredRecord> {
    if (!this.storage.has(modelName)) {
      this.storage.set(modelName, new Map());
    }
    return this.storage.get(modelName)!;
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  private matchesWhere(record: StoredRecord, where: any): boolean {
    if (!where) return true;

    for (const [key, condition] of Object.entries(where)) {
      const value = record[key];

      if (typeof condition === "object" && condition !== null) {
        // Handle operators like { contains: "..." }, { gte: 5 }, etc.
        for (const [op, opValue] of Object.entries(condition)) {
          switch (op) {
            case "equals":
              if (value !== opValue) return false;
              break;
            case "contains":
              if (!String(value).includes(String(opValue))) return false;
              break;
            case "startsWith":
              if (!String(value).startsWith(String(opValue))) return false;
              break;
            case "endsWith":
              if (!String(value).endsWith(String(opValue))) return false;
              break;
            case "gte":
              if (!(value >= opValue)) return false;
              break;
            case "gt":
              if (!(value > opValue)) return false;
              break;
            case "lte":
              if (!(value <= opValue)) return false;
              break;
            case "lt":
              if (!(value < opValue)) return false;
              break;
            case "in":
              if (!Array.isArray(opValue) || !opValue.includes(value))
                return false;
              break;
            case "notIn":
              if (Array.isArray(opValue) && opValue.includes(value))
                return false;
              break;
            case "not":
              if (value === opValue) return false;
              break;
            default:
              console.warn(`Unknown operator: ${op}`);
          }
        }
      } else {
        // Direct equality check
        if (value !== condition) return false;
      }
    }

    return true;
  }

  private applySelect(record: StoredRecord, select?: any): StoredRecord {
    if (!select) return record;

    const result: StoredRecord = {};
    for (const [key, include] of Object.entries(select)) {
      if (include === true && record.hasOwnProperty(key)) {
        result[key] = record[key];
      }
    }
    return result;
  }

  async execute(operation: {
    type: Operation;
    model: string;
    payload: any;
  }): Promise<any> {
    this.ensureConnected();

    const { type, model, payload } = operation;
    const storage = this.getModelStorage(model);

    console.log(`MockAdapter: Executing ${type} on ${model}`, payload);

    switch (type) {
      case "findUnique":
      case "findUniqueOrThrow": {
        const { where, select } = payload;
        for (const record of storage.values()) {
          if (this.matchesWhere(record, where)) {
            return this.applySelect(record, select);
          }
        }

        if (type === "findUniqueOrThrow") {
          throw new Error(`Record not found for model ${model}`);
        }
        return null;
      }

      case "findFirst":
      case "findFirstOrThrow": {
        const { where, select, orderBy } = payload;
        const records = Array.from(storage.values()).filter((record) =>
          this.matchesWhere(record, where)
        );

        if (orderBy) {
          // Simple ordering implementation
          records.sort((a, b) => {
            for (const [field, direction] of Object.entries(orderBy)) {
              const aVal = a[field];
              const bVal = b[field];
              if (aVal !== bVal) {
                if (direction === "desc") {
                  return bVal > aVal ? 1 : -1;
                } else {
                  return aVal > bVal ? 1 : -1;
                }
              }
            }
            return 0;
          });
        }

        const record = records[0];
        if (!record) {
          if (type === "findFirstOrThrow") {
            throw new Error(`Record not found for model ${model}`);
          }
          return null;
        }

        return this.applySelect(record, select);
      }

      case "findMany": {
        const { where, select, orderBy, take, skip } = payload;
        let records = Array.from(storage.values()).filter((record) =>
          this.matchesWhere(record, where)
        );

        if (orderBy) {
          records.sort((a, b) => {
            for (const [field, direction] of Object.entries(orderBy)) {
              const aVal = a[field];
              const bVal = b[field];
              if (aVal !== bVal) {
                if (direction === "desc") {
                  return bVal > aVal ? 1 : -1;
                } else {
                  return aVal > bVal ? 1 : -1;
                }
              }
            }
            return 0;
          });
        }

        if (skip) {
          records = records.slice(skip);
        }

        if (take) {
          records = records.slice(0, take);
        }

        return records.map((record) => this.applySelect(record, select));
      }

      case "create": {
        const { data, select } = payload;
        const id = data.id || this.generateId();
        const record = { ...data, id };

        storage.set(id, record);
        return this.applySelect(record, select);
      }

      case "update": {
        const { where, data, select } = payload;
        for (const [id, record] of storage.entries()) {
          if (this.matchesWhere(record, where)) {
            const updatedRecord = { ...record, ...data };
            storage.set(id, updatedRecord);
            return this.applySelect(updatedRecord, select);
          }
        }
        throw new Error(`Record not found for update in model ${model}`);
      }

      case "delete": {
        const { where, select } = payload;
        for (const [id, record] of storage.entries()) {
          if (this.matchesWhere(record, where)) {
            storage.delete(id);
            return this.applySelect(record, select);
          }
        }
        throw new Error(`Record not found for delete in model ${model}`);
      }

      case "deleteMany": {
        const { where } = payload;
        let deletedCount = 0;
        for (const [id, record] of storage.entries()) {
          if (this.matchesWhere(record, where)) {
            storage.delete(id);
            deletedCount++;
          }
        }
        return { count: deletedCount };
      }

      case "count": {
        const { where } = payload;
        let count = 0;
        for (const record of storage.values()) {
          if (this.matchesWhere(record, where)) {
            count++;
          }
        }
        return count;
      }

      case "upsert": {
        const { where, create, update, select } = payload;

        // Try to find existing record
        for (const [id, record] of storage.entries()) {
          if (this.matchesWhere(record, where)) {
            // Update existing
            const updatedRecord = { ...record, ...update };
            storage.set(id, updatedRecord);
            return this.applySelect(updatedRecord, select);
          }
        }

        // Create new
        const id = create.id || this.generateId();
        const newRecord = { ...create, id };
        storage.set(id, newRecord);
        return this.applySelect(newRecord, select);
      }

      default:
        throw new Error(`Operation ${type} not implemented in MockAdapter`);
    }
  }

  // Helper methods for testing
  clearStorage(): void {
    this.storage.clear();
  }

  getStorageFor(model: string): StoredRecord[] {
    const storage = this.storage.get(model);
    return storage ? Array.from(storage.values()) : [];
  }

  seedData(model: string, records: StoredRecord[]): void {
    const storage = this.getModelStorage(model);
    records.forEach((record) => {
      const id = record.id || this.generateId();
      storage.set(id, { ...record, id });
    });
  }
}
