import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
} from "discord.js";
import { randomUUID } from "crypto";
import { ENV } from "./env";
import { cleanupOldDrafts, initSchema, withTx } from "./db";
import {
  addSlot,
  clearTeams,
  createDraft,
  bumpGeneration,
  deleteDraft,
  getDraftView,
  getSlotsOrdered,
  getTeamCounts,
  lockDraft,
  removeAllSlotsForUser,
  removeOneSlotPreferTeam,
  setDraftTitle,
  setNullTeamForNotIn,
  setStatusAndSeed,
  setTeamForIds,
  setGenerationCount,
  setLastActiveSig,
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
  // Periodic cleanup: delete drafts older than N days (default 7).
  const runCleanup = async () => {
    try {
      const n = await cleanupOldDrafts(ENV.DRAFT_RETENTION_DAYS);
      if (n > 0) console.log(`Cleanup: deleted ${n} old drafts.`);
    } catch (e) {
      console.error("Cleanup failed:", e);
    }
  };
  await runCleanup();
  setInterval(runCleanup, 24 * 60 * 60 * 1000).unref?.();
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "draft") {
        await handleStart(interaction);
        return;
      }
      if (interaction.commandName === "help") {
        await handleHelp(interaction);
        return;
      }
      if (interaction.commandName === "remove") {
        await handleRemove(interaction);
        return;
      }
      if (interaction.commandName === "rename") {
        await handleRename(interaction);
        return;
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
    // By default, add the author as the first participant.
    await addSlot(c, draftId, interaction.user.id, null);
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

async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  const content =
    "**/draft — справка**\n\n" +
    "**1) Создать драфт**\n" +
    "В нужном канале напишите команду `/draft` (можно указать название).\n" +
    "Бот отправит сообщение драфта с кнопками `+`, `-`, `Draft!`, `Завершить`.\n\n" +
    "**2) Вступить / выйти**\n" +
    "Нажмите `+` — вы добавитесь в список игроков.\n" +
    "Нажмите `-` — вы удалитесь из списка игроков.\n\n" +
    "**3) Сделать драфт команд**\n" +
    "Создатель драфта нажимает `Draft!`.\n" +
    "Бот покажет две команды: **Команда A** и **Команда B**.\n" +
    "Если игроков нечётное число — последний, кто нажал `+`, попадёт в **«На замену»**.\n\n" +
    "**4) После драфта (когда команды уже есть)**\n" +
    "Если игрок из команды нажимает `-`, он выходит из своей команды, а команды остаются (могут стать неравными).\n" +
    "Если кто-то нажимает `+`:\n" +
    "- он сразу попадёт в команду, где меньше игроков\n" +
    "- если команды равны — попадёт в **«На замену»**\n" +
    "Создатель драфта может нажать `Draft!` ещё раз — команды будут переразданы заново (и **«На замену»** тоже будет учтён).\n\n" +
    "**5) Завершить драфт**\n" +
    "Создатель драфта нажимает `Завершить`.\n" +
    "Все кнопки отключаются, а результат остаётся видимым в сообщении.\n\n" +
    "**6) Удалить участника (только создатель)**\n" +
    "Команда: `/remove draft_id user [user2..user5]`\n" +
    "- `draft_id` — ID сообщения драфта или ссылка на сообщение драфта\n" +
    "- `user` — кого удалить\n" +
    "- `user2..user5` — дополнительные игроки (опционально)\n\n" +
    "**7) Переименовать драфт (только создатель)**\n" +
    "Команда: `/rename draft_id title`\n" +
    "- `draft_id` — ID сообщения драфта или ссылка на сообщение драфта\n" +
    "- `title` — новое название\n\n" +
    "**Примечания**\n" +
    "`Draft!` и `Завершить` доступны только создателю драфта.\n" +
    "`/remove` тоже доступна только создателю драфта.\n" +
    "`/rename` тоже доступна только создателю драфта.\n" +
    "Если бот не отвечает, происходит какая-то рандомная хуйня - пиши @Wealduun.";

  await interaction.reply({ content, ephemeral: true });
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Используй команду на сервере.", ephemeral: true });
    return;
  }

  const draftIdRaw = interaction.options.getString("draft_id", true);
  const u1 = interaction.options.getUser("user", true);
  const u2 = interaction.options.getUser("user2");
  const u3 = interaction.options.getUser("user3");
  const u4 = interaction.options.getUser("user4");
  const u5 = interaction.options.getUser("user5");

  const targets = [u1, u2, u3, u4, u5].filter(Boolean) as { id: string }[];
  const uniqTargets = Array.from(new Map(targets.map((u) => [u.id, u])).values());

  const draftId = parseDraftId(draftIdRaw);
  if (!draftId) {
    await interaction.reply({
      content: "Не понял `draft_id`. Пришли ID сообщения драфта или ссылку на сообщение.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const txRes = await withTx(async (c) => {
    const draft = await lockDraft(c, draftId);
    if (!draft) return { error: "Драфт не найден." as const };
    if (draft.guild_id !== interaction.guildId) return { error: "Драфт не найден." as const };
    if (draft.owner_id !== interaction.user.id) {
      return { error: "Только создатель драфта может удалять участников." as const };
    }
    if (draft.status === "stopped") return { error: "Драфт завершён." as const };

    const removedIds: string[] = [];
    const notFoundIds: string[] = [];
    for (const t of uniqTargets) {
      const { removed } = await removeAllSlotsForUser(c, draftId, t.id);
      if (removed > 0) removedIds.push(t.id);
      else notFoundIds.push(t.id);
    }
    if (removedIds.length === 0) {
      return { error: "Указанных пользователей нет в драфте." as const };
    }

    const view = await getDraftView(c, draftId);
    if (!view) return { error: "Драфт не найден." as const };
    // Need channel id for message edit
    return { view, channelId: draft.channel_id, removedIds, notFoundIds } as const;
  });

  if ("error" in txRes) {
    await interaction.editReply({ content: txRes.error });
    return;
  }

  try {
    const ch = await interaction.client.channels.fetch(txRes.channelId);
    if (!ch || typeof (ch as any).isTextBased !== "function" || !(ch as any).isTextBased()) {
      await interaction.editReply({
        content: "Не смог найти канал драфта, чтобы обновить сообщение.",
      });
      return;
    }
    const msg = await (ch as any).messages.fetch(draftId);
    await msg.edit({
      embeds: [renderEmbed(txRes.view)],
      components: renderComponents(txRes.view),
      content: "",
    });
  } catch (e) {
    console.error(e);
    await interaction.editReply({
      content:
        "Удалил пользователя из драфта в базе, но не смог обновить сообщение (проверь права бота/доступ к каналу).",
    });
    return;
  }

  const removedMentions = txRes.removedIds.map((id) => `<@${id}>`).join(", ");
  const notFoundMentions = txRes.notFoundIds.map((id) => `<@${id}>`).join(", ");
  const suffix = notFoundMentions ? `\nНе были в драфте: ${notFoundMentions}` : "";

  await interaction.editReply({ content: `Удалил из драфта \`${draftId}\`: ${removedMentions}.${suffix}` });
}

