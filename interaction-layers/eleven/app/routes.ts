import { type RouteConfig, index, prefix, route } from "@react-router/dev/routes";

export default [
    index("routes/home.tsx"),
    ...prefix("api", [
        route("status", "routes/api/status.ts"),
        route("sessions", "routes/api/sessions.ts"),
        route("select-session", "routes/api/select-session.ts"),
    ]),
] satisfies RouteConfig;
