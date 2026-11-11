import type { McpServer } from "@bio-mcp/shared/mcp";
import { createQueryDataHandler } from "@bio-mcp/shared/staging/utils";
import { z } from "zod";
import { eqtlResponse } from "../lib/tool-result";

interface QueryEnv {
    EQTL_DATA_DO?: unknown;
}

export function registerQueryData(server: McpServer, env?: QueryEnv): void {
    const handler = createQueryDataHandler("EQTL_DATA_DO", "eqtl");

    for (const name of ["eqtl_query_data", "mcp_eqtl_query_data"]) server.registerTool(
        name,
        {
            title: "Query Staged eQTL Catalogue Data",
            description:
                "Query staged eQTL Catalogue data using SQL. Use this when responses are too large and have been staged with a data_access_id.",
            inputSchema: {
                data_access_id: z.string().min(1).describe("Data access ID for the staged dataset"),
                sql: z.string().min(1).describe("SQL query to execute against the staged data"),
                limit: z
                    .number()
                    .int()
                    .positive()
                    .max(10000)
                    .optional()
                    .describe("Maximum number of rows to return (default: 100)"),
            },
        },
        async (args, extra) => {
            const runtimeEnv = env || (extra as { env?: QueryEnv })?.env || {};
            return eqtlResponse(() => handler(args as Record<string, unknown>, runtimeEnv as Record<string, unknown>), runtimeEnv, name, extra, args);
        },
    );
}
