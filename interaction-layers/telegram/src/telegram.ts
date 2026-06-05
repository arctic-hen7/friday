// Thin wrapper around the Telegram Bot HTTP API. Only the methods we use are
// modelled. Long-poll-only — no webhook plumbing.

const TG_BASE = "https://api.telegram.org";

export type TgUser = {
    id: number;
    is_bot: boolean;
    username?: string;
    first_name?: string;
    last_name?: string;
};

export type TgChat = {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    username?: string;
};

export type TgMessage = {
    message_id: number;
    from?: TgUser;
    chat: TgChat;
    date: number;
    text?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
};

export type TgUpdate = {
    update_id: number;
    message?: TgMessage;
    edited_message?: TgMessage;
};

export class TelegramError extends Error {
    constructor(
        message: string,
        readonly errorCode: number,
        readonly description: string,
        readonly retryAfter?: number,
    ) {
        super(message);
    }
}

export class TelegramClient {
    constructor(private readonly token: string) {}

    private url(method: string): string {
        return `${TG_BASE}/bot${this.token}/${method}`;
    }

    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const res = await fetch(this.url(method), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        const body = (await res.json()) as {
            ok: boolean;
            result?: T;
            description?: string;
            error_code?: number;
            parameters?: { retry_after?: number };
        };
        if (!body.ok) {
            throw new TelegramError(
                `telegram ${method} failed: ${body.description ?? "unknown"}`,
                body.error_code ?? 0,
                body.description ?? "",
                body.parameters?.retry_after,
            );
        }
        return body.result as T;
    }

    async getMe(): Promise<TgUser> {
        return await this.call<TgUser>("getMe");
    }

    async getUpdates(opts: {
        offset?: number;
        timeout: number;
        allowedUpdates?: string[];
    }): Promise<TgUpdate[]> {
        return await this.call<TgUpdate[]>("getUpdates", {
            offset: opts.offset,
            timeout: opts.timeout,
            allowed_updates: opts.allowedUpdates ?? ["message"],
        });
    }

    async sendMessage(opts: {
        chatId: number;
        text: string;
        replyToMessageId?: number;
        disableNotification?: boolean;
    }): Promise<TgMessage> {
        return await this.call<TgMessage>("sendMessage", {
            chat_id: opts.chatId,
            text: opts.text,
            reply_to_message_id: opts.replyToMessageId,
            disable_notification: opts.disableNotification,
        });
    }

    async editMessageText(opts: {
        chatId: number;
        messageId: number;
        text: string;
    }): Promise<unknown> {
        return await this.call<unknown>("editMessageText", {
            chat_id: opts.chatId,
            message_id: opts.messageId,
            text: opts.text,
        });
    }

    async sendChatAction(opts: { chatId: number; action: string }): Promise<unknown> {
        return await this.call<unknown>("sendChatAction", {
            chat_id: opts.chatId,
            action: opts.action,
        });
    }

    async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<unknown> {
        return await this.call<unknown>("setMyCommands", { commands });
    }
}
