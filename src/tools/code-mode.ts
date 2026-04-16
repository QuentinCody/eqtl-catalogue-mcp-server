import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { eqtlCatalog } from "../spec/catalog";
import { createEqtlApiFetch } from "../lib/api-adapter";

interface CodeModeEnv {
    EQTL_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export function registerCodeMode(server: McpServer, env: CodeModeEnv): void {
    const apiFetch = createEqtlApiFetch();

    const searchTool = createSearchTool({
        prefix: "eqtl",
        catalog: eqtlCatalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = createExecuteTool({
        prefix: "eqtl",
        catalog: eqtlCatalog,
        apiFetch,
        doNamespace: env.EQTL_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
