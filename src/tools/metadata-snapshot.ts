import { McpServer } from "@bio-mcp/shared/mcp";
import { z } from "zod";
import { metadataSnapshot } from "../lib/metadata-snapshot";
import { eqtlResponse, type EqtlDataEnv } from "../lib/tool-result";

/** Complete metadata-file evidence for consumers that must reject partial pages. */
export function registerMetadataSnapshot(server: McpServer, env: EqtlDataEnv) {
  const config = {
    title: "Read complete r8 beta metadata snapshot",
    description: "Retain the complete eQTL r8 beta metadata TSV, native columns and SHA-256. Complete refers only to this file, not biological coverage. Cached up to one hour; retrieved_at identifies the observation. Large evidence stages for eqtl_query_data. No Parquet backend is needed.",
    inputSchema: { release: z.literal("r8_beta"), metadata_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() },
  };
  for (const name of ["eqtl_metadata_snapshot", "mcp_eqtl_metadata_snapshot"]) {
    server.registerTool(name, config, (args, extra) => eqtlResponse(async () => ({
      content: [{ type: "text", text: "Complete selected metadata-file snapshot; retain its native TSV and checksum." }],
      structuredContent: { success: true, data: await metadataSnapshot(args) },
    }), env, name, extra, args));
  }
}
