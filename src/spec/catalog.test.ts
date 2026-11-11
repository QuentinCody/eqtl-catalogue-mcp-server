import { describe, expect, it } from "vitest";
import { eqtlCatalog } from "./catalog";

describe("eqtlCatalog", () => {
	it("points at the FTP file tree, not the retired REST API", () => {
		// https://www.ebi.ac.uk/eqtl/api/v3/* answers HTTP 410.
		expect(eqtlCatalog.baseUrl).toBe("https://ftp.ebi.ac.uk/pub/databases/spot/eQTL");
		expect(eqtlCatalog.version).toBe("r7 + r8_beta");
		// The notes name the dead API on purpose; no endpoint may target it.
		expect(JSON.stringify(eqtlCatalog.endpoints)).not.toContain("ebi.ac.uk/eqtl/api");
	});

	it("models the file-backed surface and drops the routes that no longer exist", () => {
		const paths = eqtlCatalog.endpoints.map(({ path }) => path);
		expect(paths).toEqual([
			"/studies",
			"/studies/{study_id}",
			"/datasets",
			"/datasets/{dataset_id}",
			"/datasets/{dataset_id}/region",
			"/datasets/{dataset_id}/top_associations",
			"/datasets/{dataset_id}/credible_sets",
   "/discovery/metadata_snapshot",
   "/releases",
			"/datasets/{dataset_id}/files",
			"/datasets/{dataset_id}/parquet_schema",
		]);
		expect(eqtlCatalog.endpointCount).toBe(paths.length);
		expect(paths).not.toContain("/associations");
	});

	it("requires coordinates on the region route and says why", () => {
		const region = eqtlCatalog.endpoints.find(({ path }) => path.endsWith("/region"));
		const required = region?.queryParams?.filter((p) => p.required).map((p) => p.name);
		expect(required).toEqual(["chromosome", "start", "end"]);
		expect(region?.usageHint).toMatch(/coordinate/i);
	});

	it("warns about the retired API, the coordinate index, and EBI's rate limit", () => {
		const notes = eqtlCatalog.notes ?? "";
		expect(notes).toMatch(/410/);
		expect(notes).toMatch(/COORDINATES ONLY/);
		expect(notes).toMatch(/\.cc\.tsv\.gz/);
		expect(notes).toMatch(/blacklist/i);
	});
});
