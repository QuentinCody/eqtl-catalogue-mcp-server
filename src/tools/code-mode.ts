import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import type { McpServer } from "@bio-mcp/shared/mcp";
import { createEqtlApiFetch } from "../lib/api-adapter";
import type { ParquetEnv } from "../lib/parquet";
import { EQTL_SOURCE, eqtlResponse } from "../lib/tool-result";
import { eqtlCatalog } from "../spec/catalog";

interface CodeModeEnv extends ParquetEnv {
    EQTL_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export function registerCodeMode(server: McpServer, env: CodeModeEnv): void {
    const apiFetch = createEqtlApiFetch(env);
    const registrar = { tool: (...args: unknown[]) => {
        const [name, ...rest] = args;
        const handler = rest.pop() as (input: unknown, extra: unknown) => ReturnType<typeof eqtlResponse>;
        const respond = (input: unknown, extra: unknown) => eqtlResponse(() => handler(input, extra), env, String(name), extra, input);
        const register = server.tool.bind(server) as (...values: unknown[]) => void;
        register(name, ...rest, respond);
        register(`mcp_${String(name)}`, ...rest, respond);
    } };

    const searchTool = createSearchTool({
        prefix: "eqtl",
        catalog: eqtlCatalog,
    });
    searchTool.register(registrar);

    const executeTool = createExecuteTool({
        prefix: "eqtl",
        // Verifiable provenance: eqtl_execute results carry a _meta.citation.
        source: EQTL_SOURCE,
        catalog: eqtlCatalog,
        apiFetch,
        preserveApiErrors: true,
        maxInlineBytes: 30 * 1024,
        doNamespace: env.EQTL_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(registrar);
}
