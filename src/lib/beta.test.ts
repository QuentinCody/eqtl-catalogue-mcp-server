import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEqtlApiFetch } from "./api-adapter";
import { directoryFiles, parseBetaMetadata, resetBetaCache } from "./beta-catalogue";
import { parquetRequest } from "./parquet";
import { boundedText, sha256 } from "./release";

const mocks = vi.hoisted(() => ({ resourcesFetch: vi.fn(), ebiFileFetch: vi.fn() }));
vi.mock("./http", async importOriginal => ({ ...await importOriginal<object>(), ...mocks }));
const header = "study_id\tdataset_id\tstudy_label\tsample_group\ttissue_id\ttissue_label\tcondition_label\tsample_size\tquant_method\tpmid\tstudy_type\textra\n";
// Synthetic test rows model the officially documented reused GTEx ID.
const table = `${header}QTS000015\tQTD000244\tGTEx_v10\tesophagus_mucosa\tUBERON_0001043\tesophagus\tnaive\t614\ttxrev\t32913098\tbulk\tretained\n`;
const hashes = { metadata_sha256: "a".repeat(64), file_sha256: "b".repeat(64) };
const region = { kind: "region", datasetId: "QTD000244" } as const;

beforeEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.resourcesFetch.mockReset(); mocks.ebiFileFetch.mockReset(); resetBetaCache();
  mocks.resourcesFetch.mockImplementation(async () => new Response(table));
});

describe("r8 metadata and asset discovery", () => {
  it("keeps reused IDs in their own release and retains new columns", async () => {
    const api = createEqtlApiFetch();
    const result = await api({ method: "GET", path: "/datasets/QTD000244", params: { release: "r8_beta" } });
    expect(result.data).toMatchObject({ release: "r8_beta", study_label: "GTEx_v10", sample_size: 614, metadata: { extra: "retained" }, metadata_sha256: await sha256(table) });
    expect(result.data).not.toHaveProperty("sumstats_url");
    expect(mocks.resourcesFetch).toHaveBeenCalledExactlyOnceWith("/data_tables/dataset_metadata_r8_beta.tsv", { cacheTtlSeconds: 3600 });
  });

  it("parses embedded release query parameters instead of silently using r7", async () => {
    const result = await createEqtlApiFetch()({ method: "GET", path: "/datasets/QTD000244?release=r8_beta" });
    expect(result.data).toMatchObject({ release: "r8_beta", sample_size: 614 });
  });

  it("reports release status without fetching bulk files", async () => {
    const result = await createEqtlApiFetch()({ method: "GET", path: "/releases" });
    expect(result.data).toMatchObject({ default_release: "r7", releases: expect.arrayContaining([expect.objectContaining({ release: "r8_beta", status: "pre-release" })]) });
    expect(mocks.resourcesFetch).not.toHaveBeenCalled();
  });

  it("checks requested metadata checksums and retries after upstream failure", async () => {
    const api = createEqtlApiFetch();
    mocks.resourcesFetch.mockRejectedValueOnce(new Error("unavailable"));
    await expect(api({ method: "GET", path: "/datasets", params: { release: "r8_beta" } })).rejects.toThrow("unavailable");
    await expect(api({ method: "GET", path: "/datasets", params: { release: "r8_beta", metadata_sha256: "0".repeat(64) } })).rejects.toMatchObject({ status: 409 });
    const result = await api({ method: "GET", path: "/datasets", params: { release: "r8_beta", metadata_sha256: await sha256(table), study_label: "GTEx_v10" } });
    expect(result.data).toMatchObject({ matched_datasets: 1, datasets: [expect.objectContaining({ sample_size: 614 })] });
  });

  it("rejects malformed or duplicate metadata instead of manufacturing records", () => {
    for (const source of [header, table + table.split("\n")[1], table.replace("614", "614.5"), table.replace("QTD000244", "../../etc"), table.replace("extra\n", "dataset_id\n"), table.replace("\tretained", "")]) {
      expect(() => parseBetaMetadata(source)).toThrow();
    }
  });

  it("preserves empty trailing fields in metadata", () => {
    expect(parseBetaMetadata(table.replace("retained\n", ""))[0].metadata.extra).toBe("");
  });

  it("lists exact same-directory links and never guesses or follows external assets", () => {
    const directory = "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/sumstats/QTS000015/QTD000244/";
    const files = directoryFiles('<a href="QTD000244.all.parquet">a</a><a href="QTD000244.cc.parquet">b</a><a href="QTD000244.future.parquet">c</a><a href="../QTD000244.all.parquet">parent</a><a href="https://evil.test/QTD000244.all.parquet">evil</a><a href="QTD000244.all.parquet?redirect=1">query</a><a href="QTD000244.all.parquet">duplicate</a>', directory);
    expect(files.map(f => f.role)).toEqual(["all", "cc", "unclassified"]);
    expect(files.every(f => f.url.startsWith(directory))).toBe(true);
  });

  it("distinguishes an unpublished directory from a failed upstream", async () => {
    mocks.ebiFileFetch.mockResolvedValueOnce(new Response('<a href="QTD000244.all.parquet">all</a>')).mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));
    const request = { method: "GET", path: "/datasets/QTD000244/files", params: { release: "r8_beta" } };
    const result = await createEqtlApiFetch()(request);
    expect(result.data).toMatchObject({ listings: [{ status: "available", files: [{ role: "all" }] }, { status: "not_published", files: [] }] });
    mocks.ebiFileFetch.mockRejectedValueOnce(Object.assign(new Error("rate limit"), { status: 429 }));
    await expect(createEqtlApiFetch()(request)).rejects.toMatchObject({ status: 429 });
  });

  it.each([
    { release: "r8" }, { release: "R7" }, { release: null }, { release: "r8_beta", offset: 0.5 },
    { release: "r8_beta", size: true }, { release: "r8_beta", search: {} },
    { release: "r8_beta", ignored_filter: "should-fail" },
  ])("rejects unsupported release or malformed metadata parameters: %j", async params => {
    await expect(createEqtlApiFetch()({ method: "GET", path: "/datasets", params })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects GET bodies and duplicate release parameters", async () => {
    await expect(createEqtlApiFetch()({ method: "GET", path: "/releases", body: {} })).rejects.toMatchObject({ status: 400 });
    await expect(createEqtlApiFetch()({ method: "GET", path: "/datasets?release=r8_beta", params: { release: "r7" } })).rejects.toMatchObject({ status: 400 });
  });
});

