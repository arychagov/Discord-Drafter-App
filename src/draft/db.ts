import { PoolClient } from "pg";

export type DraftStatus = "collecting" | "finished" | "stopped";
export type Team = "A" | "B" | "BENCH";

export type DraftRow = {
  id: string; // discord message id
  guild_id: string;
  channel_id: string;
  owner_id: string;
  title: string;
  status: DraftStatus;
  seed: string | null;
  generation_count: number;
  roster_version: number;
  last_draft_roster_version: number;
  last_active_sig: string;
};

export type DraftSlotRow = {
  id: string; // bigint as string in JS
  user_id: string;
  team: Team | null;
};

export type DraftView = {
  draft: DraftRow;
  players: string[]; // collecting roster order
  teamA: string[];
  teamB: string[];
  bench: string[];
};

export async function createDraft(
  c: PoolClient,
  args: {
    id: string;
    guildId: string;
    channelId: string;
    ownerId: string;
    title: string;
  }
): Promise<void> {
  await c.query(
    `INSERT INTO drafts(id, guild_id, channel_id, owner_id, title, status)
     VALUES($1,$2,$3,$4,$5,'collecting')`,
    [args.id, args.guildId, args.channelId, args.ownerId, args.title]
  );
}

export async function lockDraft(c: PoolClient, draftId: string): Promise<DraftRow | null> {
  const res = await c.query<DraftRow>(
    `SELECT id, guild_id, channel_id, owner_id, title, status, seed, generation_count,
            roster_version, last_draft_roster_version, last_active_sig
     FROM drafts
     WHERE id = $1
     FOR UPDATE`,
    [draftId]
  );
  return res.rows[0] ?? null;
}

export async function getDraft(c: PoolClient, draftId: string): Promise<DraftRow | null> {
  const res = await c.query<DraftRow>(
    `SELECT id, guild_id, channel_id, owner_id, title, status, seed, generation_count,
            roster_version, last_draft_roster_version, last_active_sig
     FROM drafts
     WHERE id = $1`,
    [draftId]
  );
  return res.rows[0] ?? null;
}

export async function setLastActiveSig(
  c: PoolClient,
  draftId: string,
  sig: string
): Promise<void> {
  await c.query(
    `UPDATE drafts
     SET last_active_sig = $2, updated_at = NOW()
     WHERE id = $1`,
    [draftId, sig]
  );
}

export async function setGenerationCount(
  c: PoolClient,
  draftId: string,
  n: number
): Promise<void> {
  await c.query(
    `UPDATE drafts
     SET generation_count = $2, updated_at = NOW()
     WHERE id = $1`,
    [draftId, n]
  );
}

export async function bumpRosterVersion(c: PoolClient, draftId: string): Promise<void> {
  await c.query(
    `UPDATE drafts
     SET roster_version = roster_version + 1, updated_at = NOW()
     WHERE id = $1`,
    [draftId]
  );
}

export async function setLastDraftRosterVersion(
  c: PoolClient,
  draftId: string,
  rosterVersion: number
): Promise<void> {
  await c.query(
    `UPDATE drafts
     SET last_draft_roster_version = $2, updated_at = NOW()
     WHERE id = $1`,
    [draftId, rosterVersion]
  );
}

export async function addSlot(
  c: PoolClient,
  draftId: string,
  userId: string,
  team: Team | null
): Promise<void> {
  await c.query(`INSERT INTO draft_slots(draft_id, user_id, team) VALUES($1,$2,$3)`, [
    draftId,
    userId,
    team,
  ]);
  await bumpRosterVersion(c, draftId);
}

export async function userHasAnySlot(
  c: PoolClient,
  draftId: string,
  userId: string
): Promise<boolean> {
  const res = await c.query<{ n: string }>(
    `SELECT COUNT(*)::text as n FROM draft_slots WHERE draft_id = $1 AND user_id = $2`,
    [draftId, userId]
  );
  return (res.rows[0]?.n ?? "0") !== "0";
}

