import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { ENV } from "./env";

const commands = [
  new SlashCommandBuilder()
    .setName("draft")
    .setDescription("Создать сообщение драфта с кнопками + / - / Draft! / Завершить")
    .addStringOption((opt) =>
      opt.setName("title").setDescription("Название драфта").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Показать справку по /draft"),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Удалить участника из существующего драфта (только создатель драфта)")
    .addStringOption((opt) =>
      opt
        .setName("draft_id")
        .setDescription("ID сообщения драфта или ссылка на сообщение")
        .setRequired(true)
    )
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Кого удалить из драфта").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("rename")
    .setDescription("Переименовать драфт (только создатель драфта)")
    .addStringOption((opt) =>
      opt
        .setName("draft_id")
        .setDescription("ID сообщения драфта или ссылка на сообщение")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("title").setDescription("Новое название драфта").setRequired(true)
    ),
].map((c) => c.toJSON());

async function main() {
  const rest = new REST({ version: "10" }).setToken(ENV.DISCORD_TOKEN);

  if (ENV.DISCORD_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(ENV.DISCORD_CLIENT_ID, ENV.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log(`Registered guild commands in ${ENV.DISCORD_GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(ENV.DISCORD_CLIENT_ID), { body: commands });
    console.log("Registered global commands (may take time to propagate)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

