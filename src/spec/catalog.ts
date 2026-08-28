import type { ApiCatalog, ApiEndpoint } from "@bio-mcp/shared/codemode/catalog";

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
		summary: "List the 42 studies in the released catalogue (r7).",
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
		summary: "List and filter the 758 datasets, with the FTP file URLs for each.",
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
		summary: "One dataset record, including its resolved file URLs.",
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
			"Nominal cis associations in a GRCh38 window, read through the dataset's tabix index.",
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
		],
		responseShape:
			"{ dataset, columns[], rows: [{ molecular_trait_id, chromosome, position, ref, alt, variant, ma_samples, maf, pvalue, beta, se, type, ac, an, r2, molecular_trait_object_id, gene_id, median_tpm, rsid }], row_count, truncated, byte_range, source_file, index_file }",
		example:
			'const hits = await api.get("/datasets/QTD000021/region", { chromosome: "20", start: 46120612, end: 46120613 });',
		usageHint:
			"Coordinate-indexed only. To answer a gene or rsID question, resolve it to GRCh38 coordinates first (ensembl_execute, gnomad, or gwas-catalog), then pass a window and narrow with gene_id/rsid.",
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
			'There is NO chromosome or position column here — the set\'s locus is the "region" column (chrN:start-end). Passing chromosome or position is rejected with a 400 rather than answered with an empty result; slice coordinates with /region instead.',
	},
];

export const eqtlCatalog: ApiCatalog = {
	name: "EBI eQTL Catalogue (FTP flat files + tabix)",
	baseUrl: "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL",
	version: "r7",
	auth: "none",
	endpointCount: endpoints.length,
	notes:
		"- SUBSTRATE: the eQTL Catalogue REST API is RETIRED — https://www.ebi.ac.uk/eqtl/api/v3/* returns HTTP 410. This server reads the static bgzip/tabix files on https://ftp.ebi.ac.uk/pub/databases/spot/eQTL and the metadata tables in the eQTL-Catalogue-resources repository. Do not try to call the old /associations route; it does not exist here.\n" +
		"- COORDINATES ONLY: the association files are tabix-indexed by GRCh38 position. There is no gene-keyed or rsID-keyed lookup across studies. Resolve a symbol or rsID to coordinates first (ensembl_execute /lookup or /variation, gnomad, gwas-catalog), then call /datasets/{id}/region and narrow with gene_id or rsid.\n" +
		"- FILES DIFFER PER DATASET: quant_method ge, microarray and aptamer publish .all.tsv.gz (306 datasets); exon, tx, txrev and leafcutter publish .cc.tsv.gz (452 datasets). Both carry the same 19 columns and a .tbi. The URLs come from the upstream path table, so read sumstats_url / permuted_url / credible_sets_url off the dataset record rather than assembling a filename.\n" +
		"- RELEASE r7: 758 datasets across 42 studies. The r8 metadata table describes datasets that are not on the FTP tree yet, so this server tracks r7.\n" +
		"- RATE LIMIT: EBI blacklists IPs that issue frequent tabix-style requests. Every upstream read here is serialized at ~1.5 s apart and indexes are cached. Keep fan-out to a handful of datasets per program, and prefer /top_associations over /region when you only need lead variants.\n" +
		"- COST: /region is 1 range GET once the ~2 MB index and the header line are cached (3 requests cold). /top_associations is 1 whole-file GET of 0.5-2 MB. /credible_sets streams ~10 MB.\n" +
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
const { datasets } = await api.get("/datasets", { study_label: "BLUEPRINT", quant_method: "ge" });
const out = [];
for (const d of datasets.slice(0, 3)) {
  const slice = await api.get(\`/datasets/\${d.dataset_id}/region\`, {
    chromosome: "20", start: 46120612, end: 46120613, max_rows: 100,
  });
  for (const row of slice.rows) {
    if (row.pvalue !== null && row.pvalue < 1e-4) {
      out.push({ dataset: d.dataset_id, tissue: d.tissue_label, ...row });
    }
  }
}
return out;`,
		},
		{
			title: "Which traits have a cis-QTL in one dataset",
			description:
				"Read the permuted top-hit file and keep traits below an empirical p-value.",
			keywords: ["top hits", "permuted", "p_beta", "cis-QTL"],
			code: `const top = await api.get("/datasets/QTD000021/top_associations", {
  p_beta_max: 1e-6, max_rows: 500,
});
return { columns: top.columns, truncated: top.truncated, rows: top.rows };`,
		},
	],
};
