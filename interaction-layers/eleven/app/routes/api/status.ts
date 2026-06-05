import { getGatewayConfig, jsonResponse } from "~/speechEngine";
import { orchestratorBaseUrl } from "~/orchestrator";

export async function loader() {
    const { speechEngineId } = getGatewayConfig();
    return jsonResponse({
        ok: true,
        speechEngineId,
        orchestrator: orchestratorBaseUrl(),
    });
}
