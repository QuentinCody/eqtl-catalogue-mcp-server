import { describe, expect, it } from "vitest";
import { normalizeEqtlParams } from "./api-adapter";

describe("normalizeEqtlParams", () => {
	it("maps a legacy rsID to the API v3 rsid parameter", () => {
		expect(
			normalizeEqtlParams("/associations", {
				variant_id: "rs7903146",
				size: 5,
				quant_method: "ge",
			}),
		).toEqual({ rsid: "rs7903146", size: 5 });
	});

	it("maps a chr_pos_ref_alt identifier to the API v3 variant parameter", () => {
		expect(
			normalizeEqtlParams("/datasets/QTD000021/associations", {
				snp: "10_114758349_C_T",
				start: 20,
			}),
		).toEqual({ variant: "10_114758349_C_T", start: 20 });
	});

	it("preserves explicit API v3 filters and removes legacy-only filters", () => {
		expect(
			normalizeEqtlParams("/studies/QTS000002/associations", {
				rsid: "rs7903146",
				gene_id: "ENSG00000148737",
				chromosome: "10",
				tissue: "UBERON_0000178",
				page: 2,
			}),
		).toEqual({
			rsid: "rs7903146",
			gene_id: "ENSG00000148737",
			chromosome: "10",
		});
	});

	it("does not rewrite metadata requests", () => {
		const params = { size: 1 };
		expect(normalizeEqtlParams("/studies", params)).toBe(params);
	});
});
