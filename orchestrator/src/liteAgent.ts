// Gemini Flash Lite streaming client with function calling.
//
// One call to `runLiteAgent` runs the full tool-loop until the model emits a
// pure text response with no further tool calls. Streaming text chunks are
// forwarded via `onText`; tool calls are dispatched synchronously through
// `dispatchTool` and fed back into the same model call.

import { GoogleGenAI, type Content, type FunctionCall, type Part } from "@google/genai";
import type { Message } from "./types";
import { dispatchTool, liteToolDeclarations, type ToolCallContext } from "./tools";

const MODEL = process.env.LITE_MODEL ?? "gemini-3.5-flash";

let client: GoogleGenAI | undefined;
function getClient(): GoogleGenAI {
    if (!client) {
        const isProd = process.env.NODE_ENV === "production";
        client = new GoogleGenAI({
            vertexai: isProd,
            project: isProd ? process.env.VERTEX_PROJECT : undefined,
            location: isProd ? process.env.VERTEX_LOCATION : undefined,
            apiKey: isProd ? undefined : process.env.GEMINI_API_KEY ?? process.env.VERTEX_API_KEY,
        } as any);
    }
    return client;
}

function renderHistory(messages: Message[]): Content[] {
    return messages.map(m => {
        // Append marker tag if present.
        let text = m.text;
        if (m.marker) text = `${text}\n<${m.marker}>`;
        // Gemini uses 'model' for assistant role.
        return {
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text }],
        } as Content;
    });
}

export type LiteAgentArgs = {
    systemPrompt: string;
    history: Message[];
    toolContext: ToolCallContext;
    signal: AbortSignal;
    onText: (text: string) => void;
};

export async function runLiteAgent(args: LiteAgentArgs): Promise<void> {
    const ai = getClient();
    const contents: Content[] = renderHistory(args.history);

    // Outer loop: each iteration is one `generateContentStream` invocation.
    // We exit when an iteration completes with no function calls — i.e. the
    // model produced its final textual answer.
    while (!args.signal.aborted) {
        let pendingCalls: FunctionCall[] = [];
        let assistantParts: Part[] = [];

        const stream = await ai.models.generateContentStream({
            model: MODEL,
            contents,
            config: {
                systemInstruction: args.systemPrompt,
                tools: [{ functionDeclarations: liteToolDeclarations }],
                abortSignal: args.signal,
                thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
            },
        });

        for await (const chunk of stream) {
            if (args.signal.aborted) break;

            const parts = chunk.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
                if (part.text) {
                    args.onText(part.text);
                    assistantParts.push({ text: part.text });
                }
                if (part.functionCall) {
                    pendingCalls.push(part.functionCall);
                    assistantParts.push({ functionCall: part.functionCall });
                }
            }
        }

        if (args.signal.aborted) return;

        // If the model didn't call any tools, this turn is done.
        if (pendingCalls.length === 0) return;

        // Persist the model's turn (text + function calls) and append tool
        // results before the next iteration.
        contents.push({ role: "model", parts: assistantParts });

        const responseParts: Part[] = [];
        for (const call of pendingCalls) {
            const name = call.name ?? "";
            const out = await dispatchTool(args.toolContext, name, (call.args ?? {}) as Record<string, unknown>);
            responseParts.push({
                functionResponse: { name, response: out },
            });
        }
        contents.push({ role: "user", parts: responseParts });
    }
}
