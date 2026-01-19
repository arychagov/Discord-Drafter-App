export type DraftStatus = "collecting" | "finished" | "stopped";

export type DraftLock = {
  by: string; // interaction id
  until: number; // ms since epoch
};

export type DraftResult = {
  seed: string;
  teamA: string[]; // user ids
  teamB: string[]; // user ids
  // Legacy field; we now use DraftStateV1.pending as the unified "bench".
  substitute?: string[];
};

export type DraftStateV1 = {
  v: 1;
  id: string;
  rev: number;

  guildId: string;
  channelId: string;
  messageId: string;

  ownerId: string;
  title: string;
  status: DraftStatus;
  players: string[];
  /**
   * Unified "bench" list:
   * - players who joined after Draft! (previously pending)
   * - if odd number of players when drafting, the last joined goes here ("На замену")
   */
  pending?: string[];

  lock?: DraftLock;
  result?: DraftResult;
};