export async function removeOneSlotPreferTeam(
  c: PoolClient,
  draftId: string,
  userId: string
): Promise<{ removed: boolean; removedTeam: Team | null }> {
  // Prefer removing from A/B, else from BENCH, else from NULL
  const res = await c.query<{ id: string; team: Team | null }>(
    `WITH candidate AS (
       SELECT id
       FROM draft_slots
       WHERE draft_id = $1 AND user_id = $2
       ORDER BY
         CASE team WHEN 'A' THEN 0 WHEN 'B' THEN 0 WHEN 'BENCH' THEN 1 ELSE 2 END,
         joined_at DESC, id DESC
       LIMIT 1
     )
     DELETE FROM draft_slots
     WHERE id IN (SELECT id FROM candidate)
     RETURNING id::text as id, team`,
    [draftId, userId]
  );
  if ((res.rowCount ?? 0) > 0) {
    await bumpRosterVersion(c, draftId);
    return { removed: true, removedTeam: res.rows[0]?.team ?? null };
  }
  return { removed: false, removedTeam: null };
}

export async function getTeamCounts(
  c: PoolClient,
  draftId: string
): Promise<{ a: number; b: number }> {
  const res = await c.query<{ team: string | null; n: string }>(
    `SELECT team, COUNT(*)::text as n
     FROM draft_slots
     WHERE draft_id = $1
     GROUP BY team`,
    [draftId]
  );
  let a = 0;
  let b = 0;
  for (const r of res.rows) {
    if (r.team === "A") a = Number(r.n);
    else if (r.team === "B") b = Number(r.n);
  }
  return { a, b };
}

export async function setStatusAndSeed(
  c: PoolClient,
  draftId: string,
  status: DraftStatus,
  seed: string | null
): Promise<void> {
  await c.query(`UPDATE drafts SET status = $2, seed = $3, updated_at = NOW() WHERE id = $1`, [
    draftId,
    status,
    seed,
  ]);
}

export async function deleteDraft(c: PoolClient, draftId: string): Promise<number> {
  const res = await c.query(`DELETE FROM drafts WHERE id = $1`, [draftId]);
  return res.rowCount ?? 0;
}

export async function bumpGeneration(c: PoolClient, draftId: string): Promise<void> {
  await c.query(
    `UPDATE drafts
     SET generation_count = generation_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [draftId]
  );
}

export async function resetGeneration(c: PoolClient, draftId: string): Promise<void> {
  await c.query(
    `UPDATE drafts
     SET generation_count = 0, updated_at = NOW()
     WHERE id = $1`,
    [draftId]
  );
}

export async function clearTeams(c: PoolClient, draftId: string): Promise<void> {
  await c.query(`UPDATE draft_slots SET team = NULL WHERE draft_id = $1`, [draftId]);
}

export async function getSlotsOrdered(
  c: PoolClient,
  draftId: string
): Promise<DraftSlotRow[]> {
  const res = await c.query<DraftSlotRow>(
    `SELECT id::text as id, user_id, team
     FROM draft_slots
     WHERE draft_id = $1
     ORDER BY joined_at ASC, id ASC`,
    [draftId]
  );
  return res.rows;
}

export async function setTeamForIds(
  c: PoolClient,
  draftId: string,
  team: Team,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  await c.query(
    `UPDATE draft_slots
     SET team = $2
     WHERE draft_id = $1 AND id = ANY($3::bigint[])`,
    [draftId, team, ids]
  );
}

export async function setNullTeamForNotIn(
  c: PoolClient,
  draftId: string,
  ids: string[]
): Promise<void> {
  await c.query(
    `UPDATE draft_slots
     SET team = NULL
     WHERE draft_id = $1 AND NOT (id = ANY($2::bigint[]))`,
    [draftId, ids]
  );
}

export async function getDraftView(c: PoolClient, draftId: string): Promise<DraftView | null> {
  const d = await getDraft(c, draftId);
  if (!d) return null;

  const slots = await getSlotsOrdered(c, draftId);

  const players: string[] = [];
  const teamA: string[] = [];
  const teamB: string[] = [];
  const bench: string[] = [];

  for (const s of slots) {
    if (d.status === "collecting" || s.team == null) {
      players.push(s.user_id);
      continue;
    }
    if (s.team === "A") teamA.push(s.user_id);
    else if (s.team === "B") teamB.push(s.user_id);
    else bench.push(s.user_id);
  }

  // stopped without seed means "no draft happened": show roster
  if (d.status === "stopped" && d.seed == null) {
    return { draft: d, players: slots.map((s) => s.user_id), teamA: [], teamB: [], bench: [] };
  }

  return { draft: d, players, teamA, teamB, bench };
}

