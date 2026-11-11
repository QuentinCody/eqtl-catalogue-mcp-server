import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { beforeEach, expect, it, vi } from "vitest";
import { eqtlCatalog } from "../spec/catalog";
import { createEqtlApiFetch } from "./api-adapter";
import { buildDatasets, parseTsv, resetDatasetCache } from "./ftp-catalogue";
import { parseR7Table } from "./r7-snapshot";
import { sha256 } from "./release";

const mocks = vi.hoisted(() => ({ resourcesFetch: vi.fn(), queryRegion: vi.fn(), readTsvGz: vi.fn() }));
vi.mock("@bio-mcp/shared/adapters/eqtl/http", async original => ({ ...await original<object>(), resourcesFetch: mocks.resourcesFetch }));
vi.mock("./sumstats", async original => ({ ...await original<object>(), queryRegion: mocks.queryRegion, readTsvGz: mocks.readTsvGz }));

// First record and headers observed in the official r7 metadata/file map, 2026-10-01.
const identity = "study_id\tdataset_id\tstudy_label\tsample_group\ttissue_id\ttissue_label\tcondition_label\tsample_size\tquant_method";
const row = "QTS000001\tQTD000001\tAlasoo_2018\tmacrophage_naive\tCL_0000235\tmacrophage\tnaive\t84\tge";
const root = "ftp://ftp.ebi.ac.uk/pub/databases/spot/eQTL";
const paths = `${identity}\tftp_path\tftp_cs_path\tftp_lbf_path\n${row}\t${root}/sumstats/QTS000001/QTD000001/QTD000001.all.tsv.gz\t${root}/susie/QTS000001/QTD000001/QTD000001.credible_sets.tsv.gz\t${root}/susie/QTS000001/QTD000001/QTD000001.lbf_variable.txt.gz\n`;
const metadata = `${identity}\tpmid\tstudy_type\n${row}\t29379200\tbulk\n`;
const api = createEqtlApiFetch();
const request = (path: string, params: Record<string, unknown> = {}) => api({ method: "GET", path, params });
const pins = async () => ({ metadata_sha256: await sha256(metadata), paths_sha256: await sha256(paths) });

it.each(["index_sha256", "header_sha256", "range_sha256"])("rejects misplaced or malformed region pin %s before I/O", async key => {
  for (const [path, params] of [
    ["/datasets", { [key]: "a".repeat(64) }],
    ["/datasets/QTD000001/region", { release: "r8_beta", [key]: "a".repeat(64) }],
    ["/datasets/QTD000001/region", { [key]: "bad" }],
  ] as const) await expect(request(path, params)).rejects.toMatchObject({ status: 400 });
  expect(mocks.resourcesFetch).not.toHaveBeenCalled();
});

beforeEach(() => {
  vi.resetAllMocks(); resetDatasetCache();
  mocks.resourcesFetch.mockImplementation(async (path: string) => new Response(path.includes("tabix") ? paths : metadata));
  mocks.queryRegion.mockResolvedValue({ rows: [{ variant: "chr1_100_A_C", pvalue: 0.01 }], row_count: 1, truncated: false });
  mocks.readTsvGz.mockResolvedValue({ rows: [{ variant: "chr1_100_A_C", pip: 0.8 }], row_count: 1, truncated: false });
});

it.each([
  "/datasets", "/datasets/QTD000001", "/datasets/QTD000001/files", "/studies", "/studies/QTS000001",
  "/datasets/QTD000001/region", "/datasets/QTD000001/top_associations", "/datasets/QTD000001/credible_sets",
])("preserves matching catalogue pins and evidence on %s", async path => {
  const result = await request(path, { ...await pins(), chromosome: path.endsWith("region") ? "1" : undefined, start: 100, end: 100 });
  expect(result.status).toBe(200);
  expect(result.data).toMatchObject({ catalogue_snapshot: { release: "r7", ...await pins(), retrieved_at: expect.any(String) } });
  expect(mocks.resourcesFetch).toHaveBeenCalledTimes(2);
});

