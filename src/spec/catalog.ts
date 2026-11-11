import type { ApiCatalog, ApiEndpoint } from "@bio-mcp/shared/codemode/catalog";
import { parquetParams, releaseEndpoints, releaseParams } from "./releases";

/**
 * The eQTL Catalogue's REST API was retired — every route under
 * https://www.ebi.ac.uk/eqtl/api/ answers 410 "This API is no longer
 * available". EBI now publishes the catalogue as static bgzip/tabix flat files
 * on its FTP tree plus metadata tables in the eQTL-Catalogue-resources
 * repository. The paths below are this server's surface over those files, and
 * they intentionally do not mirror the retired API: the association files are
 * indexed by genomic coordinate only, so there is no cross-study
 * "associations?gene_id=..." route to reproduce.
 */

const datasetFilters: NonNullable<ApiEndpoint["queryParams"]> = [
	{ name: "study_id", type: "string", required: false, description: "QTS study identifier." },
	{
		name: "study_label",
		type: "string",
		required: false,
		description: "Study label, e.g. BLUEPRINT, GTEx, Alasoo_2018.",
	},
	{
		name: "quant_method",
		type: "string",
		required: false,
		description: "Quantification method: ge, exon, tx, txrev, leafcutter, microarray, aptamer.",
	},
	{
		name: "tissue_label",
		type: "string",
		required: false,
		description: "Tissue or cell-type label, e.g. monocyte, brain.",
	},
	{ name: "tissue_id", type: "string", required: false, description: "UBERON/CL ontology id." },
	{
		name: "condition_label",
		type: "string",
		required: false,
		description: "Treatment condition, e.g. naive, LPS_24h, IFNg.",
	},
	{
		name: "sample_group",
		type: "string",
		required: false,
		description: "Sample group as published by the study.",
	},
	{
		name: "study_type",
		type: "string",
		required: false,
		description: "bulk or single-cell.",
	},
	{
		name: "search",
		type: "string",
		required: false,
		description: "Free-text match over study label, tissue, sample group, and condition.",
	},
	{ name: "offset", type: "number", required: false, description: "Pagination offset." },
	{
		name: "size",
		type: "number",
		required: false,
		description: "Rows to return (default 50, max 1000).",
	},
];

const rowFilters: NonNullable<ApiEndpoint["queryParams"]> = [
	{
		name: "gene_id",
		type: "string",
		required: false,
		description: "Ensembl gene id filter applied to the rows in the window.",
	},
	{
		name: "molecular_trait_id",
		type: "string",
		required: false,
		description: "Molecular trait id (gene, exon, transcript, or txrevise event).",
	},
	{ name: "rsid", type: "string", required: false, description: "dbSNP v151 rsid filter." },
	{
		name: "variant",
		type: "string",
		required: false,
		description: "Variant id in chrN_pos_ref_alt form, e.g. chr20_46120612_T_C.",
	},
	{
		name: "max_rows",
		type: "number",
		required: false,
		description: "Row cap (default 500, max 20000). Truncation is reported.",
	},
];

