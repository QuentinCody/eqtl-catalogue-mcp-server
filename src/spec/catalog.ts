import type { ApiCatalog, ApiEndpoint } from "@bio-mcp/shared/codemode/catalog";

/**
 * The `responseRequiresRetry` metadata flag is a free-form hint for the LLM;
 * the eQTL Catalogue API is upstream-fragile (intermittent 400/500/timeout).
 * It is NOT consumed by the Code Mode retry machinery.
 */
type EqtlEndpoint = ApiEndpoint & { responseRequiresRetry?: boolean };

const endpoints: EqtlEndpoint[] = [
    {
        method: "GET",
        path: "/studies",
        summary: "List eQTL Catalogue studies with QTL group metadata (tissue, cell type, condition).",
        category: "metadata",
        queryParams: [
            { name: "size", type: "number", required: false, description: "Page size (default varies; try 50)." },
            { name: "page", type: "number", required: false, description: "Page number for pagination." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/studies/{study_id}",
        summary: "Get metadata for a single study by its identifier.",
        category: "metadata",
        pathParams: [
            { name: "study_id", type: "string", required: true, description: "Study identifier (e.g. GTEx, BLUEPRINT)." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/studies/{study_id}/associations",
        summary: "Associations filtered to a single study — preferred over the broad associations route.",
        category: "associations",
        pathParams: [
            { name: "study_id", type: "string", required: true, description: "Study identifier." },
        ],
        queryParams: [
            { name: "variant_id", type: "string", required: false, description: "rsID or chr_pos_ref_alt. The adapter mirrors this to the legacy `snp` key." },
            { name: "gene_id", type: "string", required: false, description: "Ensembl gene ID (e.g. ENSG00000141510)." },
            { name: "molecular_trait_id", type: "string", required: false, description: "Molecular trait identifier." },
            { name: "qtl_group", type: "string", required: false, description: "QTL group / tissue label used by the study." },
            { name: "tissue", type: "string", required: false, description: "Tissue ontology ID (UBERON_ or CL_)." },
            { name: "quant_method", type: "string", required: false, description: "Quantification method (default: 'ge' = gene expression).", enum: ["ge", "exon", "tx", "txrev", "microarray", "leafcutter"] },
            { name: "p_lower", type: "number", required: false, description: "Minimum p-value filter (default 0)." },
            { name: "p_upper", type: "number", required: false, description: "Maximum p-value filter (default 1)." },
            { name: "size", type: "number", required: false, description: "Page size." },
            { name: "page", type: "number", required: false, description: "Page number." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/genes/{gene_id}/associations",
        summary: "Associations for a given gene across studies — preferred gene-scoped route.",
        category: "associations",
        pathParams: [
            { name: "gene_id", type: "string", required: true, description: "Ensembl gene ID (e.g. ENSG00000141510)." },
        ],
        queryParams: [
            { name: "variant_id", type: "string", required: false, description: "rsID or chr_pos_ref_alt." },
            { name: "study", type: "string", required: false, description: "Study identifier to filter by." },
            { name: "tissue", type: "string", required: false, description: "Tissue ontology ID." },
            { name: "qtl_group", type: "string", required: false, description: "QTL group label." },
            { name: "quant_method", type: "string", required: false, description: "Quantification method (default: 'ge')." },
            { name: "p_lower", type: "number", required: false, description: "Minimum p-value filter." },
            { name: "p_upper", type: "number", required: false, description: "Maximum p-value filter." },
            { name: "size", type: "number", required: false, description: "Page size." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/associations/{variant_id}",
        summary: "All associations for a specific variant (rsID or chr_pos_ref_alt). Use with `size` to cap rows.",
        category: "associations",
        pathParams: [
            { name: "variant_id", type: "string", required: true, description: "rsID (e.g. rs7903146) or chr_pos_ref_alt." },
        ],
        queryParams: [
            { name: "study", type: "string", required: false, description: "Restrict to a single study." },
            { name: "tissue", type: "string", required: false, description: "Tissue ontology ID." },
            { name: "quant_method", type: "string", required: false, description: "Quantification method." },
            { name: "p_lower", type: "number", required: false, description: "Minimum p-value." },
            { name: "p_upper", type: "number", required: false, description: "Maximum p-value." },
            { name: "size", type: "number", required: false, description: "Page size." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/associations",
        summary: "Broad association search across all studies. Fragile — prefer targeted gene/study/variant routes.",
        category: "associations",
        queryParams: [
            { name: "variant_id", type: "string", required: false, description: "rsID or chr_pos_ref_alt." },
            { name: "gene_id", type: "string", required: false, description: "Ensembl gene ID." },
            { name: "study", type: "string", required: false, description: "Study identifier." },
            { name: "tissue", type: "string", required: false, description: "Tissue ontology ID." },
            { name: "qtl_group", type: "string", required: false, description: "QTL group label." },
            { name: "molecular_trait_id", type: "string", required: false, description: "Molecular trait ID." },
            { name: "quant_method", type: "string", required: false, description: "Quantification method." },
            { name: "p_lower", type: "number", required: false, description: "Minimum p-value." },
            { name: "p_upper", type: "number", required: false, description: "Maximum p-value." },
            { name: "size", type: "number", required: false, description: "Page size." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/tissues",
        summary: "List tissues / cell types with UBERON/CL ontology IDs used across studies.",
        category: "metadata",
        queryParams: [
            { name: "size", type: "number", required: false, description: "Page size." },
            { name: "page", type: "number", required: false, description: "Page number." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/qtl_groups",
        summary: "List QTL groups (study × tissue × condition) with descriptive labels.",
        category: "metadata",
        queryParams: [
            { name: "size", type: "number", required: false, description: "Page size." },
            { name: "page", type: "number", required: false, description: "Page number." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/chromosomes/{chromosome}/associations",
        summary: "Associations on a specific chromosome. Keep windows narrow via start/end for tractable queries.",
        category: "associations",
        pathParams: [
            { name: "chromosome", type: "string", required: true, description: "Chromosome name (1-22, X, Y)." },
        ],
        queryParams: [
            { name: "start", type: "number", required: false, description: "Window start position (bp)." },
            { name: "end", type: "number", required: false, description: "Window end position (bp)." },
            { name: "study", type: "string", required: false, description: "Study filter." },
            { name: "tissue", type: "string", required: false, description: "Tissue ontology ID." },
            { name: "size", type: "number", required: false, description: "Page size." },
        ],
        responseRequiresRetry: true,
    },
    {
        method: "GET",
        path: "/molecular_traits/{molecular_trait_id}/associations",
        summary: "Associations filtered by a molecular trait ID (gene, exon, transcript, or splice ID depending on quant_method).",
        category: "associations",
        pathParams: [
            { name: "molecular_trait_id", type: "string", required: true, description: "Molecular trait identifier." },
        ],
        queryParams: [
            { name: "study", type: "string", required: false, description: "Study filter." },
            { name: "tissue", type: "string", required: false, description: "Tissue ontology ID." },
            { name: "quant_method", type: "string", required: false, description: "Quantification method." },
            { name: "size", type: "number", required: false, description: "Page size." },
        ],
        responseRequiresRetry: true,
    },
];

export const eqtlCatalog: ApiCatalog = {
    name: "EBI eQTL Catalogue",
    baseUrl: "https://www.ebi.ac.uk/eqtl/api",
    version: "v2",
    auth: "none",
    endpointCount: endpoints.length,
    notes:
        "- Association endpoints are upstream-fragile: 400/500/timeout can occur even with documented parameters.\n" +
        "- Prefer targeted association paths (genes/<gene_id>/associations or studies/<study>/associations) over broad list endpoints.\n" +
        "- Pass variant_id; the adapter also mirrors it to the legacy `snp` key required by the current validator.\n" +
        "- The adapter backfills defaults for quant_method, p_lower, p_upper, and blank filter strings so omitted optional filters do not trigger 400 errors.\n" +
        "- size parameter is required on list endpoints; keep it small (5–50).\n" +
        "- Tissue is supplied as a UBERON or CL ontology ID string (e.g. 'UBER_0000178').",
    endpoints,
};