it.each(["metadata_sha256", "paths_sha256"])("stops every r7 data read before bulk access when %s drifts", async key => {
  for (const path of ["/datasets", "/studies", "/datasets/QTD000001", "/studies/QTS000001", "/datasets/QTD000001/files", "/datasets/QTD000001/region", "/datasets/QTD000001/top_associations", "/datasets/QTD000001/credible_sets"]) {
    await expect(request(path, { ...await pins(), [key]: "0".repeat(64), chromosome: "1", start: 100, end: 100 })).rejects.toMatchObject({ status: 409 });
  }
  expect(mocks.queryRegion).not.toHaveBeenCalled(); expect(mocks.readTsvGz).not.toHaveBeenCalled();
});

it("retains snapshot evidence on empty results and cached pages", async () => {
  const empty = await request("/datasets", { ...await pins(), search: "absent" });
  expect(empty.data).toMatchObject({ matched_datasets: 0, datasets: [], catalogue_snapshot: await pins() });
  const page = await request("/datasets", { ...await pins(), offset: 1 });
  expect(page.data).toMatchObject({ matched_datasets: 1, datasets: [], catalogue_snapshot: await pins() });
  const studies = await request("/studies", { ...await pins(), search: "absent" });
  expect(studies.data).toMatchObject({ study_count: 0, studies: [], catalogue_snapshot: await pins() });
  expect(mocks.resourcesFetch).toHaveBeenCalledTimes(2);
});

it.each([{ metadata_sha256: "bad" }, { paths_sha256: null }, { paths_sha256: "A".repeat(64) }, { file_sha256: "a".repeat(64) }, { release: "r8_beta", paths_sha256: "a".repeat(64) }])("rejects invalid or wrong-release pins without fetching: %j", async params => {
  await expect(request("/datasets", params)).rejects.toMatchObject({ status: 400 });
  expect(mocks.resourcesFetch).not.toHaveBeenCalled();
});

it("accepts URL pins and preserves drift errors through the actual Code Mode proxy", async () => {
  const pin = await pins();
  const result = await request(`/datasets/QTD000001?metadata_sha256=${pin.metadata_sha256}&paths_sha256=${pin.paths_sha256}`);
  expect(result.data).toMatchObject({ dataset_id: "QTD000001", catalogue_snapshot: pin });
  const proxy = createApiProxyTool({ apiFetch: api, catalog: eqtlCatalog, stagingPrefix: "eqtl" });
  const data = await proxy.handler({ method: "GET", path: "/datasets", params: { paths_sha256: "0".repeat(64) } }, { sql: () => [] });
  expect(data).toMatchObject({ __api_error: true, status: 409 });
});

it("preserves native region text and file evidence when Code Mode stages a large result", async () => {
  const source = { rows: Array.from({ length: 500 }, () => ({ molecular_trait_id: "ENSG1", pvalue: 0 })),
    raw_rows: Array(500).fill("ENSG1\t1e-400"), native_header: "molecular_trait_id\tpvalue",
    coverage_complete: false, file_evidence: { index: { sha256: "a".repeat(64) }, range: { sha256: "b".repeat(64) } } };
  mocks.queryRegion.mockResolvedValue(source);
  const stored: unknown[] = [];
  const doNamespace = { idFromName: (id: string) => id, get: () => ({ fetch: async (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === "/process") {
      stored.push((await req.json() as { data: unknown }).data);
      return Response.json({ success: true, tables_created: ["associations"], total_rows: 500, input_rows: 500, table_row_counts: { associations: 500 } });
    }
    if (path === "/schema") return Response.json({ success: true, schema: { tables: { associations: { columns: [] } } } });
    if (path === "/register") return Response.json({ success: true });
    return Response.json({ success: false }, { status: 404 });
  } }) };
  const proxy = createApiProxyTool({ apiFetch: api, catalog: eqtlCatalog, stagingPrefix: "eqtl", doNamespace });
  const result = await proxy.handler({ method: "GET", path: "/datasets/QTD000001/region", params: { chromosome: "1", start: 100, end: 100 } }, { sql: () => [] });
  expect(result).toMatchObject({ __staged: true });
  expect(JSON.stringify(result).length).toBeLessThan(100_000);
  expect(stored).toHaveLength(2);
  expect(JSON.parse(stored[0] as string)).toMatchObject(source);
  expect(stored[1]).toMatchObject(source);
});

