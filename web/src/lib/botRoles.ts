import type { Bot } from "./types";

export type BotRole = "Main Bot" | "Bot Creator";

export function botRole(bot: Bot): BotRole | null {
  return bot.primary ? "Main Bot" : bot.creator ? "Bot Creator" : null;
}

const pinRank = (bot: Bot) => bot.primary ? 3 : bot.creator ? 2 : bot.pinned ? 1 : 0;

export const isPinnedBot = (bot: Bot) => pinRank(bot) > 0;

export function comparePinnedBots(a: Bot, b: Bot) {
  return pinRank(b) - pinRank(a) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
}
