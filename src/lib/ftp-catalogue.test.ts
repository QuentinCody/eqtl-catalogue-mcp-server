import { describe, expect, it } from "vitest";
import { buildDatasets, filterDatasets, parseTsv, summarizeStudies } from "./ftp-catalogue";

/**
 * Two rows copied verbatim from the upstream tables on 2026-08-27 — one `ge`
 * dataset publishing .all.tsv.gz, one `txrev` publishing .cc.tsv.gz.
 *   tabix/tabix_ftp_paths.tsv          -> PATHS_TSV
 *   data_tables/dataset_metadata_r7.tsv -> METADATA_TSV
 * Both from https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/master.
 */
const PATHS_TSV = [
	"study_id\tdataset_id\tstudy_label\tsample_group\ttissue_id\ttissue_label\tcondition_label\tsample_size\tquant_method\tftp_path\tftp_cs_path\tftp_lbf_path",
	"QTS000002\tQTD000021\tBLUEPRINT\tmonocyte\tCL_0002057\tmonocyte\tnaive\t191\tge\tftp://ftp.ebi.ac.uk/pub/databases/spot/eQTL/sumstats/QTS000002/QTD000021/QTD000021.all.tsv.gz\tftp://ftp.ebi.ac.uk/pub/databases/spot/eQTL/susie/QTS000002/QTD000021/QTD000021.credible_sets.tsv.gz\tftp://ftp.ebi.ac.uk/pub/databases/spot/eQTL/susie/QTS000002/QTD000021/QTD000021.lbf_variable.txt.gz",
	"QTS000015\tQTD000244\tGTEx\tesophagus_mucosa\tUBERON_0006920\tesophagus (mucosa)\tnaive\t493\ttxrev\tftp://ftp.ebi.ac.uk/pub/databases/spot/eQTL/sumstats/QTS000015/QTD000244/QTD000244.cc.tsv.gz\tftp://ftp.ebi.ac.uk/pub/databases/spot/eQTL/susie/QTS000015/QTD000244/QTD000244.credible_sets.tsv.gz\tftp://ftp.ebi.ac.uk/pub/databases/spot/eQTL/susie/QTS000015/QTD000244/QTD000244.lbf_variable.txt.gz",
].join("\n");

const METADATA_TSV = [
	"study_id\tdataset_id\tstudy_label\tsample_group\ttissue_id\ttissue_label\tcondition_label\tsample_size\tquant_method\tpmid\tstudy_type",
	"QTS000002\tQTD000021\tBLUEPRINT\tmonocyte\tCL_0002057\tmonocyte\tnaive\t191\tge\t27863251\tbulk",
	"QTS000015\tQTD000244\tGTEx\tesophagus_mucosa\tUBERON_0006920\tesophagus (mucosa)\tnaive\t493\ttxrev\t32913098\tbulk",
].join("\n");

describe("parseTsv", () => {
	it("keys each row by the header and tolerates CRLF", () => {
		const rows = parseTsv("a\tb\r\n1\t2\r\n\r\n");
		expect(rows).toEqual([{ a: "1", b: "2" }]);
	});
});

describe("buildDatasets", () => {
	const datasets = buildDatasets(parseTsv(PATHS_TSV), parseTsv(METADATA_TSV));

	it("takes the summary-statistics URL verbatim from the upstream path table", () => {
		// The gate: only ge/microarray datasets publish .all.tsv.gz, and
		// exon/tx/txrev/leafcutter publish .cc.tsv.gz. Assembling the filename
		// from a suffix guess 404s for 452 of the 758 datasets, so the URL must
		// come from ftp_path as published.
		const ge = datasets.find((d) => d.dataset_id === "QTD000021");
		const txrev = datasets.find((d) => d.dataset_id === "QTD000244");
		expect(ge?.sumstats_url).toBe(
			"https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/sumstats/QTS000002/QTD000021/QTD000021.all.tsv.gz",
		);
		expect(txrev?.quant_method).toBe("txrev");
		expect(txrev?.sumstats_url).toBe(
			"https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/sumstats/QTS000015/QTD000244/QTD000244.cc.tsv.gz",
		);
		expect(txrev?.sumstats_url.endsWith(".all.tsv.gz")).toBe(false);
	});

	it("derives the index and permuted URLs beside whichever file is published", () => {
		const txrev = datasets.find((d) => d.dataset_id === "QTD000244");
		expect(txrev?.sumstats_index_url).toBe(`${txrev?.sumstats_url}.tbi`);
		expect(txrev?.permuted_url).toBe(
			"https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/sumstats/QTS000015/QTD000244/QTD000244.permuted.tsv.gz",
		);
	});

	it("rewrites the published ftp:// URLs to https://", () => {
		for (const dataset of datasets) {
			expect(dataset.sumstats_url.startsWith("https://ftp.ebi.ac.uk/")).toBe(true);
			expect(dataset.credible_sets_url?.startsWith("https://ftp.ebi.ac.uk/")).toBe(true);
		}
	});

	it("joins pmid and study_type from the r7 metadata table", () => {
		const ge = datasets.find((d) => d.dataset_id === "QTD000021");
		expect(ge?.pmid).toBe("27863251");
		expect(ge?.study_type).toBe("bulk");
		expect(ge?.sample_size).toBe(191);
	});
});

describe("filterDatasets", () => {
	const datasets = buildDatasets(parseTsv(PATHS_TSV), parseTsv(METADATA_TSV));

	it("matches fields case-insensitively", () => {
		expect(filterDatasets(datasets, { quant_method: "GE" }).map((d) => d.dataset_id)).toEqual([
			"QTD000021",
		]);
	});

	it("searches across label, tissue, sample group, and condition", () => {
		expect(filterDatasets(datasets, { search: "esophagus" }).map((d) => d.dataset_id)).toEqual([
			"QTD000244",
		]);
		expect(filterDatasets(datasets, { search: "nothing-here" })).toEqual([]);
	});
});

describe("summarizeStudies", () => {
	it("collapses datasets into one row per study", () => {
		const studies = summarizeStudies(
			buildDatasets(parseTsv(PATHS_TSV), parseTsv(METADATA_TSV)),
		);
		expect(studies.map((s) => s.study_id)).toEqual(["QTS000002", "QTS000015"]);
		expect(studies[0]).toMatchObject({
			study_label: "BLUEPRINT",
			dataset_count: 1,
			quant_methods: ["ge"],
			sample_size_max: 191,
		});
	});
});
