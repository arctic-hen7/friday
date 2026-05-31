import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { ElevenLabs } from "@elevenlabs/elevenlabs-js";
import { loadRootEnv, optionalEnv, requiredEnv } from "../src/env";

loadRootEnv();

type CliOptions = {
    name?: string;
    wsUrl?: string;
    engineId?: string;
    voiceId?: string;
    voiceSpeed?: string;
    language?: string;
};

function parseArgs(argv: string[]) {
    const options: CliOptions = {};

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        const next = argv[index + 1];

        if (!arg.startsWith("--")) {
            continue;
        }

        const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
        const value = inlineValue ?? next;

        if (!value) {
            throw new Error(`Missing value for --${rawKey}`);
        }

        if (!inlineValue) {
            index += 1;
        }

        switch (rawKey) {
            case "name":
                options.name = value;
                break;
            case "ws-url":
                options.wsUrl = value;
                break;
            case "engine-id":
                options.engineId = value;
                break;
            case "voice-id":
                options.voiceId = value;
                break;
            case "voice-speed":
                options.voiceSpeed = value;
                break;
            case "language":
                options.language = value;
                break;
            default:
                throw new Error(`Unknown option: --${rawKey}`);
        }
    }

    return options;
}

function defaultWsUrl() {
    const publicBaseUrl = optionalEnv("PUBLIC_GATEWAY_URL");

    if (!publicBaseUrl) {
        throw new Error("Set PUBLIC_GATEWAY_URL or pass --ws-url");
    }

    return `${publicBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/api/speech-engine/ws`;
}

const options = parseArgs(Bun.argv.slice(2));
const elevenlabs = new ElevenLabsClient({
    apiKey: requiredEnv("ELEVENLABS_API_KEY"),
});
const voiceSpeed = Number(options.voiceSpeed || optionalEnv("ELEVENLABS_VOICE_SPEED", "1.05"));

if (!Number.isFinite(voiceSpeed) || voiceSpeed <= 0) {
    throw new Error("Voice speed must be a positive number");
}

const payload: ElevenLabs.CreateSpeechEngineRequest = {
    name: options.name || optionalEnv("SPEECH_ENGINE_NAME", "Friday Voice Agent"),
    speechEngine: {
        wsUrl: options.wsUrl || defaultWsUrl(),
    },
    tts: {
        voiceId: options.voiceId || optionalEnv("ELEVENLABS_VOICE_ID") || undefined,
        speed: voiceSpeed,
    },
    language: options.language || optionalEnv("SPEECH_ENGINE_LANGUAGE", "en"),
    conversation: {
        clientEvents: [
            "audio",
            "user_transcript",
            "agent_response",
            "agent_response_complete",
            "interruption",
            "vad_score",
        ],
    },
};

const engine = options.engineId
    ? await elevenlabs.speechEngine.update(options.engineId, payload)
    : await elevenlabs.speechEngine.create(payload);

console.log(`ELEVENLABS_SPEECH_ENGINE_ID=${engine.engineId}`);

if (engine.config) {
    console.log(`Name: ${engine.config.name}`);
    console.log(`WebSocket URL: ${engine.config.speechEngine.wsUrl}`);
}
