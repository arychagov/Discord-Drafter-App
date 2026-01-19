import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
} from "discord.js";
import { randomUUID } from "crypto";
import { ENV } from "./env";
import { newDraftId, shuffledTeams, upsertDraftStateBlock } from "./draft/state";
import { DraftStateV1 } from "./draft/types";
import { parseButtonCustomId, renderComponents, renderEmbed } from "./draft/render";
import { withDraftMessageLock } from "./draft/sync";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "draft") {
        await handleStart(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      try {
        const hint = hintFromDiscordError(e);
        const content = hint ?? "Something went wrong.";
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
      } catch {
        // ignore
      }
    }
  }
});

function hintFromDiscordError(e: any): string | null {
  const code = e?.rawError?.code ?? e?.code;
  if (code === 50001) {
    return (
      "Missing Access (50001). Бот не видит этот канал/тред. " +
      "Проверь permissions в канале: View Channel, Send Messages, Embed Links. " +
      "Если это Thread — также Send Messages in Threads и убедись, что бот имеет доступ к треду."
    );
  }
  if (code === 50013) {
    return (
      "Missing Permissions (50013). Проверь permissions в канале: " +
      "View Channel, Send Messages, Embed Links (и при необходимости Read Message History)."
    );
  }
  return null;
}

function removeOneOccurrence(arr: string[], id: string): string[] {
  const idx = arr.lastIndexOf(id);
  if (idx === -1) return arr;
  const next = [...arr];
  next.splice(idx, 1);
  return next;
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Используй команду на сервере.", ephemeral: true });
    return;
  }

  const titleRaw = interaction.options.getString("title");
  const title = (titleRaw?.trim() || "Draft").slice(0, 80);
  const id = newDraftId();

  const state: DraftStateV1 = {
    v: 1,
    id,
    rev: 0,
    guildId: interaction.guildId!,
    channelId: interaction.channelId!,
    messageId: "pending",
    ownerId: interaction.user.id,
    title,
    status: "collecting",
    players: [],
  };

  const content = upsertDraftStateBlock("", state);

  await interaction.reply({
    content,
    embeds: [renderEmbed(state)],
    components: renderComponents(state),
    fetchReply: true,
  });

  const msg = await interaction.fetchReply();
  const finalState: DraftStateV1 = { ...state, messageId: msg.id };
  await interaction.editReply({
    content: upsertDraftStateBlock(content, finalState),
    embeds: [renderEmbed(finalState)],
    components: renderComponents(finalState),
  });
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Команда доступна только на сервере.", ephemeral: true });
    return;
  }

  const parsed = parseButtonCustomId(interaction.customId);
  if (!parsed) return;

  await withDraftMessageLock(interaction, (locked) => {
    if (locked.id !== parsed.draftId) {
      return { nextState: locked, note: "Эта кнопка не относится к этому драфту." };
    }

    const userId = interaction.user.id;
    const legacySub = locked.result?.substitute ?? [];
    const pendingRaw = locked.pending ?? [];
    const bench = [...pendingRaw, ...legacySub.filter((id) => !pendingRaw.includes(id))];

    if (locked.status === "stopped") {
      return { nextState: locked, note: "Драфт завершён." };
    }

    if (parsed.action === "join") {
      if (locked.status === "collecting") {
        if (!ENV.ALLOW_DUPLICATE_JOIN && locked.players.includes(userId)) {
          return { nextState: locked, note: "Ты уже в списке." };
        }
        return { nextState: { ...locked, players: [...locked.players, userId] } };
      }

      // finished: if teams are imbalanced, add directly to the team that lacks players.
      // Otherwise, add to bench ("На замену").
      const res = locked.result;
      if (!res) return { nextState: locked, note: "Нет результата драфта." };

      const rosterNow = [...res.teamA, ...res.teamB, ...bench];
      if (!ENV.ALLOW_DUPLICATE_JOIN && rosterNow.includes(userId)) {
        return { nextState: locked, note: "Ты уже в списке." };
      }

      let nextTeamA = [...res.teamA];
      let nextTeamB = [...res.teamB];
      let nextBench = [...bench];

      if (nextTeamA.length < nextTeamB.length) nextTeamA.push(userId);
      else if (nextTeamB.length < nextTeamA.length) nextTeamB.push(userId);
      else nextBench.push(userId);

      return {
        nextState: {
          ...locked,
          // keep status finished and keep existing teams; just extend
          players: [...nextTeamA, ...nextTeamB],
          pending: nextBench,
          result: { ...res, teamA: nextTeamA, teamB: nextTeamB, substitute: undefined },
        },
      };
    }

    if (parsed.action === "leave") {
      if (locked.status === "collecting") {
        const idx = locked.players.lastIndexOf(userId);
        if (idx === -1) return { nextState: locked, note: "Тебя нет в списке." };
        const nextPlayers = [...locked.players];
        nextPlayers.splice(idx, 1); // remove one "slot"
        return { nextState: { ...locked, players: nextPlayers } };
      }

      // finished: do NOT restart drafting. Keep teams as-is (may become imbalanced).
      const res = locked.result;
      if (!res) return { nextState: locked, note: "Нет результата драфта." };

      const nextTeamA = removeOneOccurrence(res.teamA, userId);
      const nextTeamB = removeOneOccurrence(res.teamB, userId);
      const removedFromTeams =
        nextTeamA.length !== res.teamA.length || nextTeamB.length !== res.teamB.length;

      let nextBench = [...bench];
      if (!removedFromTeams) {
        const removedBench = removeOneOccurrence(nextBench, userId);
        if (removedBench.length === nextBench.length) {
          return { nextState: locked, note: "Тебя нет в списке." };
        }
        nextBench = removedBench;
      }

      return {
        nextState: {
          ...locked,
          players: [...nextTeamA, ...nextTeamB],
          pending: nextBench,
          result: { ...res, teamA: nextTeamA, teamB: nextTeamB, substitute: undefined },
        },
      };
    }

    // owner-only actions
    if (locked.ownerId !== userId) {
      return { nextState: locked, note: "Только создатель драфта может это делать." };
    }

    if (parsed.action === "finish") {
      // Draft! works both for initial drafting and re-drafting (instead of Shuffle).
      const roster = locked.status === "finished" ? [...locked.players, ...bench] : [...locked.players];
      if (roster.length < 2) return { nextState: locked, note: "Нужно минимум 2 игрока." };
      const seed = randomUUID().slice(0, 8);
      const { teamA, teamB, bench: nextBench } = shuffledTeams(roster, seed);
      return {
        nextState: {
          ...locked,
          status: "finished",
          players: roster.slice(0, nextBench?.length ? -nextBench.length : roster.length),
          pending: nextBench ?? [],
          result: { seed, teamA, teamB },
        },
      };
    }

    if (parsed.action === "stop") {
      return {
        nextState: {
          ...locked,
          status: "stopped",
        },
      };
    }

    return { nextState: locked };
  });
}

void client.login(ENV.DISCORD_TOKEN);

