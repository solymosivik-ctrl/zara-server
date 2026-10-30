import type { RepairIncidentRecord } from "./incident-model";

export interface RepairIncidentStore {
  create(record: RepairIncidentRecord): Promise<void>;
  get(id: string): Promise<RepairIncidentRecord | undefined>;
  update(record: RepairIncidentRecord): Promise<void>;
}

/**
 * The first release keeps a bounded incident index in memory and writes the
 * same sanitized records to structured server logs. No audio, transcript,
 * request body, patch, or credential is persisted here.
 */
export class MemoryRepairIncidentStore implements RepairIncidentStore {
  private readonly records = new Map<string, RepairIncidentRecord>();

  async create(record: RepairIncidentRecord): Promise<void> {
    this.records.set(record.id, record);
    while (this.records.size > 500) {
      const oldest = this.records.keys().next().value;
      if (!oldest) break;
      this.records.delete(oldest);
    }
  }

  async get(id: string): Promise<RepairIncidentRecord | undefined> {
    return this.records.get(id);
  }

  async update(record: RepairIncidentRecord): Promise<void> {
    if (this.records.has(record.id)) this.records.set(record.id, record);
  }
}