// Shared HTTP helpers used by React Router route handlers.

export function getApiHeaders(): Headers {
    return new Headers({ "Content-Type": "application/json" });
}

export function jsonResponse(payload: unknown, init?: ResponseInit): Response {
    const headers = getApiHeaders();
    for (const [k, v] of new Headers(init?.headers)) headers.set(k, v);
    return new Response(JSON.stringify(payload), { ...init, headers });
}
