import { isbot } from "isbot";
import { ServerRouter, type EntryContext } from "react-router";
import { renderToReadableStream } from "react-dom/server";

export const streamTimeout = 5_000;

export default async function handleRequest(
    request: Request,
    responseStatusCode: number,
    responseHeaders: Headers,
    routerContext: EntryContext,
) {
    if (request.method.toUpperCase() === "HEAD") {
        return new Response(null, {
            status: responseStatusCode,
            headers: responseHeaders,
        });
    }

    let statusCode = responseStatusCode;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), streamTimeout + 1_000);

    const body = await renderToReadableStream(
        <ServerRouter context={routerContext} url={request.url} />,
        {
            signal: controller.signal,
            onError(error) {
                statusCode = 500;
                console.error(error);
            },
        },
    );

    const userAgent = request.headers.get("user-agent");

    if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
        await body.allReady;
    }

    clearTimeout(timeoutId);
    responseHeaders.set("Content-Type", "text/html");

    return new Response(body, {
        status: statusCode,
        headers: responseHeaders,
    });
}
