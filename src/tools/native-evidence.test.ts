import { verifyCitationEnvelope } from "@bio-mcp/shared";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));

import { resetDatasetCache } from "../lib/ftp-catalogue";
import { eqtlCatalog } from "../spec/catalog";
import { fixture, recover } from "./staging-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetDatasetCache(); });

async function invoke(f: ReturnType<typeof fixture>, name: string, args: unknown, failed = false) {
  const result = await f.tools[name].handler(args, {});
  expect(result.isError === true, JSON.stringify(result).slice(0, 500)).toBe(failed);
  const sc = result.structuredContent;
  const id = sc.staged ? sc.data_access_id : sc.data?.__staged ? sc.data.data_access_id : undefined;
  const staged = id ? await recover(f, id, "") : undefined;
  const proof = await verifyCitationEnvelope({ citation: sc._meta?.citation, structuredContent: sc, toolArguments: args,
    ...(staged ? { materialized: { value: staged } } : {}) });
  expect(proof.verification).toMatchObject({ query: "verified", result: "verified" });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(30720);
  return { sc, id, data: sc.staged ? staged.structuredContent.data : sc.data?.__staged ? staged : sc.data };
}

it.each(["", "mcp_"])("verifies every %s alias on success and failure", async prefix => {
  const f = fixture();
  try {
    await invoke(f, `${prefix}eqtl_search`, { query: "region" });
    await invoke(f, `${prefix}eqtl_execute`, { code: "return {value:'001'};" });
    await invoke(f, `${prefix}eqtl_execute`, { code: "" }, true);
    await invoke(f, `${prefix}eqtl_query_data`, { data_access_id: "missing", sql: "SELECT * FROM missing" }, true);
    await invoke(f, `${prefix}eqtl_get_schema`, { data_access_id: "missing" });
  } finally { f.close(); }
});

it.each([
  { table: "associations", row: { molecular_trait_id: "ENSG1", pvalue: 1e-310, rsid: "001", beta: null } },
  { table: "top_associations", row: { molecular_trait_id: "ENSG1", p_beta: 1e-310, beta: null } },
  { table: "credible_sets", row: { molecular_trait_id: "ENSG1", cs_id: "ENSG1_L1", pip: 0.95, region: "chr20:1-2" } },
])("recovers aligned source TSV, repeated rows and all context from $table", async ({ table, row }) => {
  const f = fixture();
  const data = { rows: [row, row], raw_rows: ["ENSG1\t1.00000000000000001e-310\tNA", "ENSG1\t1.00000000000000001e-310\tNA"],
    native_header: "molecular_trait_id\tpvalue\tbeta", file_evidence: { sha256: "a".repeat(64), nested: [null, 0, "001"] },
    note: "α😀".repeat(12000), coverage_complete: false };
  try {
    const result = await invoke(f, "eqtl_execute", { code: `return ${JSON.stringify(data)};` });
    expect(result.sc.staged).toBe(true);
    expect(result.data).toEqual(data);
    expect(result.sc._meta.completeness.complete).toBe(false);
    const projection = await invoke(f, "mcp_eqtl_query_data", { data_access_id: result.id, sql: `SELECT native_json,source_tsv,source_index FROM ${table} ORDER BY source_index` });
    expect(projection.data.rows.map((r: { native_json: string }) => JSON.parse(r.native_json))).toEqual(data.rows);
    expect(projection.data.rows.map((r: { source_tsv: string }) => r.source_tsv)).toEqual(data.raw_rows);
    const context = await invoke(f, "eqtl_query_data", { data_access_id: result.id, sql: "SELECT native_json FROM response_context" });
    const { rows: _rows, raw_rows: _raw, ...rest } = data;
    expect(JSON.parse(context.data.rows[0].native_json)).toEqual(rest);
  } finally { f.close(); }
});

it("retains a large native HTTP error through API proxy staging", async () => {
  const f = fixture();
  const response = `<html>${"unavailable α".repeat(7000)}</html>`;
  vi.stubGlobal("fetch", async () => new Response(response, { status: 404, headers: { "content-type": "text/html" } }));
  try {
    const result = await invoke(f, "mcp_eqtl_execute", { code: 'return await api.get("/datasets");' }, true);
    expect(result.data).toMatchObject({ __api_error: true, status: 404 });
    const evidence = result.data.data.__staged ? await recover(f, result.data.data.data_access_id, "") : result.data.data;
    expect(evidence).toMatchObject({ response, http_status: 404, content_type: "text/html" });
  } finally { f.close(); }
});

it("keeps raw and parsed rows aligned after the catalog recipe filters significant hits", async () => {
  const run = new Function("api", `return (async () => { ${eqtlCatalog.workflows![0].code} })()`);
  const dataset = { dataset_id: "QTD000021" };
  const get = vi.fn().mockResolvedValueOnce({ datasets: [dataset], catalogue_snapshot: { metadata_sha256: "a", paths_sha256: "b" } })
    .mockResolvedValueOnce({ rows: [{ pvalue: 0.5 }, { pvalue: 1e-8 }, { pvalue: null }], raw_rows: ["0.5", "1e-8", "NA"], row_count: 3, truncated: false });
  expect(await run({ get })).toEqual([{ rows: [{ pvalue: 1e-8 }], raw_rows: ["1e-8"], row_count: 1, source_row_count: 3, truncated: false, selection: "pvalue < 1e-4 within returned slice" }]);
  expect(get.mock.calls[1][1]).toMatchObject({ metadata_sha256: "a", paths_sha256: "b" });
});
