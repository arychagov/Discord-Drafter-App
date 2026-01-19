import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { ENV } from "../env";
import { DraftStateV1 } from "./types";

export const BUTTON_PREFIX = "draft:v1";

export type DraftAction = "join" | "leave" | "finish" | "stop";

export function buttonCustomId(draftId: string, action: DraftAction): string {
  return `${BUTTON_PREFIX}:${draftId}:${action}`;
}

export function parseButtonCustomId(
  customId: string
): { draftId: string; action: DraftAction } | null {
  const parts = customId.split(":");
  if (parts.length !== 4) return null;
  const [p0, p1, draftId, action] = parts;
  if (`${p0}:${p1}` !== BUTTON_PREFIX) return null;
  if (!draftId) return null;
  if (action !== "join" && action !== "leave" && action !== "finish" && action !== "stop") {
    return null;
  }
  return { draftId, action };
}

export function renderEmbed(state: DraftStateV1): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(state.title || "Draft")
    .setFooter({ text: `драфт ${state.id}` });

  if (state.status === "collecting") {
    embed.setDescription(renderPlayersBlock(state.players));
    embed.addFields([{ name: "Игроки", value: `${state.players.length}`, inline: true }]);
    embed.setColor(0x3498db);
    return embed;
  }

  if (state.status === "finished" || (state.status === "stopped" && state.result)) {
    const a = state.result?.teamA ?? [];
    const b = state.result?.teamB ?? [];
    const bench = deriveBench(state);
    const roster = [...state.players, ...bench];

    // Keep ordinal numbers consistent across Команда A / Команда B / На замену.
    const ord = ENV.ALLOW_DUPLICATE_JOIN ? buildOrdinalQueues(roster) : null;

    embed.setColor(state.status === "stopped" ? 0x95a5a6 : 0x2ecc71);
    embed.addFields([
      { name: `Команда A (${a.length})`, value: renderMentionsOrDash(a, ord) },
      { name: `Команда B (${b.length})`, value: renderMentionsOrDash(b, ord) },
    ]);

    if (bench.length > 0) {
      embed.addFields([
        { name: `На замену (${bench.length})`, value: renderMentionsOrDash(bench, ord) },
      ]);
    }

    if (state.result?.seed) {
      embed.setFooter({
        text: `драфт ${state.id} • seed ${state.result.seed}`,
      });
    }

    if (state.status === "stopped") {
      embed.setDescription("Драфт завершён.");
    }

    return embed;
  }

  // stopped before drafting (no result)
  const roster = [...state.players, ...(state.pending ?? [])];
  embed.setColor(0x95a5a6);
  embed.setDescription("Драфт завершён.");
  embed.addFields([{ name: `Игроки (${roster.length})`, value: renderPlayersBlock(roster) }]);
  return embed;
}

export function renderComponents(
  state: DraftStateV1
): ActionRowBuilder<ButtonBuilder>[] {
  const join = new ButtonBuilder()
    .setCustomId(buttonCustomId(state.id, "join"))
    .setStyle(ButtonStyle.Success)
    .setLabel("+");

  const leave = new ButtonBuilder()
    .setCustomId(buttonCustomId(state.id, "leave"))
    .setStyle(ButtonStyle.Secondary)
    .setLabel("-");

  const finish = new ButtonBuilder()
    .setCustomId(buttonCustomId(state.id, "finish"))
    .setStyle(ButtonStyle.Success)
    .setLabel("Draft!");

  const stop = new ButtonBuilder()
    .setCustomId(buttonCustomId(state.id, "stop"))
    .setStyle(ButtonStyle.Danger)
    .setLabel("Завершить");

  if (state.status === "stopped") {
    join.setDisabled(true);
    leave.setDisabled(true);
    finish.setDisabled(true);
    stop.setDisabled(true);
  }

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(join, leave, finish, stop)];
}

function renderPlayersBlock(players: string[]): string {
  if (players.length === 0) return "Пока пусто. Нажми **+**.";
  const ord = ENV.ALLOW_DUPLICATE_JOIN ? buildOrdinalQueues(players) : null;
  const mentions = formatMentions(players, ord);
  return truncateLines(mentions.join("\n"), 3500);
}

function renderMentionsOrDash(ids: string[], ord: OrdinalQueues | null = null): string {
  if (ids.length === 0) return "—";
  return truncateLines(formatMentions(ids, ord).join("\n"), 1024);
}

function truncateLines(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 10)}\n…`;
}

type OrdinalQueues = Map<string, number[]>;

function buildOrdinalQueues(ids: string[]): OrdinalQueues {
  // Keep ordinal numbers only for users with duplicates.
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);

  const q: OrdinalQueues = new Map();
  for (const [id, c] of counts.entries()) {
    if (c > 1) q.set(id, Array.from({ length: c }, (_, i) => i + 1));
  }
  return q;
}

function formatMentions(ids: string[], ord: OrdinalQueues | null): string[] {
  if (!ord || ord.size === 0) return ids.map((id) => `<@${id}>`);

  // Consume from the provided queues so numbering stays consistent across sections.
  return ids.map((id) => {
    const arr = ord.get(id);
    if (!arr || arr.length === 0) return `<@${id}>`;
    const n = arr.shift()!;
    return `<@${id}> #${n}`;
  });
}

function deriveBench(state: DraftStateV1): string[] {
  const pending = state.pending ?? [];
  const legacy = state.result?.substitute ?? [];
  if (legacy.length === 0) return pending;
  return [...pending, ...legacy.filter((id) => !pending.includes(id))];
}

