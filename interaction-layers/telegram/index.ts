import { TelegramBot } from "./src/bot";
import { optionalEnv, requiredEnv } from "./src/env";

function parseAllowedChatIds(raw: string): number[] {
    if (!raw) return [];
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            const n = Number(s);
            if (!Number.isFinite(n)) {
                throw new Error(
                    `Invalid TELEGRAM_ALLOWED_CHAT_IDS entry "${s}" — must be a numeric Telegram chat id`,
                );
            }
            return n;
        });
}

async function main(): Promise<void> {
    const token = requiredEnv("TELEGRAM_BOT_TOKEN");
    const allowed = parseAllowedChatIds(optionalEnv("TELEGRAM_ALLOWED_CHAT_IDS"));
    if (allowed.length === 0) {
        // Bootstrap mode: no chat ids configured yet. The bot still runs so
        // you can message it from your account and see the chat id printed
        // (in logs and replied to the sender). Restart with the id added.
        console.warn(
            "[telegram] TELEGRAM_ALLOWED_CHAT_IDS is empty — running in bootstrap mode. " +
            "Message the bot to discover your chat id, then add it and restart.",
        );
    }

    const bot = new TelegramBot({ token, allowedChatIds: allowed });

    const shutdown = (signal: string) => {
        console.log(`[telegram] received ${signal}, shutting down`);
        bot.stop();
        // Give in-flight HTTP calls a beat to settle.
        setTimeout(() => process.exit(0), 250);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    await bot.start();
}

main().catch((err) => {
    console.error("[telegram] fatal:", err);
    process.exit(1);
});
