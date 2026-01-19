import {
  ButtonInteraction,
  Message,
  TextBasedChannel,
} from "discord.js";
import { DraftStateV1 } from "./types";
import { extractDraftState, upsertDraftStateBlock } from "./state";
import { renderComponents, renderEmbed } from "./render";
import { sleep } from "../utils/sleep";

const LOCK_TTL_MS = 6_000;
const MAX_ATTEMPTS = 10;

export type MutateDraft = (lockedState: DraftStateV1) => {
  nextState: DraftStateV1;
  note?: string; // ephemeral note to user
};

export async function withDraftMessageLock(
  interaction: ButtonInteraction,
  mutate: MutateDraft
): Promise<void> {
  await interaction.deferUpdate();

  const channel = interaction.channel as TextBasedChannel | null;
  if (!channel) {
    await safeFollowUp(interaction, "Не удалось определить канал.");
    return;
  }

  // Prefer using the message object from the interaction to avoid requiring
  // Read Message History for channel.messages.fetch().
  let msg = interaction.message as Message;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let current = extractDraftState(msg.content);
    if (!current) {
      // Fallback if message payload was partial: try fetching.
      try {
        // eslint-disable-next-line no-param-reassign
        msg = await channel.messages.fetch(msg.id);
        current = extractDraftState(msg.content);
      } catch (e: any) {
        await safeFollowUp(
          interaction,
          missingAccessHint(e) ?? "Не удалось прочитать состояние драфта."
        );
        return;
      }
      if (!current) {
        await safeFollowUp(interaction, "Не удалось прочитать состояние драфта.");
        return;
      }
    }

    const now = Date.now();
    const lockedByOther =
      current.lock && current.lock.until > now && current.lock.by !== interaction.id;

    if (lockedByOther) {
      await sleep(backoffMs(attempt));
      continue;
    }

    // Try to acquire lock by editing the message
    const lockState: DraftStateV1 = {
      ...current,
      rev: current.rev + 1,
      lock: { by: interaction.id, until: now + LOCK_TTL_MS },
    };

    try {
      // eslint-disable-next-line no-param-reassign
      msg = await editDraftMessage(msg, lockState);
    } catch (e: any) {
      await safeFollowUp(interaction, missingAccessHint(e) ?? "Failed to lock draft message.");
      return;
    }

    // Verify lock ownership (another concurrent edit may have overwritten it)
    const verified = extractDraftState(msg.content);
    if (!verified?.lock || verified.lock.by !== interaction.id || verified.lock.until <= Date.now()) {
      await sleep(backoffMs(attempt));
      continue;
    }

    // We own the lock now
    const { nextState, note } = mutate(verified);
    const unlocked: DraftStateV1 = {
      ...nextState,
      lock: undefined,
      rev: nextState.rev + 1,
    };

    try {
      // eslint-disable-next-line no-param-reassign
      msg = await editDraftMessage(msg, unlocked);
    } catch (e: any) {
      await safeFollowUp(interaction, missingAccessHint(e) ?? "Failed to update draft message.");
      return;
    }

    if (note) await safeFollowUp(interaction, note);
    return;
  }

  await safeFollowUp(interaction, "Слишком много одновременных кликов. Попробуй ещё раз.");
}

async function editDraftMessage(msg: Message, state: DraftStateV1): Promise<Message> {
  const content = upsertDraftStateBlock(msg.content, state);
  return await msg.edit({
    content,
    embeds: [renderEmbed(state)],
    components: renderComponents(state),
  });
}

function backoffMs(attempt: number): number {
  const base = Math.min(900, 120 + attempt * 120);
  const jitter = Math.floor(Math.random() * 120);
  return base + jitter;
}

async function safeFollowUp(interaction: ButtonInteraction, content: string): Promise<void> {
  try {
    await interaction.followUp({ content, ephemeral: true });
  } catch {
    // ignore: interaction may already be gone
  }
}

function missingAccessHint(e: any): string | null {
  const code = e?.rawError?.code ?? e?.code;
  if (code === 50001) {
    return (
      "Missing Access (50001). Проверь права бота в этом канале: " +
      "View Channel, Send Messages, Embed Links. " +
      "Если всё ещё падает — добавь Read Message History."
    );
  }
  if (code === 50013) {
    return (
      "Missing Permissions (50013). Проверь права бота в этом канале: " +
      "View Channel, Send Messages, Embed Links (и опционально Read Message History)."
    );
  }
  return null;
}
