import type { ApiCatalog, ApiEndpoint } from "@bio-mcp/shared/codemode/catalog";

/**
 * The `responseRequiresRetry` metadata flag is a free-form hint for the LLM;
 * the eQTL Catalogue API is upstream-fragile (intermittent 400/500/timeout).
 * It is NOT consumed by the Code Mode retry machinery.
 */
type EqtlEndpoint = ApiEndpoint & { responseRequiresRetry?: boolean };

const associationParams: NonNullable<ApiEndpoint["queryParams"]> = [
	{ name: "gene_id", type: "string", required: false, description: "Ensembl gene identifier." },
	{
		name: "rsid",
		type: "string",
		required: false,
		description: "dbSNP rs identifier (for example rs7903146).",
	},
	{
		name: "variant",
		type: "string",
		required: false,
		description: "Variant in chr_pos_ref_alt format.",
	},
	{
		name: "molecular_trait_id",
		type: "string",
		required: false,
		description: "Molecular trait identifier.",
	},
	{ name: "chromosome", type: "string", required: false, description: "Chromosome filter." },
	{
		name: "start",
		type: "number",
		required: false,
		description: "Zero-based pagination start index (default 0).",
	},
	{
		name: "size",
		type: "number",
		required: false,
		description: "Number of records to return (default 20).",
	},
];

const endpoints: EqtlEndpoint[] = [
	{
		method: "GET",
		path: "/studies",
		summary: "List all eQTL Catalogue studies.",
		category: "metadata",
		responseRequiresRetry: true,
	},
	{
		method: "GET",
		path: "/studies/{study_id}",
		summary: "Get metadata for a single study by its QTS identifier.",
		category: "metadata",
		pathParams: [
			{
				name: "study_id",
				type: "string",
				required: true,
				description: "QTS study identifier (for example QTS000029).",
			},
		],
		responseRequiresRetry: true,
	},
	{
		method: "GET",
		path: "/studies/{study_id}/associations",
		summary: "Search associations within one study.",
		category: "associations",
		pathParams: [
			{
				name: "study_id",
				type: "string",
				required: true,
				description: "QTS study identifier.",
			},
		],
		queryParams: associationParams,
		responseRequiresRetry: true,
	},
	{
		method: "GET",
		path: "/datasets",
		summary: "List all eQTL Catalogue datasets.",
		category: "metadata",
		responseRequiresRetry: true,
	},
	{
		method: "GET",
		path: "/datasets/{dataset_id}",
		summary: "Get metadata for a single dataset by its QTD identifier.",
		category: "metadata",
		pathParams: [
			{
				name: "dataset_id",
				type: "string",
				required: true,
				description: "QTD dataset identifier (for example QTD000021).",
			},
		],
		responseRequiresRetry: true,
	},
	{
		method: "GET",
		path: "/datasets/{dataset_id}/associations",
		summary: "Search associations within one dataset.",
		category: "associations",
		pathParams: [
			{
				name: "dataset_id",
				type: "string",
				required: true,
				description: "QTD dataset identifier.",
			},
		],
		queryParams: associationParams,
		responseRequiresRetry: true,
	},
	{
		method: "GET",
		path: "/associations",
		summary:
			"Search associations across all studies by gene, rsID, variant, trait, or chromosome.",
		category: "associations",
		queryParams: associationParams,
		responseRequiresRetry: true,
	},
];

export const eqtlCatalog: ApiCatalog = {
	name: "EBI eQTL Catalogue",
	baseUrl: "https://www.ebi.ac.uk/eqtl/api/v3",
	version: "v3",
	auth: "none",
	endpointCount: endpoints.length,
	notes:
		"- API v3 exposes studies, datasets, and association searches; retired v1-only gene/tissue/QTL-group routes are not advertised.\n" +
		"- Prefer a study- or dataset-scoped association route when you know the QTS/QTD identifier.\n" +
		"- Use rsid for dbSNP IDs and variant for chr_pos_ref_alt identifiers. Legacy variant_id/snp inputs are translated by the adapter.\n" +
		"- Keep association size small (5–50) and advance with the zero-based start parameter.",
	endpoints,
};
