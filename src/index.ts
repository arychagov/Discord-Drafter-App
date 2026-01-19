import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
} from "discord.js";
import { randomUUID } from "crypto";
import { ENV } from "./env";
import { initSchema, withTx } from "./db";
import {
  addSlot,
  clearTeams,
  createDraft,
  getDraftView,
  getSlotsOrdered,
  getTeamCounts,
  lockDraft,
  removeOneSlotPreferTeam,
  setNullTeamForNotIn,
  setStatusAndSeed,
  setTeamForIds,
  userHasAnySlot,
} from "./draft/db";
import { parseButtonCustomId, renderComponents, renderEmbed } from "./draft/render";
import { shuffledIndices } from "./draft/random";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

client.once("ready", async () => {
  await initSchema();
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

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Используй команду на сервере.", ephemeral: true });
    return;
  }

  const titleRaw = interaction.options.getString("title");
  const title = (titleRaw?.trim() || "Draft").slice(0, 80);

  // Step 1: post placeholder message to obtain message.id (we use it as draft id).
  await interaction.reply({
    content: "Создаю драфт…",
    fetchReply: true,
  });
  const msg = await interaction.fetchReply();
  const draftId = msg.id;

  // Step 2: create draft in DB.
  await withTx(async (c) => {
    await createDraft(c, {
      id: draftId,
      guildId: interaction.guildId!,
      channelId: interaction.channelId!,
      ownerId: interaction.user.id,
      title,
    });
  });

  // Step 3: render from DB.
  const view = await withTx(async (c) => {
    const v = await getDraftView(c, draftId);
    if (!v) throw new Error("Draft not found right after creation.");
    return v;
  });

  await interaction.editReply({
    content: "",
    embeds: [renderEmbed(view)],
    components: renderComponents(view),
  });
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Команда доступна только на сервере.", ephemeral: true });
    return;
  }

  const parsed = parseButtonCustomId(interaction.customId);
  if (!parsed) return;

  await interaction.deferUpdate();

  const draftId = parsed.draftId;
  const userId = interaction.user.id;

  const error = await withTx(async (c) => {
    const draft = await lockDraft(c, draftId);
    if (!draft) return "Драфт не найден.";
    if (draft.guild_id !== interaction.guildId) return "Драфт не найден.";

    if (draft.status === "stopped") return "Драфт завершён.";

    if (parsed.action === "join") {
      if (!ENV.ALLOW_DUPLICATE_JOIN) {
        const already = await userHasAnySlot(c, draftId, userId);
        if (already) return "Ты уже в списке.";
      }

      if (draft.status === "collecting") {
        await addSlot(c, draftId, userId, null);
        return null;
      }

      // finished: add directly to smaller team; if equal -> BENCH
      const { a, b } = await getTeamCounts(c, draftId);
      const team = a < b ? "A" : b < a ? "B" : "BENCH";
      await addSlot(c, draftId, userId, team);
      return null;
    }

    if (parsed.action === "leave") {
      const removed = await removeOneSlotPreferTeam(c, draftId, userId);
      if (!removed) return "Тебя нет в списке.";
      return null;
    }

    // owner-only actions
    if (draft.owner_id !== userId) return "Только создатель драфта может это делать.";

    if (parsed.action === "stop") {
      await setStatusAndSeed(c, draftId, "stopped", draft.seed);
      return null;
    }

    if (parsed.action === "finish") {
      // Draft! re-drafts every time.
      const slots = await getSlotsOrdered(c, draftId);
      if (slots.length < 2) return "Нужно минимум 2 игрока.";

      const seed = randomUUID().slice(0, 8);
      await clearTeams(c, draftId);
      await setStatusAndSeed(c, draftId, "finished", seed);

      // Determine bench (odd => last joined goes to BENCH).
      const benchIds: string[] = [];
      let mainSlots = slots;
      if (slots.length % 2 === 1) {
        const last = slots[slots.length - 1];
        benchIds.push(last.id);
        mainSlots = slots.slice(0, -1);
      }

      const order = shuffledIndices(mainSlots.length, seed);
      const shuffled = order.map((i) => mainSlots[i]);
      const mid = Math.floor(shuffled.length / 2);
      const aIds = shuffled.slice(0, mid).map((s) => s.id);
      const bIds = shuffled.slice(mid).map((s) => s.id);

      await setTeamForIds(c, draftId, "A", aIds);
      await setTeamForIds(c, draftId, "B", bIds);
      await setTeamForIds(c, draftId, "BENCH", benchIds);

      // ensure any non-mentioned slots (shouldn't happen) are NULL
      await setNullTeamForNotIn(c, draftId, [...aIds, ...bIds, ...benchIds]);
      return null;
    }

    return "Неизвестное действие.";
  });

  if (error) {
    await interaction.followUp({ content: error, ephemeral: true });
    return;
  }

  const view = await withTx(async (c) => await getDraftView(c, draftId));
  if (!view) {
    await interaction.followUp({ content: "Драфт не найден.", ephemeral: true });
    return;
  }

  await interaction.message.edit({
    embeds: [renderEmbed(view)],
    components: renderComponents(view),
    content: "",
  });
}

void client.login(ENV.DISCORD_TOKEN);

