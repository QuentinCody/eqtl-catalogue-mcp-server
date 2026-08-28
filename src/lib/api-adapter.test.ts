import { describe, expect, it } from "vitest";
import { parseEqtlPath } from "./api-adapter";

describe("parseEqtlPath", () => {
	it("routes the metadata paths", () => {
		expect(parseEqtlPath("/studies")).toEqual({ kind: "studies" });
		expect(parseEqtlPath("/studies/QTS000002")).toEqual({
			kind: "study",
			studyId: "QTS000002",
		});
		expect(parseEqtlPath("/datasets")).toEqual({ kind: "datasets" });
		expect(parseEqtlPath("/datasets/QTD000021")).toEqual({
			kind: "dataset",
			datasetId: "QTD000021",
		});
	});

	it("routes the three data paths", () => {
		expect(parseEqtlPath("/datasets/QTD000021/region")).toEqual({
			kind: "region",
			datasetId: "QTD000021",
		});
		expect(parseEqtlPath("/datasets/QTD000021/top_associations")).toEqual({
			kind: "top-associations",
			datasetId: "QTD000021",
		});
		expect(parseEqtlPath("/datasets/QTD000021/credible_sets")).toEqual({
			kind: "credible-sets",
			datasetId: "QTD000021",
		});
	});

	it("normalizes identifier case and a trailing query string", () => {
		expect(parseEqtlPath("datasets/qtd000021/region?chromosome=20")).toEqual({
			kind: "region",
			datasetId: "QTD000021",
		});
	});

	it("refuses the retired REST routes instead of guessing an equivalent", () => {
		// /associations was the old API's cross-study search. The flat files are
		// indexed by coordinate only, so there is nothing to map it onto and the
		// caller must be told, not silently handed an empty result.
		expect(parseEqtlPath("/associations")).toBeUndefined();
		expect(parseEqtlPath("/studies/QTS000002/associations")).toBeUndefined();
		expect(parseEqtlPath("/datasets/QTD000021/associations")).toBeUndefined();
		expect(parseEqtlPath("/tissues")).toBeUndefined();
	});
});
