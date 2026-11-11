import { McpServer } from "@bio-mcp/shared/mcp";
import { expect, it } from "vitest";
import { registerCodeMode } from "./code-mode";
import { registerGetSchema } from "./get-schema";
import { registerQueryData } from "./query-data";
import { registerMetadataSnapshot } from "./metadata-snapshot";

it("registers both aliases and discovers release-aware Parquet operations", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  registerCodeMode(server, { CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1]);
  registerQueryData(server, {}); registerGetSchema(server, {});
  registerMetadataSnapshot(server, {});
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
  for (const name of ["eqtl_search", "eqtl_execute", "eqtl_query_data", "eqtl_get_schema", "eqtl_metadata_snapshot"]) {
    expect(tools[name]).toBeDefined(); expect(tools[`mcp_${name}`]).toBeDefined();
  }
  const result = await tools.mcp_eqtl_search.handler({ query: "parquet_schema", category: "metadata", max_results: 5 }, {});
  expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true } });
  expect(JSON.stringify(result)).toContain("/datasets/{dataset_id}/parquet_schema");
  expect(await tools.mcp_eqtl_query_data.handler({ data_access_id: "eqtl_fixture", sql: "SELECT 1" }, {})).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: expect.any(Object) });
});