const endpoints: ApiEndpoint[] = [
	{
		method: "GET",
		path: "/studies",
		summary: "List studies in the selected release (r7 by default).",
		category: "metadata",
		queryParams: [
			{
				name: "search",
				type: "string",
				required: false,
				description: "Match on study label.",
			},
		],
		responseShape:
			"{ release, study_count, studies: [{ study_id, study_label, study_type, pmid, dataset_count, quant_methods[], tissue_labels[], sample_size_max }] }",
		example: 'const { studies } = await api.get("/studies", { search: "BLUEPRINT" });',
		featured: true,
	},
	{
		method: "GET",
		path: "/studies/{study_id}",
		summary: "One study plus every dataset it publishes.",
		category: "metadata",
		pathParams: [
			{
				name: "study_id",
				type: "string",
				required: true,
				description: "QTS identifier, e.g. QTS000002.",
			},
		],
		example: 'const study = await api.get("/studies/QTS000002");',
	},
	{
		method: "GET",
		path: "/datasets",
		summary: "List datasets in one release; r7 includes file URLs, r8 includes raw metadata and snapshot provenance.",
		category: "metadata",
		queryParams: datasetFilters,
		responseShape:
			"{ release, total_datasets, matched_datasets, offset, datasets: [{ study_id, dataset_id, study_label, sample_group, tissue_id, tissue_label, condition_label, sample_size, quant_method, study_type, pmid, sumstats_url, sumstats_index_url, permuted_url, credible_sets_url, lbf_url }] }",
		example:
			'const { datasets } = await api.get("/datasets", { study_label: "BLUEPRINT", quant_method: "ge" });',
		usageHint:
			"Start here. Every other route needs a QTD dataset id, and this is what tells you which files that dataset actually publishes.",
		featured: true,
	},
	{
		method: "GET",
		path: "/datasets/{dataset_id}",
		summary: "One release-specific dataset record. For r8 Parquet links call /files.",
		category: "metadata",
		pathParams: [
			{
				name: "dataset_id",
				type: "string",
				required: true,
				description: "QTD identifier, e.g. QTD000021.",
			},
		],
		example: 'const dataset = await api.get("/datasets/QTD000021");',
	},
	{
		method: "GET",
		path: "/datasets/{dataset_id}/region",
		summary:
			"Nominal cis associations in a GRCh38 window: r7 tabix or checksum-pinned r8 Parquet.",
		category: "associations",
		pathParams: [
			{
				name: "dataset_id",
				type: "string",
				required: true,
				description: "QTD identifier.",
			},
		],
		queryParams: [
			{
				name: "chromosome",
				type: "string",
				required: true,
				description: 'GRCh38 chromosome, e.g. "20" (a "chr" prefix is accepted).',
			},
			{
				name: "start",
				type: "number",
				required: true,
				description: "Window start, 1-based inclusive.",
			},
			{
				name: "end",
				type: "number",
				required: true,
				description: "Window end, 1-based inclusive. Span limit 5,000,000 bp.",
			},
			...rowFilters,
			...(["index_sha256", "header_sha256", "range_sha256"] as const).map(name => ({
				name, type: "string" as const, required: false,
				description: "r7 /region only: optional lowercase SHA-256 from file_evidence for the same query; reject changed response bytes.",
			})),
		],
		responseShape:
			"{ dataset, columns[], rows: [{ molecular_trait_id, chromosome, position, ref, alt, variant, ma_samples, maf, pvalue, beta, se, type, ac, an, r2, molecular_trait_object_id, gene_id, median_tpm, rsid }], row_count, truncated, byte_range, source_file, index_file }",
		example:
			'const hits = await api.get("/datasets/QTD000021/region", { chromosome: "20", start: 46120612, end: 46120613 });',
		usageHint:
			"Coordinate-indexed only. To answer a gene or rsID question, resolve it to GRCh38 coordinates first (ensembl_execute, gnomad, or gwas-catalog), then pass a window and narrow with gene_id/rsid. r7 returns native_header and aligned raw_rows preserving numeric text (CRLF normalized), plus file_evidence hashes of the complete compressed index/header-range/region-range HTTP bodies. Header evidence covers the first up-to-64 KiB response, not just the header line. coverage_complete is false: independently fetched files and row limits do not establish exhaustive absence. Region compressed reads are capped at 16 MiB, inflated data at 64 MiB; narrow the window if exceeded.",
		featured: true,
	},
	{
		method: "GET",
		path: "/datasets/{dataset_id}/top_associations",
		summary:
			"Permutation top hits: the lead variant per molecular trait, with empirical p-values.",
		category: "associations",
		pathParams: [
			{
				name: "dataset_id",
				type: "string",
				required: true,
				description: "QTD identifier.",
			},
		],
		queryParams: [
			{
				name: "p_beta_max",
				type: "number",
				required: false,
				description:
					"Keep rows with p_beta at or below this value (the column to filter on).",
			},
			{
				name: "molecular_trait_id",
				type: "string",
				required: false,
				description: "Molecular trait id filter.",
			},
			{
				name: "chromosome",
				type: "string",
				required: false,
				description: "Chromosome filter.",
			},
			{
				name: "max_rows",
				type: "number",
				required: false,
				description: "Row cap (default 500, max 20000).",
			},
		],
		responseShape:
			"{ dataset, columns[], rows: [{ molecular_trait_object_id, molecular_trait_id, n_traits, n_variants, variant, chromosome, position, pvalue, beta, p_perm, p_beta }], row_count, truncated }",
		example:
			'const top = await api.get("/datasets/QTD000021/top_associations", { p_beta_max: 1e-5, max_rows: 200 });',
		usageHint:
			"The cheapest real read in this server — the permuted files are 0.5-2 MB and need no index. Use it to find which traits have a cis-QTL at all before slicing regions.",
		featured: true,
	},
	{
		method: "GET",
		path: "/datasets/{dataset_id}/credible_sets",
		summary: "SuSiE fine-mapped credible sets with posterior inclusion probabilities.",
		category: "fine-mapping",
		pathParams: [
			{
				name: "dataset_id",
				type: "string",
				required: true,
				description: "QTD identifier.",
			},
		],
		queryParams: [
			{
				name: "min_pip",
				type: "number",
				required: false,
				description: "Keep variants with pip at or above this value.",
			},
			{
				name: "molecular_trait_id",
				type: "string",
				required: false,
				description: "Molecular trait id filter.",
			},
			{
				name: "gene_id",
				type: "string",
				required: false,
				description: "Ensembl gene id filter.",
			},
			{ name: "variant", type: "string", required: false, description: "Variant id filter." },
			{ name: "rsid", type: "string", required: false, description: "dbSNP rsid filter." },
			{
				name: "max_rows",
				type: "number",
				required: false,
				description: "Row cap (default 500, max 20000).",
			},
		],
		responseShape:
			"{ dataset, columns[], rows: [{ molecular_trait_id, gene_id, cs_id, variant, rsid, cs_size, pip, pvalue, beta, se, z, cs_min_r2, region }], row_count, truncated }",
		example:
			'const cs = await api.get("/datasets/QTD000021/credible_sets", { min_pip: 0.5, max_rows: 100 });',
		usageHint:
			"These files are ~10 MB and carry no index, so the whole file is streamed and filtered. Always pass min_pip or a trait filter, and expect a slower call than /region. " +
			'For r7 there is NO chromosome or position column — the set\'s locus is "region" (chrN:start-end); coordinate filters are rejected. For r8 inspect parquet_schema: filters are checked against the actual imported file.',
	},
];

