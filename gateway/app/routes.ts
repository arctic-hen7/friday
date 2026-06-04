import { type RouteConfig, index, prefix, route } from "@react-router/dev/routes";

export default [
    index("routes/home.tsx"),
    ...prefix("api", [
        route("status", "routes/api/status.ts"),
        route("conversation-token", "routes/api/conversation-token.ts"),
        route("mute", "routes/api/mute.ts"),
        route("unmute", "routes/api/unmute.ts"),
    ]),
] satisfies RouteConfig;
