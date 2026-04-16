import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eqtlFetch } from "../lib/http";
import {
    createCodeModeResponse,
    createCodeModeError,
} from "@bio-mcp/shared/codemode/response";
import { shouldStage, stageToDoAndRespond } from "@bio-mcp/shared/staging/utils";

interface SearchEnv {
    EQTL_DATA_DO?: {
        idFromName(name: string): unknown;
        get(id: unknown): { fetch(req: Request): Promise<Response> };
    };
}

/**
 * Lightweight top-level search over eQTL Catalogue associations.
 * Thin wrapper around the `/associations` endpoint — same caveats as the
 * upstream API: it's fragile and may intermittently 400/500/timeout.
 * Most callers should use Code Mode (eqtl_search + eqtl_execute) instead.
 */
export function registerSearch(server: McpServer, env?: SearchEnv): void {
    server.registerTool(
        "eqtl_search",
        {
            title: "Search eQTL Catalogue associations",
            description:
                "Broad search across eQTL Catalogue associations. Upstream is fragile — prefer Code Mode (eqtl_execute) for targeted gene/study/variant paths.",
            inputSchema: {
                variant_id: z.string().optional().describe("rsID or chr_pos_ref_alt (e.g. rs7903146)."),
                gene_id: z.string().optional().describe("Ensembl gene ID (e.g. ENSG00000141510)."),
                study: z.string().optional().describe("Study identifier filter."),
                tissue: z.string().optional().describe("Tissue ontology ID (UBERON_ or CL_)."),
                quant_method: z
                    .string()
                    .optional()
                    .describe("Quantification method (default: 'ge')."),
                size: z
                    .number()
                    .int()
                    .positive()
                    .max(500)
                    .optional()
                    .describe("Page size (default 10)."),
            },
        },
        async (args, extra) => {
            const runtimeEnv = env || (extra as { env?: SearchEnv })?.env;
            try {
                const params: Record<string, unknown> = {
                    quant_method: args.quant_method || "ge",
                    p_lower: 0,
                    p_upper: 1,
                    snp: args.variant_id || "",
                    variant_id: args.variant_id || "",
                    study: args.study || "",
                    tissue: args.tissue || "",
                    gene_id: args.gene_id || "",
                    molecular_trait_id: "",
                    qtl_group: "",
                    size: args.size ?? 10,
                };

                const response = await eqtlFetch("/associations", params);

                if (!response.ok) {
                    const body = await response.text().catch(() => "");
                    throw new Error(
                        `eQTL Catalogue API error: HTTP ${response.status}${body ? ` - ${body.slice(0, 300)}` : ""}`,
                    );
                }

                const data = await response.json();

                const responseSize = JSON.stringify(data).length;
                if (shouldStage(responseSize) && runtimeEnv?.EQTL_DATA_DO) {
                    const staged = await stageToDoAndRespond(
                        data,
                        runtimeEnv.EQTL_DATA_DO as DurableObjectNamespace,
                        "associations",
                        undefined,
                        undefined,
                        "eqtl",
                        (extra as { sessionId?: string })?.sessionId,
                    );
                    return createCodeModeResponse(
                        {
                            staged: true,
                            data_access_id: staged.dataAccessId,
                            total_rows: staged.totalRows,
                            _staging: staged._staging,
                            message: `Results staged. Use eqtl_query_data with data_access_id '${staged.dataAccessId}' to query.`,
                        },
                        { meta: { staged: true, data_access_id: staged.dataAccessId } },
                    );
                }

                const results = Array.isArray(data) ? data : [data];
                return createCodeModeResponse(
                    { results, total: results.length },
                    { meta: { fetched_at: new Date().toISOString(), total: results.length } },
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return createCodeModeError("API_ERROR", `eqtl_search failed: ${msg}`);
            }
        },
    );
}
