import { DraftStateV1 } from "./types";

const STATE_BLOCK_LANG = "DRAFT_STATE";
// State block may be wrapped in spoiler markers (||...||) to hide it in UI.
const STATE_RE = /(\|\|)?```DRAFT_STATE\s*\n([\s\S]*?)\n```(\|\|)?/m;
const STATE_RE_GLOBAL = /(\|\|)?```DRAFT_STATE\s*\n([\s\S]*?)\n```(\|\|)?/gm;

export function extractDraftState(content: string): DraftStateV1 | null {
  // If multiple blocks exist (e.g. due to legacy formatting), take the last valid one.
  let last: DraftStateV1 | null = null;
  for (const m of content.matchAll(STATE_RE_GLOBAL)) {
    try {
      const parsed = JSON.parse(m[2]) as DraftStateV1;
      if (parsed && parsed.v === 1) last = parsed;
    } catch {
      // ignore
    }
  }
  return last;
}

export function upsertDraftStateBlock(content: string, state: DraftStateV1): string {
  const nextBlock = formatStateBlock(state);
  // Ensure we keep exactly ONE block in the message to avoid split-brain behavior.
  const withoutAll = content.replace(STATE_RE_GLOBAL, "").trim();
  return withoutAll.length ? `${withoutAll}\n\n${nextBlock}` : nextBlock;
}

export function formatStateBlock(state: DraftStateV1): string {
  const json = JSON.stringify(state);
  // Wrap in spoiler so the technical JSON doesn't clutter the message.
  return `||\`\`\`${STATE_BLOCK_LANG}\n${json}\n\`\`\`||`;
}

export function newDraftId(): string {
  // small and human-ish: 6 chars base36
  const n = Math.floor(Math.random() * 36 ** 6);
  return n.toString(36).padStart(6, "0");
}

export function shuffledTeams(
  players: string[],
  seed: string
): { teamA: string[]; teamB: string[]; bench?: string[] } {
  const rng = mulberry32(hashStringToU32(seed));
  // If odd number of players: the last one who joined goes to bench ("На замену").
  const bench =
    players.length % 2 === 1 && players.length > 0 ? [players[players.length - 1]] : undefined;
  const arr = bench ? players.slice(0, -1) : [...players];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const mid = Math.floor(arr.length / 2);
  return { teamA: arr.slice(0, mid), teamB: arr.slice(mid), bench };
}

function hashStringToU32(s: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

