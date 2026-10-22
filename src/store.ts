import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StoredSnapshot {
  revision: number;
  json: string;
  blob: Uint8Array | null;
}

export class SnapshotStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(snapshots)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'blob')) {
      this.db.exec('ALTER TABLE snapshots ADD COLUMN blob BLOB');
    }
  }

  load(): StoredSnapshot | undefined {
    const row = this.db.prepare('SELECT revision, json, blob FROM snapshots WHERE id = 1').get();
    if (!row) return undefined;
    if (typeof row.revision !== 'number' || typeof row.json !== 'string') {
      throw new Error('Invalid persisted snapshot schema');
    }
    return { revision: row.revision, json: row.json, blob: row.blob instanceof Uint8Array ? row.blob : null };
  }

  save(expectedRevision: number, json: string, blob: Uint8Array | null = null): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.load();
      const revision = existing?.revision ?? 0;
      if (revision !== expectedRevision) {
        throw new Error('STATE_CONFLICT: another process changed the database; reopen the runtime');
      }
      const next = revision + 1;
      this.db.prepare(`
        INSERT INTO snapshots (id, revision, json, blob) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, json = excluded.json, blob = excluded.blob
      `).run(next, json, blob);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
