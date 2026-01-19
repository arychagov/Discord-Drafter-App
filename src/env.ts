import * as dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const ENV = {
  DISCORD_TOKEN: required("DISCORD_TOKEN"),
  DISCORD_CLIENT_ID: required("DISCORD_CLIENT_ID"),
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
  ALLOW_DUPLICATE_JOIN: process.env.ALLOW_DUPLICATE_JOIN === "true",
  DATABASE_URL: process.env.DATABASE_URL,
};

