import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_ENV_PATH = resolve(import.meta.dir, "../../.env");

export function loadRootEnv() {
    if (!existsSync(ROOT_ENV_PATH)) {
        return;
    }

    const lines = readFileSync(ROOT_ENV_PATH, "utf8").split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        const separator = trimmed.indexOf("=");

        if (separator === -1) {
            continue;
        }

        const key = trimmed.slice(0, separator).trim();
        let value = trimmed.slice(separator + 1).trim();

        if (!key || process.env[key] !== undefined) {
            continue;
        }

        if (
            (value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        process.env[key] = value;
    }
}

export function optionalEnv(name: string, fallback = "") {
    return process.env[name] || fallback;
}

export function requiredEnv(name: string) {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}