async function handleRename(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Используй команду на сервере.", ephemeral: true });
    return;
  }

  const draftIdRaw = interaction.options.getString("draft_id", true);
  const titleRaw = interaction.options.getString("title", true);
  const draftId = parseDraftId(draftIdRaw);
  if (!draftId) {
    await interaction.reply({
      content: "Не понял `draft_id`. Пришли ID сообщения драфта или ссылку на сообщение.",
      ephemeral: true,
    });
    return;
  }

  const title = (titleRaw.trim() || "Draft").slice(0, 80);
  if (!title) {
    await interaction.reply({ content: "Название не должно быть пустым.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const txRes = await withTx(async (c) => {
    const draft = await lockDraft(c, draftId);
    if (!draft) return { error: "Драфт не найден." as const };
    if (draft.guild_id !== interaction.guildId) return { error: "Драфт не найден." as const };
    if (draft.owner_id !== interaction.user.id) {
      return { error: "Только создатель драфта может переименовывать драфт." as const };
    }
    if (draft.status === "stopped") return { error: "Драфт завершён." as const };

    await setDraftTitle(c, draftId, title);
    const view = await getDraftView(c, draftId);
    if (!view) return { error: "Драфт не найден." as const };

    return { view, channelId: draft.channel_id } as const;
  });

  if ("error" in txRes) {
    await interaction.editReply({ content: txRes.error });
    return;
  }

  try {
    const ch = await interaction.client.channels.fetch(txRes.channelId);
    if (!ch || typeof (ch as any).isTextBased !== "function" || !(ch as any).isTextBased()) {
      await interaction.editReply({
        content: "Не смог найти канал драфта, чтобы обновить сообщение.",
      });
      return;
    }
    const msg = await (ch as any).messages.fetch(draftId);
    await msg.edit({
      embeds: [renderEmbed(txRes.view)],
      components: renderComponents(txRes.view),
      content: "",
    });
  } catch (e) {
    console.error(e);
    await interaction.editReply({
      content:
        "Переименовал драфт в базе, но не смог обновить сообщение (проверь права бота/доступ к каналу).",
    });
    return;
  }

  await interaction.editReply({
    content: `Переименовал драфт \`${draftId}\` → **${title}**.`,
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
      const { removed, removedTeam } = await removeOneSlotPreferTeam(c, draftId, userId);
      if (!removed) return "Тебя нет в списке.";
      return null;
    }

    // owner-only actions
    if (draft.owner_id !== userId) return "Только создатель драфта может это делать.";

    if (parsed.action === "stop") {
      // We'll delete the draft from DB, but first we need a "final view" for the message.
      const viewBefore = await getDraftView(c, draftId);
      if (!viewBefore) return "Драфт не найден.";

      const finalView = {
        ...viewBefore,
        draft: { ...viewBefore.draft, status: "stopped" as const },
      };

      await deleteDraft(c, draftId);
      // Return the view so caller can update message even after DB deletion.
      return finalView as any;
    }

    if (parsed.action === "finish") {
      // Draft! re-drafts every time.
      const slots = await getSlotsOrdered(c, draftId);
      if (slots.length < 2) return "Нужно минимум 2 игрока.";

      // Determine the new "active roster" (Team A ∪ Team B) signature AFTER this draft.
      // If it differs from the previous active roster signature, reset generation counter.

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

      const newActiveSig = activeSigFromUserIds(mainSlots.map((s) => s.user_id));
      const shouldReset = draft.last_active_sig !== "" && draft.last_active_sig !== newActiveSig;
      if (shouldReset) {
        await setGenerationCount(c, draftId, 0);
      }
      await bumpGeneration(c, draftId);
      await setLastActiveSig(c, draftId, newActiveSig);

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

  // The transaction returns either:
  // - null: success, fetch view from DB
  // - DraftView: special-case for stop (draft already deleted)
  // - string: error message
  if (typeof error === "string" && error) {
    await interaction.followUp({ content: error, ephemeral: true });
    return;
  }

  let view = null as any;
  if (error && typeof error === "object") {
    view = error;
  } else {
    view = await withTx(async (c) => await getDraftView(c, draftId));
    if (!view) {
      await interaction.followUp({ content: "Драфт не найден.", ephemeral: true });
      return;
    }
  }

  await interaction.message.edit({
    embeds: [renderEmbed(view)],
    components: renderComponents(view),
    content: "",
  });
}

void client.login(ENV.DISCORD_TOKEN);

function activeSigFromUserIds(ids: string[]): string {
  // Multiset signature of the active roster (keeps duplicates): sort and join.
  return ids.slice().sort().join(",");
}

function parseDraftId(input: string): string | null {
  const s = input.trim();
  if (/^\d{16,30}$/.test(s)) return s;
  // message link format: https://discord.com/channels/<guild>/<channel>/<message>
  const m = s.match(/\/channels\/\d+\/\d+\/(\d{16,30})/);
  if (m?.[1]) return m[1];
  // fallback: last long number in the string
  const m2 = s.match(/(\d{16,30})(?!.*\d{16,30})/);
  return m2?.[1] ?? null;
}
