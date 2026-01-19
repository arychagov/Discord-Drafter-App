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
    .setName("draft_help")
    .setDescription("Показать справку по /draft"),
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