it.each(["study_id", "study_label", "sample_group", "tissue_id", "tissue_label", "condition_label", "quant_method"])("refuses a reused dataset ID with conflicting %s", column => {
  const meta = parseTsv(metadata); meta[0][column] = "different-analysis";
  expect(() => buildDatasets(parseTsv(paths), meta)).toThrow(`disagree on QTD000001 ${column}`);
});

it("rejects missing or duplicate identities instead of silently joining/overwriting", () => {
  const p = parseTsv(paths);
  const m = parseTsv(metadata);
  for (const [pathRows, metadataRows] of [[p, []], [[...p, ...p], m], [p, [...m, ...m]], [[{ ...p[0], dataset_id: "bad" }], m], [[{ ...p[0], ftp_path: "" }], m]]) {
    expect(() => buildDatasets(pathRows, metadataRows)).toThrow();
  }
});

it("does not memoize a mismatched catalogue and recovers after corrected upstream data", async () => {
  mocks.resourcesFetch.mockImplementationOnce(async () => new Response(paths.replace("Alasoo_2018", "different-analysis")));
  await expect(request("/datasets")).rejects.toMatchObject({ status: 502 });
  expect((await request("/datasets")).data).toMatchObject({ total_datasets: 1, datasets: [{ sample_size: 84 }] });
  expect(mocks.resourcesFetch).toHaveBeenCalledTimes(4);
});

it("rejects duplicate/missing headers and shifted rows while preserving empty trailing cells", () => {
  for (const text of [metadata.replace("\tpmid", "\tdataset_id"), metadata.replace("\tstudy_type", "\tchanged"), metadata.replace("\t29379200", ""), metadata.replace("\tbulk\n", "\tbulk\textra\n")]) {
    expect(() => parseR7Table(text, "metadata")).toThrow();
  }
  const row = parseR7Table(`\uFEFF${metadata.replace("\tbulk\n", "\t").replaceAll("\n", "\r\n")}`, "metadata")[0];
  expect(row).toMatchObject({ pmid: "29379200", study_type: "" });
});

it("retains both native sample-size claims for the observed QTD000590 disagreement", async () => {
  const nativeIdentity = "QTS000036\tQTD000590\tRandolph_2021\tCD8_T_flu\tCL_0000625\tCD8+ T cell\tInfluenza_6h";
  const nativePaths = `${identity}\tftp_path\tftp_cs_path\tftp_lbf_path\n${nativeIdentity}\t89\tge\t${root}/sumstats/QTS000036/QTD000590/QTD000590.all.tsv.gz\t${root}/susie/QTS000036/QTD000590/QTD000590.credible_sets.tsv.gz\t${root}/susie/QTS000036/QTD000590/QTD000590.lbf_variable.txt.gz\n`;
  const nativeMetadata = `${identity}\tpmid\tstudy_type\n${nativeIdentity}\t88\tge\t34822289\tsingle-cell\n`;
  mocks.resourcesFetch.mockImplementation(async (path: string) => new Response(path.includes("tabix") ? nativePaths : nativeMetadata));
  const result = await request("/datasets/QTD000590");
  expect(result.data).toMatchObject({
    sample_size: 89, study_type: "single-cell",
    sample_size_provenance: { selected_source: "file_map", file_map_value: "89", metadata_value: "88", agreement: false },
    catalogue_snapshot: { metadata_sha256: await sha256(nativeMetadata), paths_sha256: await sha256(nativePaths) },
  });
});

it("carries both catalogue pins through the published Code Mode workflow and retains source errors", async () => {
  const pin = await pins();
  const error = { __api_error: true, status: 409, message: "catalogue changed" };
  const get = vi.fn().mockResolvedValueOnce({ datasets: [{ dataset_id: "QTD000001" }], catalogue_snapshot: pin }).mockResolvedValueOnce(error);
  const code = eqtlCatalog.workflows![0].code;
  const run = new Function("api", `return (async () => { ${code} })();`);
  expect(await run({ get })).toEqual([{ dataset: { dataset_id: "QTD000001" }, result: error }]);
  expect(get).toHaveBeenLastCalledWith("/datasets/QTD000001/region", expect.objectContaining({ release: "r7", ...pin }));
});