it("bounds UTF-8 response bytes and fails a stalled stream instead of accepting partial text", async () => {
  await expect(boundedText(new Response("éé"), 3)).rejects.toMatchObject({ status: 502 });
  vi.useFakeTimers();
  try {
    const promise = boundedText(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } })));
    const check = expect(promise).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(25_001);
    await check;
  } finally { vi.useRealTimers(); }
});

describe("bounded Parquet proxy", () => {
  const env = { EQTL_PARQUET_URL: "https://query.example/query", EQTL_PARQUET_TOKEN: "fixture-service-secret-1234567890" };
  const params = { release: "r8_beta", ...hashes, file_role: "all", chromosome: "chr1", start: 100, end: 200 };
  const result = { release: "r8_beta", dataset_id: "QTD000244", file_role: "all", ...hashes, assembly: "GRCh38", status: "pre-release",
    metadata: { dataset_id: "QTD000244", study_id: "QTS000015" },
    source_url: "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/sumstats/QTS000015/QTD000244/QTD000244.all.parquet",
    schema: [{ name: "position", type: "int64", nullable: true }, { name: "chromosome", type: "string", nullable: true }], rows: [{ position: 100, chromosome: "chr1" }], row_count: 1, truncated: false,
    truncation_reason: null, total_matching_rows: null, filters: parquetRequest(region, params).filters };

  it("requires an explicit file role and both hashes", () => {
    for (const candidate of [{}, { ...params, file_role: undefined }, { ...params, file_sha256: undefined }, { ...params, metadata_sha256: "not-a-hash" }, { ...params, start: 1.2 }, { ...params, max_rows: 5001 }, { ...params, unused_filter: "x" }]) expect(() => parquetRequest(region, candidate)).toThrow();
  });

  it("fails clearly without a service, never falling back to r7", async () => {
    await expect(createEqtlApiFetch()({ method: "GET", path: "/datasets/QTD000244/region", params })).rejects.toMatchObject({ status: 503 });
    expect(mocks.resourcesFetch).not.toHaveBeenCalled();
    expect(mocks.ebiFileFetch).not.toHaveBeenCalled();
  });

  it("queries retained checksums without requiring the current mutable metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetch);
    expect((await createEqtlApiFetch(env)({ method: "GET", path: "/datasets/QTD000244/region", params })).data).toEqual(result);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(env.EQTL_PARQUET_URL);
    expect(init).toMatchObject({ redirect: "manual", headers: { Authorization: `Bearer ${env.EQTL_PARQUET_TOKEN}` } });
    expect(JSON.parse(init.body)).toMatchObject({ ...hashes, filters: [{ column: "chromosome", op: "eq", value: "chr1" }, { column: "position", op: "ge", value: 100 }, { column: "position", op: "le", value: 200 }] });
    expect(mocks.resourcesFetch).not.toHaveBeenCalled();
  });

  it.each([{ ...result, release: "r7" }, { ...result, file_sha256: "c".repeat(64) }, { ...result, row_count: 0 }, { ...result, rows: Array(501).fill({}), row_count: 501 }, { ...result, source_url: "https://evil.test/file" }])("rejects mismatched provenance or unbounded response", async data => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    await expect(createEqtlApiFetch(env)({ method: "GET", path: "/datasets/QTD000244/region", params })).rejects.toMatchObject({ status: 502 });
  });

  it("does not expose backend error bodies or tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(env.EQTL_PARQUET_TOKEN, { status: 409 })));
    await expect(createEqtlApiFetch(env)({ method: "GET", path: "/datasets/QTD000244/region", params })).rejects.toThrow("HTTP 409");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...result, token: env.EQTL_PARQUET_TOKEN })));
    await expect(createEqtlApiFetch(env)({ method: "GET", path: "/datasets/QTD000244/region", params })).rejects.toThrow("credential material");
  });
});
