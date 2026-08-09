import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type BindValue = string | number | bigint | null | ArrayBuffer | Uint8Array;

class SqliteStatement {
  private values: BindValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...values: BindValue[]): SqliteStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return {
      results: this.database.prepare(this.sql).all(...this.values) as T[],
      success: true,
      meta: {},
    };
  }

  async run(): Promise<{ results: unknown[]; success: true; meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

export class SqliteD1 {
  readonly database = new DatabaseSync(':memory:');

  constructor() {
    this.database.exec('PRAGMA foreign_keys = ON;');
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch<T = unknown>(statements: SqliteStatement[]): Promise<Array<{ results: T[]; meta: { changes: number } }>> {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results as Array<{ results: T[]; meta: { changes: number } }>;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }
}

export function applyMigrations(db: SqliteD1, from = 1, through = 8): void {
  for (let number = from; number <= through; number++) {
    const prefix = String(number).padStart(4, '0');
    const filename = new URL(`../migrations/${prefix}_${migrationNames[number]}.sql`, import.meta.url);
    db.exec(readFileSync(filename, 'utf8'));
  }
}

const migrationNames: Record<number, string> = {
  1: 'init',
  2: 'engine',
  3: 'realtime_model',
  4: 'realtime_voice',
  5: 'closures',
  6: 'engine_profiles',
  7: 'abuse_limits',
  8: 'calm_studio_foundation',
};
