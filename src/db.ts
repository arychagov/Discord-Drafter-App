import { Pool, PoolClient } from "pg";
import { ENV } from "./env";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  if (!ENV.DATABASE_URL) throw new Error("Missing env var: DATABASE_URL");
  pool = new Pool({ connectionString: ENV.DATABASE_URL });
  return pool;
}

export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    const res = await fn(c);
    await c.query("COMMIT");
    return res;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw e;
  } finally {
    c.release();
  }
}

export async function initSchema(): Promise<void> {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, -- equals Discord message id
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL, -- collecting | finished | stopped
      seed TEXT,
      generation_count INTEGER NOT NULL DEFAULT 0,
      roster_version INTEGER NOT NULL DEFAULT 0,
      last_draft_roster_version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS draft_slots (
      id BIGSERIAL PRIMARY KEY,
      draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      team TEXT -- NULL | 'A' | 'B' | 'BENCH'
    );

    CREATE INDEX IF NOT EXISTS draft_slots_draft_id_joined_at_idx
      ON draft_slots(draft_id, joined_at, id);
    CREATE INDEX IF NOT EXISTS draft_slots_draft_id_user_id_idx
      ON draft_slots(draft_id, user_id);
  `);

  // Schema migrations for existing installations
  await p.query(`ALTER TABLE drafts ADD COLUMN IF NOT EXISTS generation_count INTEGER NOT NULL DEFAULT 0;`);
  await p.query(`ALTER TABLE drafts ADD COLUMN IF NOT EXISTS roster_version INTEGER NOT NULL DEFAULT 0;`);
  await p.query(
    `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS last_draft_roster_version INTEGER NOT NULL DEFAULT 0;`
  );
}

