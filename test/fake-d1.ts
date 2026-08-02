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
  '-90 minutes': -90 * 60_000,
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
  turns: { call_id: string; ts: number }[] = [];
  counters = new Map<string, number>(); // `${bucket}|${window_start}` -> count
  // The public row's second column, kept beside `counters` rather than folded
  // into it so tests can still read a plain number out of either.
  starts = new Map<string, number>();

  // Called before every statement. Tests use it to move the clock mid-request,
  // which is the only way to put a rate-limit window boundary in the middle of
  // one handler the way a slow PBKDF2 login does in production.
  hook: ((sql: string) => void) | null = null;

  // Rows actually written, the way D1 bills. Row *count* can look healthy while
  // the writes underneath run away, so tests assert on this.
  rowsWritten = 0;

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql.replace(/\s+/g, ' ').trim());
  }

  async batch(stmts: FakeStatement[]): Promise<{ results: Row[]; meta: { changes: number } }[]> {
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

  // A saved transcript turn — proof the call reached a Durable Object.
  seedTurn(callId: string, ts: number): void {
    this.turns.push({ call_id: callId, ts });
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

  async run(): Promise<{ results: Row[]; meta: { changes: number } }> {
    const r = this.exec();
    return { results: r.rows, meta: { changes: r.changes } };
  }

  private exec(): { rows: Row[]; changes: number } {
    const r = this.execRaw();
    if (/^(INSERT|UPDATE|DELETE)/.test(this.sql)) this.db.rowsWritten += r.changes;
    return r;
  }

  private execRaw(): { rows: Row[]; changes: number } {
    const q = this.sql;
    const a = this.args;
    this.db.hook?.(q);

    // ---- rate_counters ----
    // The public limiter: one row, two counters, one write.
    if (q.startsWith('INSERT INTO rate_counters') && q.includes('starts')) {
      const key = `${a[0]}|${a[1]}`;
      const inc = Number(a[2]);
      const max = Number(a[3]);
      const cur = this.db.counters.get(key);
      if (cur !== undefined && cur >= max) return { rows: [], changes: 0 };
      const count = (cur ?? 0) + 1;
      const starts = (this.db.starts.get(key) ?? 0) + inc;
      this.db.counters.set(key, count);
      this.db.starts.set(key, starts);
      return { rows: [{ count, starts }], changes: 1 };
    }
    if (q.startsWith('INSERT INTO rate_counters')) {
      const key = `${a[0]}|${a[1]}`;
      const max = Number(a[2]);
      const cur = this.db.counters.get(key);
      if (cur === undefined) {
        this.db.counters.set(key, 1);
        return { rows: [{ count: 1 }], changes: 1 };
      }
      // The conflict branch carries a WHERE. When it fails, SQLite writes
      // nothing and RETURNING yields no row — that is the refusal, and it must
      // cost zero writes.
      if (cur < max) {
        this.db.counters.set(key, cur + 1);
        return { rows: [{ count: cur + 1 }], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }
    if (q.startsWith('SELECT count FROM rate_counters')) {
      const n = this.db.counters.get(`${a[0]}|${a[1]}`);
      return { rows: n === undefined ? [] : [{ count: n }], changes: 0 };
    }
    if (q.startsWith('UPDATE rate_counters SET count = count - 1')) {
      const key = `${a[0]}|${a[1]}`;
      const n = this.db.counters.get(key) ?? 0;
      if (n > 0) this.db.counters.set(key, n - 1);
      return { rows: [], changes: n > 0 ? 1 : 0 };
    }
    if (q.startsWith('DELETE FROM rate_counters WHERE bucket')) {
      let changes = 0;
      for (const k of [...this.db.counters.keys()]) {
        if (k.startsWith(`${a[0]}|`)) (this.db.counters.delete(k), this.db.starts.delete(k), changes++);
      }
      return { rows: [], changes };
    }
    if (q.startsWith('DELETE FROM rate_counters WHERE window_start')) {
      let changes = 0;
      for (const k of [...this.db.counters.keys()]) {
        if (Number(k.split('|')[1]) < Number(a[0])) (this.db.counters.delete(k), this.db.starts.delete(k), changes++);
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
      // No age cutoff: the sweep is the only thing that releases a live slot.
      const n = this.db.calls.filter(
        (c) => c.business_id === a[0] && c.id !== a[1] && c.status === 'active' && c.connected_at !== null
      ).length;
      return { rows: [{ n }], changes: 0 };
    }
    // Conditional insert: the row appears only if the day's count is under the
    // cap, so a refusal writes nothing. changes === 0 is the refusal.
    if (q.startsWith('INSERT INTO calls') && q.includes('WHERE (SELECT COUNT(*)')) {
      const since = cutoff('-1 day');
      const n = this.db.calls.filter(
        (c) =>
          c.business_id === a[3] &&
          c.started_at > since &&
          !(c.status === 'abandoned' && c.connected_at === null)
      ).length;
      if (n >= Number(a[4])) return { rows: [], changes: 0 };
      this.db.seedCall({ id: String(a[0]), business_id: String(a[1]), caller_id: String(a[2]) });
      return { rows: [], changes: 1 };
    }
    if (q.startsWith('SELECT calls.id, calls.business_id, businesses.max_concurrent_calls')) {
      const since = cutoff(a[1]);
      const c = this.db.calls.find((x) => x.id === a[0] && x.status === 'active' && x.started_at > since);
      const b = c && this.db.businesses.find((x) => x.id === c.business_id);
      return {
        rows: c && b ? [{ id: c.id, business_id: c.business_id, max_concurrent_calls: b.max_concurrent_calls }] : [],
        changes: 0,
      };
    }
    // Runtime reconciliation: repair rows an older worker connected without
    // writing the column, before the two classification statements read it.
    if (q.startsWith('UPDATE calls SET connected_at = COALESCE(')) {
      let changes = 0;
      for (const c of this.db.calls) {
        if (c.status !== 'active' || c.connected_at !== null) continue;
        const ts = this.db.turns.filter((t) => t.call_id === c.id).map((t) => t.ts);
        if (ts.length === 0) continue;
        c.connected_at = Math.min(...ts);
        changes++;
      }
      return { rows: [], changes };
    }
    if (q.startsWith('UPDATE calls SET connected_at = NULL')) {
      const c = this.db.calls.find((x) => x.id === a[0]);
      if (c) c.connected_at = null;
      return { rows: [], changes: c ? 1 : 0 };
    }
    // Conditional: changes === 1 only for the request that takes the slot.
    if (q.startsWith('UPDATE calls SET connected_at')) {
      const c = this.db.calls.find((x) => x.id === a[0] && x.connected_at === null);
      if (c) c.connected_at = Date.now();
      return { rows: [], changes: c ? 1 : 0 };
    }
    if (q.startsWith("UPDATE calls SET status = 'abandoned'") && q.endsWith('WHERE id = ?')) {
      const c = this.db.calls.find((x) => x.id === a[0]);
      if (c) {
        c.status = 'abandoned';
        c.ended_at = Date.now();
        if (q.includes('connected_at = NULL')) c.connected_at = null;
      }
      return { rows: [], changes: c ? 1 : 0 };
    }
    if (q.startsWith("UPDATE calls SET status = 'abandoned'")) {
      const wantConnected = q.includes('connected_at IS NOT NULL');
      // Each branch ages from its own column; mirroring that here is the whole
      // point, so read it off the SQL rather than assuming started_at.
      const column = q.includes('AND connected_at < datetime') ? 'connected_at' : 'started_at';
      const before = cutoff(a[0]);
      let changes = 0;
      for (const c of this.db.calls) {
        if (c.status !== 'active') continue;
        if (wantConnected !== (c.connected_at !== null)) continue;
        const age = column === 'connected_at' ? c.connected_at : c.started_at;
        if (age === null || age >= before) continue;
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
    if (q.startsWith('DELETE FROM sessions WHERE expires_at')) {
      // Compared as TEXT, the way SQLite actually does it, and against a cutoff
      // in whichever format the statement supplies. Parsing both sides into
      // dates here would make the fake kinder than the database and hide the one
      // failure this branch exists to catch: datetime('now') yields
      // "2026-08-02 11:00:00" while createSession stores
      // "2026-08-02T10:00:00.000Z", and 'T' sorts after ' ', so a session that
      // expired earlier today compares as greater and survives.
      const cut = q.includes("datetime('now')")
        ? new Date(Date.now()).toISOString().replace('T', ' ').slice(0, 19)
        : String(a[0]);
      const before = this.db.sessions.length;
      this.db.sessions = this.db.sessions.filter((s) => !(String(s.expires_at) < cut));
      return { rows: [], changes: before - this.db.sessions.length };
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
