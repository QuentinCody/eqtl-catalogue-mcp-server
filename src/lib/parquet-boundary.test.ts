import { afterEach, describe, expect, it, vi } from "vitest";
import { parquetRequest, queryParquet } from "./parquet";

const env = { EQTL_PARQUET_URL: "https://query.example/query", EQTL_PARQUET_TOKEN: "fixture-service-secret-1234567890" };
const route = { kind: "top-associations", datasetId: "QTD000116" } as const;
const params = { release: "r8_beta", metadata_sha256: "a".repeat(64), file_sha256: "b".repeat(64), molecular_trait_id: "ENSG000001", max_rows: 2 };
const schema = [{ name: "molecular_trait_id", type: "string", nullable: true }, { name: "p_beta", type: "double", nullable: true }];
function result() {
  return { ...parquetRequest(route, params), assembly: "GRCh38", status: "pre-release",
    metadata: { dataset_id: route.datasetId, study_id: "QTS000015", sample_size: "711" },
    source_url: "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/sumstats/QTS000015/QTD000116/QTD000116.permuted.parquet",
    schema, rows: [{ molecular_trait_id: "ENSG000001", p_beta: null }], row_count: 1,
    truncated: false, truncation_reason: null, total_matching_rows: null };
}
const run = () => queryParquet(route, params, env);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Parquet backend response identity", () => {
  it("retains native duplicate rows, nulls and unknown metadata without mutation", async () => {
    const data = result(); data.rows.push({ ...data.rows[0] }); data.row_count = 2;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    expect(await run()).toEqual(data);
  });

  it.each([
    ["wrong study", { metadata: { dataset_id: "QTD000116", study_id: "QTS000999" } }],
    ["wrong metadata dataset", { metadata: { dataset_id: "QTD000244", study_id: "QTS000015" } }],
    ["absent metadata", { metadata: null }],
    ["wrong category", { source_url: result().source_url.replace("sumstats", "susie") }],
    ["extra URL query", { source_url: `${result().source_url}?other=1` }],
    ["wrong file", { source_url: result().source_url.replace("permuted.parquet", "all.parquet") }],
    ["wrong release status", { status: "released" }],
    ["dropped filter", { filters: [] }],
    ["changed filter", { filters: [{ column: "molecular_trait_id", op: "eq", value: "ENSG000002" }] }],
    ["extra filter field", { filters: [{ ...result().filters[0], ignored: true }] }],
    ["missing column", { rows: [{ molecular_trait_id: "ENSG000001" }] }],
    ["unexpected column", { rows: [{ molecular_trait_id: "ENSG000001", p_beta: null, extra: 1 }] }],
    ["array row", { rows: [["ENSG000001", null]] }],
    ["duplicate schema field", { schema: [schema[0], schema[0]] }],
    ["empty schema", { schema: [] }],
    ["incomplete schema", { schema: [{ name: "molecular_trait_id" }] }],
    ["invented count", { total_matching_rows: 1 }],
    ["missing truncation reason", { truncated: true }],
    ["false row cap", { truncated: true, truncation_reason: "max_rows" }],
    ["reason on complete result", { truncation_reason: "response_bytes" }],
  ])("rejects %s", async (_label, changes) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...result(), ...changes })));
    await expect(run()).rejects.toMatchObject({ status: 502 });
  });

  it.each([null, [], "unexpected"])("rejects a non-object response %j", async data => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    await expect(run()).rejects.toMatchObject({ status: 502 });
  });

  it("accepts schema-only and byte-capped results", async () => {
    const data = result();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...data, truncated: true, truncation_reason: "response_bytes" })));
    expect(await run()).toMatchObject({ truncated: true, truncation_reason: "response_bytes" });
    const { rows: _rows, filters: _filters, ...schemaOnly } = data;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(schemaOnly)));
    expect(await queryParquet({ kind: "parquet-schema", datasetId: route.datasetId },
      { ...params, molecular_trait_id: undefined, file_role: "permuted" }, env)).toEqual(schemaOnly);
  });
});

describe("bounded private Parquet transport", () => {
  it.each([206, 302, 409, 500])("rejects HTTP %i without reading or leaking its body", async status => {
    const response = new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await run().catch(error => error);
    expect(error.status).toBe(status === 409 ? 409 : 502);
    expect(JSON.stringify(error)).not.toContain(env.EQTL_PARQUET_TOKEN);
  });

  it.each([
    { "content-type": "text/html" },
    { "content-type": "application/json", "content-range": "bytes 0-100/500" },
  ])("rejects unsuitable response headers without body evidence", async headers => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(env.EQTL_PARQUET_TOKEN, { headers: headers as Record<string, string> })));
    const error = await run().catch(error => error);
    expect(error.status).toBe(502);
    expect(JSON.stringify(error)).not.toContain(env.EQTL_PARQUET_TOKEN);
  });

  it("sanitizes transport errors even when they carry a status and trusted-looking prefix", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error(`eQTL Catalogue: ${env.EQTL_PARQUET_TOKEN}`), { status: 409 })));
    const error = await run().catch(error => error);
    expect(error.status).toBe(502);
    expect(JSON.stringify(error)).not.toContain(env.EQTL_PARQUET_TOKEN);
  });

  it.each(["invalid UTF-8", "invalid JSON", "oversized JSON", "encoded credential"])("rejects %s safely", async kind => {
    const body = kind === "invalid UTF-8" ? new Uint8Array([0xff]) : kind === "invalid JSON" ? `{${env.EQTL_PARQUET_TOKEN}` :
      kind === "oversized JSON" ? JSON.stringify("é".repeat(1024 * 1024)) : JSON.stringify({ token: env.EQTL_PARQUET_TOKEN }).replace("fixture", "\\u0066ixture");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } })));
    const error = await run().catch(error => error);
    expect(error.status).toBe(502);
    expect(JSON.stringify(error)).not.toContain(env.EQTL_PARQUET_TOKEN);
  });

  it("accepts a UTF-8 BOM and JSON charset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`\uFEFF${JSON.stringify(result())}`, { headers: { "content-type": "application/json; charset=utf-8" } })));
    expect(await run()).toEqual(result());
  });

  it("caps request bytes before sending anything", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(queryParquet(route, { ...params, molecular_trait_id: "é".repeat(40_000) }, env)).rejects.toMatchObject({ status: 413 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes malformed service URLs", async () => {
    await expect(queryParquet(route, params, { ...env, EQTL_PARQUET_URL: "not a url" })).rejects.toMatchObject({ status: 503 });
  });

  it("stops an unresponsive connection and disposes of a late response", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const checked = expect(run()).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(35_001); await checked;
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("shares the connection deadline with a stalled body and cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30_000));
      return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { headers: { "content-type": "application/json" } });
    }));
    const checked = expect(run()).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(35_001); await checked;
    expect(vi.getTimerCount()).toBe(0);
  });
});
