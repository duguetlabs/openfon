// A tiny in-memory stand-in for D1, just wide enough for the statements the
// worker's abuse limits and call sweep issue. It dispatches on the SQL text
// rather than parsing it, so it stays honest: change a query in src/index.ts and
// the matching branch here stops firing loudly instead of silently passing.
//
// Timestamps are stored as epoch ms and compared numerically, so tests can move
// time with vi.setSystemTime() instead of sleeping.

type Row = Record<string, unknown>;

const OFFSETS: Record<string, number> = {
  '-15 minutes': -15 * 60_000,
  '-30 minutes': -30 * 60_000,
  '-60 minutes': -60 * 60_000,
  '-1 day': -86_400_000,
};

function cutoff(offset: unknown): number {
  const ms = OFFSETS[String(offset)];
  if (ms === undefined) throw new Error(`fake-d1: unknown datetime offset ${String(offset)}`);
  return Date.now() + ms;
}

export interface FakeCall extends Row {
  id: string;
  business_id: string;
  status: string;
  started_at: number;
  connected_at: number | null;
}

export class FakeD1 {
  users: Row[] = [];
  sessions: Row[] = [];
  businesses: Row[] = [];
  calls: FakeCall[] = [];
  counters = new Map<string, number>(); // `${bucket}|${window_start}` -> count

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql.replace(/\s+/g, ' ').trim());
  }

  async batch(stmts: FakeStatement[]): Promise<{ meta: { changes: number } }[]> {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }

  seedBusiness(b: Partial<Row> & { id: string; slug: string }): Row {
    const row = { max_concurrent_calls: 5, max_calls_per_day: 500, ...b };
    this.businesses.push(row);
    return row;
  }

  seedCall(c: Partial<FakeCall> & { id: string; business_id: string }): FakeCall {
    const row: FakeCall = { status: 'active', started_at: Date.now(), connected_at: null, ...c };
    this.calls.push(row);
    return row;
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.exec().rows[0] as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.exec().rows as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: this.exec().changes } };
  }

  private exec(): { rows: Row[]; changes: number } {
    const q = this.sql;
    const a = this.args;

    // ---- rate_counters ----
    if (q.startsWith('INSERT INTO rate_counters')) {
      const key = `${a[0]}|${a[1]}`;
      const n = (this.db.counters.get(key) ?? 0) + 1;
      this.db.counters.set(key, n);
      return { rows: [{ count: n }], changes: 1 };
    }
    if (q.startsWith('SELECT count FROM rate_counters')) {
      const n = this.db.counters.get(`${a[0]}|${a[1]}`);
      return { rows: n === undefined ? [] : [{ count: n }], changes: 0 };
    }
    if (q.startsWith('DELETE FROM rate_counters WHERE bucket')) {
      let changes = 0;
      for (const k of [...this.db.counters.keys()]) {
        if (k.startsWith(`${a[0]}|`)) (this.db.counters.delete(k), changes++);
      }
      return { rows: [], changes };
    }
    if (q.startsWith('DELETE FROM rate_counters WHERE window_start')) {
      let changes = 0;
      for (const k of [...this.db.counters.keys()]) {
        if (Number(k.split('|')[1]) < Number(a[0])) (this.db.counters.delete(k), changes++);
      }
      return { rows: [], changes };
    }

    // ---- businesses ----
    if (q.startsWith('SELECT id, max_concurrent_calls, max_calls_per_day FROM businesses WHERE slug')) {
      const b = this.db.businesses.find((x) => x.slug === a[0]);
      return { rows: b ? [b] : [], changes: 0 };
    }

    // ---- calls ----
    if (q.startsWith('SELECT COUNT(*) AS n FROM calls') && q.includes('connected_at IS NOT NULL')) {
      const since = cutoff(a[1]);
      const n = this.db.calls.filter(
        (c) => c.business_id === a[0] && c.status === 'active' && c.connected_at !== null && c.started_at > since
      ).length;
      return { rows: [{ n }], changes: 0 };
    }
    if (q.startsWith('SELECT COUNT(*) AS n FROM calls')) {
      const since = cutoff('-1 day');
      const n = this.db.calls.filter((c) => c.business_id === a[0] && c.started_at > since).length;
      return { rows: [{ n }], changes: 0 };
    }
    if (q.startsWith('INSERT INTO calls')) {
      this.db.seedCall({ id: String(a[0]), business_id: String(a[1]), caller_id: String(a[3]) });
      return { rows: [], changes: 1 };
    }
    if (q.startsWith('SELECT id FROM calls WHERE id')) {
      const since = cutoff(a[1]);
      const c = this.db.calls.find((x) => x.id === a[0] && x.status === 'active' && x.started_at > since);
      return { rows: c ? [{ id: c.id }] : [], changes: 0 };
    }
    if (q.startsWith('UPDATE calls SET connected_at')) {
      const c = this.db.calls.find((x) => x.id === a[0]);
      if (c) c.connected_at ??= Date.now();
      return { rows: [], changes: c ? 1 : 0 };
    }
    if (q.startsWith("UPDATE calls SET status = 'abandoned'")) {
      const wantConnected = q.includes('connected_at IS NOT NULL');
      const before = cutoff(a[0]);
      let changes = 0;
      for (const c of this.db.calls) {
        if (c.status !== 'active' || c.started_at >= before) continue;
        if (wantConnected !== (c.connected_at !== null)) continue;
        c.status = 'abandoned';
        c.ended_at = Date.now();
        changes++;
      }
      return { rows: [], changes };
    }

    // ---- users / sessions ----
    if (q.startsWith('SELECT id, password_hash FROM users')) {
      const u = this.db.users.find((x) => x.email === a[0]);
      return { rows: u ? [u] : [], changes: 0 };
    }
    if (q.startsWith('INSERT INTO sessions')) {
      this.db.sessions.push({ token: a[0], user_id: a[1], expires_at: a[2] });
      return { rows: [], changes: 1 };
    }

    throw new Error(`fake-d1: no branch for ${q.slice(0, 80)}`);
  }
}

// A CALL_SESSION namespace that accepts the upgrade without a real Durable
// Object, so the /ws route can be exercised end to end. Node's Response rejects
// a 101 status, hence the marker header instead.
export const UPGRADED = 'x-fake-upgrade';
export const fakeCallSession = {
  idFromName: (name: string) => name,
  get: () => ({ fetch: async () => new Response(null, { headers: { [UPGRADED]: '1' } }) }),
};

export function fakeEnv(db: FakeD1): any {
  return {
    DB: db,
    CALL_SESSION: fakeCallSession,
    DEFAULT_LLM_BASE_URL: '',
    DEFAULT_LLM_MODEL: '',
    DEFAULT_STT_BASE_URL: '',
    DEFAULT_STT_MODEL: '',
    DEFAULT_TTS_PROVIDER: 'browser',
    AZURE_SPEECH_REGION: '',
    DEFAULT_TTS_VOICE: '',
    REALTIME_BASE_URL: '',
    REALTIME_MODEL: '',
  };
}

export const fakeCtx: any = { waitUntil: () => {}, passThroughOnException: () => {} };
