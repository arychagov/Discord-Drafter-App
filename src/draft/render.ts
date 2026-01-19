import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { ENV } from "../env";
import { DraftView } from "./db";

export const BUTTON_PREFIX = "draft:v2";

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

export function renderEmbed(view: DraftView): EmbedBuilder {
  const { draft } = view;
  const embed = new EmbedBuilder()
    .setTitle(draft.title || "Собираем игру")
    .setFooter({
      text:
        draft.seed == null
          ? "Собираем игроков"
          : `# рандома: ${draft.generation_count}`,
    });

  if (draft.status === "collecting") {
    embed.setDescription(renderPlayersBlock(view.players));
    embed.addFields([{ name: "Игроки", value: `${view.players.length}`, inline: true }]);
    embed.setColor(0x3498db);
    return embed;
  }

  // finished or stopped: show teams if present
  if (view.teamA.length || view.teamB.length || view.bench.length) {
    const roster = [...view.teamA, ...view.teamB, ...view.bench];
    const ord = ENV.ALLOW_DUPLICATE_JOIN ? buildOrdinalQueues(roster) : null;

    embed.setColor(draft.status === "stopped" ? 0x95a5a6 : 0x2ecc71);
    embed.addFields([
      { name: `Команда A (${view.teamA.length})`, value: renderMentionsOrDash(view.teamA, ord) },
      { name: `Команда B (${view.teamB.length})`, value: renderMentionsOrDash(view.teamB, ord) },
    ]);
    if (view.bench.length) {
      embed.addFields([
        { name: `На замену (${view.bench.length})`, value: renderMentionsOrDash(view.bench, ord) },
      ]);
    }
    if (draft.status === "stopped") embed.setDescription("Драфт завершён.");
    return embed;
  }

  // stopped without teams
  embed.setColor(0x95a5a6);
  embed.setDescription("Драфт завершён.");
  embed.addFields([{ name: `Игроки (${view.players.length})`, value: renderPlayersBlock(view.players) }]);
  return embed;
}

export function renderComponents(view: DraftView): ActionRowBuilder<ButtonBuilder>[] {
  const join = new ButtonBuilder()
    .setCustomId(buttonCustomId(view.draft.id, "join"))
    .setStyle(ButtonStyle.Success)
    .setLabel("+");

  const leave = new ButtonBuilder()
    .setCustomId(buttonCustomId(view.draft.id, "leave"))
    .setStyle(ButtonStyle.Secondary)
    .setLabel("-");

  const finish = new ButtonBuilder()
    .setCustomId(buttonCustomId(view.draft.id, "finish"))
    .setStyle(ButtonStyle.Success)
    .setLabel("Draft!");

  const stop = new ButtonBuilder()
    .setCustomId(buttonCustomId(view.draft.id, "stop"))
    .setStyle(ButtonStyle.Danger)
    .setLabel("Завершить");

  if (view.draft.status === "stopped") {
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
  return ids.map((id) => {
    const arr = ord.get(id);
    if (!arr || arr.length === 0) return `<@${id}>`;
    const n = arr.shift()!;
    return `<@${id}> #${n}`;
  });
}

