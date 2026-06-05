import compression from "compression";
import express, { type Express, type RequestHandler } from "express";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import type { ServerBuild } from "react-router";
import { attachSpeechEngine, SPEECH_ENGINE_WS_PATH } from "./app/speechEngine";

const DEVELOPMENT = process.env.NODE_ENV !== "production";
const PORT = Number.parseInt(process.env.ELEVEN_PORT || "5000", 10);

const root = import.meta.dirname;
const clientBuildDirectory = resolve(root, "build/client");
const serverBuildPath = resolve(root, "build/server/index.js");

async function configureDevelopmentApp(app: Express, httpServer: HttpServer) {
    const vite = await import("vite");
    const viteDevServer = await vite.createServer({
        appType: "custom",
        server: {
            middlewareMode: true,
            hmr: {
                server: httpServer,
            },
        },
    });

    app.use(viteDevServer.middlewares);
    app.use(
        createRequestHandler({
            build: async () => {
                return await viteDevServer.ssrLoadModule("virtual:react-router/server-build") as ServerBuild;
            },
            mode: "development",
        }),
    );
}

async function configureProductionApp(app: Express) {
    const build = await import(pathToFileURL(serverBuildPath).href) as ServerBuild;

    app.use(
        "/assets",
        express.static(resolve(clientBuildDirectory, "assets"), {
            immutable: true,
            maxAge: "1y",
        }),
    );
    app.use(express.static(clientBuildDirectory, { maxAge: "1h" }));

    app.use(
        createRequestHandler({
            build,
            mode: "production",
        }),
    );
}

async function start() {
    const app = express();
    const httpServer = createHttpServer(app);

    attachSpeechEngine(httpServer);

    app.disable("x-powered-by");
    app.use(compression() as unknown as RequestHandler);
    app.get(SPEECH_ENGINE_WS_PATH, (_req, res) => {
        res
            .status(426)
            .set("Upgrade", "websocket")
            .type("text/plain")
            .send("Use a WebSocket connection for this endpoint.");
    });

    if (DEVELOPMENT) {
        await configureDevelopmentApp(app, httpServer);
    } else {
        await configureProductionApp(app);
    }

    httpServer.listen(PORT, () => {
        console.log(`Gateway listening on http://localhost:${PORT}`);
        console.log(`React Router mode: ${DEVELOPMENT ? "development" : "production"}`);
        console.log(`Speech Engine WebSocket path: ${SPEECH_ENGINE_WS_PATH}`);
    });
}

start().catch(error => {
    console.error("Failed to start gateway:", error);
    process.exit(1);
});
