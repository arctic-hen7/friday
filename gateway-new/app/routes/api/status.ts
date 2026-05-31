import { getGatewayConfig, jsonResponse } from "~/speechEngine";

export async function loader() {
    const { llmModel, speechEngineId } = getGatewayConfig();

    return jsonResponse({
        ok: true,
        speechEngineId,
        model: llmModel,
    });
}
