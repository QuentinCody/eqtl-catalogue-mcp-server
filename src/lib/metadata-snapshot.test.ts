import { afterEach, expect, it, vi } from "vitest";
import { resourcesFetch } from "./http";
import { resetBetaCache } from "./beta-catalogue";
import { createEqtlApiFetch } from "./api-adapter";
import { sha256 } from "./release";
import { metadataSnapshot } from "./metadata-snapshot";

vi.mock("./http", async original => ({ ...await original<object>(), resourcesFetch: vi.fn() }));
afterEach(() => { resetBetaCache(); vi.resetAllMocks(); });
const raw = "\uFEFFstudy_id\tdataset_id\tstudy_label\tsample_group\ttissue_id\ttissue_label\tcondition_label\tsample_size\tquant_method\tpmid\tstudy_type\r\n" +
  "QTS000015\tQTD000116\tGTEx_v10\tadipose_subcutaneous\tUBERON_0001013\tadipose\tnaive\t711\tge\t32913098\tbulk\r\n";

it("preserves exact BOM/line endings and hashes the complete file through the discoverable route", async () => {
  vi.mocked(resourcesFetch).mockResolvedValue(new Response(raw));
  expect(await createEqtlApiFetch()({ method: "GET", path: "/discovery/metadata_snapshot", params: { release: "r8_beta" } })).toMatchObject({ status: 200,
    data: { raw_metadata_tsv: raw, metadata_sha256: await sha256(raw), total_datasets: 1, coverage_complete: true, cache_max_age_seconds: 3600 } });
  expect(resourcesFetch).toHaveBeenCalledOnce();
  await metadataSnapshot({ release: "r8_beta" }); expect(resourcesFetch).toHaveBeenCalledOnce();
});

it.each([{}, { release: "r7" }, { release: "r8_beta", size: 1 }, { release: "r8_beta", offset: 1 }])("rejects implicit/fallback or paginated selections %#", async params => {
  await expect(metadataSnapshot(params)).rejects.toThrow(); expect(resourcesFetch).not.toHaveBeenCalled();
});

it("rejects changed pins and partial source responses", async () => {
  vi.mocked(resourcesFetch).mockResolvedValueOnce(new Response(raw));
  await expect(metadataSnapshot({ release: "r8_beta", metadata_sha256: "0".repeat(64) })).rejects.toThrow("snapshot changed");
  resetBetaCache(); vi.mocked(resourcesFetch).mockResolvedValueOnce(new Response(raw, { status: 206 }));
  await expect(metadataSnapshot({ release: "r8_beta" })).rejects.toThrow("partial");
});
