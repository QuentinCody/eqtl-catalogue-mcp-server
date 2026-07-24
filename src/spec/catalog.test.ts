import { describe, expect, it } from "vitest";
import { eqtlCatalog } from "./catalog";

describe("eqtlCatalog", () => {
	it("models only the live eQTL Catalogue v3 surface", () => {
		expect(eqtlCatalog.baseUrl).toBe("https://www.ebi.ac.uk/eqtl/api/v3");
		expect(eqtlCatalog.version).toBe("v3");
		expect(eqtlCatalog.endpoints).toHaveLength(7);

		const paths = eqtlCatalog.endpoints.map(({ path }) => path);
		expect(paths).toContain("/studies");
		expect(paths).toContain("/datasets/{dataset_id}/associations");
		expect(paths).toContain("/associations");
		expect(paths.some((path) => path.startsWith("/genes"))).toBe(false);
		expect(paths.some((path) => path.startsWith("/tissues"))).toBe(false);
	});

	it("advertises only API v3 association filters", () => {
		const endpoint = eqtlCatalog.endpoints.find(({ path }) => path === "/associations");
		const names = endpoint?.queryParams?.map(({ name }) => name);
		expect(names).toEqual([
			"gene_id",
			"rsid",
			"variant",
			"molecular_trait_id",
			"chromosome",
			"start",
			"size",
		]);
		expect(names).not.toContain("snp");
		expect(names).not.toContain("quant_method");
	});
});