for (const endpoint of endpoints) {
	endpoint.queryParams = [...releaseParams, ...(endpoint.queryParams ?? [])];
	if (endpoint.category === "associations" || endpoint.category === "fine-mapping") {
		endpoint.queryParams.push(...parquetParams);
		endpoint.usageHint = `${endpoint.usageHint ?? ""} r8_beta uses a configured Parquet service with max_rows <= 5000, a 30-second query deadline and a 2 MiB response budget; it preserves duplicate rows. Pin both checksums. Return staging/error handles intact.`;
	}
}
endpoints.push(...releaseEndpoints);

export const eqtlCatalog: ApiCatalog = {
	name: "EBI eQTL Catalogue (r7 tabix + r8 beta Parquet)",
	baseUrl: "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL",
	version: "r7 + r8_beta",
	auth: "none",
	endpointCount: endpoints.length,
	notes:
		"- SUBSTRATE: the eQTL Catalogue REST API is RETIRED — https://www.ebi.ac.uk/eqtl/api/v3/* returns HTTP 410. This server reads the static bgzip/tabix files on https://ftp.ebi.ac.uk/pub/databases/spot/eQTL and the metadata tables in the eQTL-Catalogue-resources repository. Do not try to call the old /associations route; it does not exist here.\n" +
		"- COORDINATES ONLY: the association files are tabix-indexed by GRCh38 position. There is no gene-keyed or rsID-keyed lookup across studies. Resolve a symbol or rsID to coordinates first (ensembl_execute /lookup or /variation, gnomad, gwas-catalog), then call /datasets/{id}/region and narrow with gene_id or rsid.\n" +
		"- FILES DIFFER PER DATASET: quant_method ge, microarray and aptamer publish .all.tsv.gz (306 datasets); exon, tx, txrev and leafcutter publish .cc.tsv.gz (452 datasets). Both carry the same 19 columns and a .tbi. The URLs come from the upstream path table, so read sumstats_url / permuted_url / credible_sets_url off the dataset record rather than assembling a filename.\n" +
		"- RELEASE: r7 is the default TSV path. Pass catalogue_snapshot.metadata_sha256 and paths_sha256 back on r7 reads to reject metadata/file-map drift before association access; these are not association-file hashes. Opt in with release r8_beta for the mutable Parquet pre-release (GTEx v10 and other new analyses). Final r8 is scheduled for December 2026. Dataset IDs are reused across releases: NEVER join solely on ID. Inspect /releases and /datasets/{id}/files. r8 queries require a configured query service plus metadata_sha256 and file_sha256 from its import manifest. Schema/filters come from actual Parquet files; no r7 column assumptions. ALT is the effect allele; retain multi-rsid/duplicate rows.\n" +
		"- RATE LIMIT: EBI blacklists IPs that issue frequent tabix-style requests. FTP reads use a shared policy at 2 s apart and indexes are cached. Keep fan-out to a handful of datasets per program, and prefer /top_associations over /region when you only need lead variants.\n" +
		"- COST: /region is 1 range GET once the ~2 MB index and the header line are cached (3 requests cold). Whole-file TSV reads are bounded to 16 MiB compressed / 64 MiB inflated, preserve native_header and aligned raw_rows, and report file_evidence for the complete compressed bytes. A hash does not establish complete parsed rows; inspect truncated.\n" +
		"- FILTERS ARE CHECKED AGAINST THE FILE HEADER: a filter naming a column the file does not carry is answered with a 400 that lists the real columns. An empty result from this server therefore means the data is empty, not that the filter was misspelled.\n" +
		"- Large results are staged automatically; query them with eqtl_query_data.",
	endpoints,
	workflows: [
		{
			title: "eQTL evidence for a variant across immune cell types",
			description:
				"Slice the same GRCh38 position out of several non-GTEx datasets and keep the significant hits.",
			keywords: ["variant", "colocalisation", "immune", "region", "rsid"],
			code: `// Coordinates must be resolved upstream — these files have no rsID index.
const catalogue = await api.get("/datasets", { release: "r7", study_label: "BLUEPRINT", quant_method: "ge" });
if (!Array.isArray(catalogue.datasets) || !catalogue.catalogue_snapshot) return catalogue;
const { metadata_sha256, paths_sha256 } = catalogue.catalogue_snapshot;
const out = [];
for (const d of catalogue.datasets.slice(0, 3)) {
  const slice = await api.get(\`/datasets/\${d.dataset_id}/region\`, {
    release: "r7", metadata_sha256, paths_sha256,
    chromosome: "20", start: 46120612, end: 46120613, max_rows: 100,
  });
  if (!Array.isArray(slice.rows)) { out.push({ dataset: d, result: slice }); continue; }
  const selected = slice.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.pvalue !== null && row.pvalue < 1e-4);
  const rows = selected.map(({ row }) => row);
  const raw_rows = selected.map(({ index }) => slice.raw_rows[index]);
  out.push({ ...slice, rows, raw_rows, row_count: rows.length, source_row_count: slice.row_count, selection: "pvalue < 1e-4 within returned slice" });
}
return out;`,
		},
		{
			title: "Which traits have a cis-QTL in one dataset",
			description:
				"Read the permuted top-hit file and keep traits below an empirical p-value.",
			keywords: ["top hits", "permuted", "p_beta", "cis-QTL"],
			code: `const dataset = await api.get("/datasets/QTD000021", { release: "r7" });
if (!dataset.catalogue_snapshot) return dataset;
const { metadata_sha256, paths_sha256 } = dataset.catalogue_snapshot;
const top = await api.get("/datasets/QTD000021/top_associations", {
  release: "r7", metadata_sha256, paths_sha256, p_beta_max: 1e-6, max_rows: 500,
});
return top;`,
		},
	],
};
