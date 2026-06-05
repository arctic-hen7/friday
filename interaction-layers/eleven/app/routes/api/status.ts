import { jsonResponse } from "~/http";
import { orchestratorBaseUrl } from "~/orchestrator";

export async function loader() {
    return jsonResponse({
        ok: true,
        orchestrator: orchestratorBaseUrl(),
    });
}
