import type { ApiEndpoint } from "@bio-mcp/shared/codemode/catalog";

export const releaseParams: NonNullable<ApiEndpoint["queryParams"]> = [
  { name: "release", type: "string", required: false, description: "r7 (default) or r8_beta (mutable pre-release). IDs can name different analyses across releases. Never join by dataset ID alone." },
  { name: "metadata_sha256", type: "string", required: false, description: "Metadata SHA-256 drift guard for the selected release. r7 returns this under catalogue_snapshot; pass it on subsequent reads. REQUIRED for r8 Parquet queries and schema, where it identifies a retained backend metadata snapshot." },
  { name: "paths_sha256", type: "string", required: false, description: "r7 only: file-map SHA-256 from catalogue_snapshot. Pass with metadata_sha256 to reject catalogue changes before reading associations. This does not hash or pin association-file contents." },
];
export const parquetParams: NonNullable<ApiEndpoint["queryParams"]> = [
  { name: "file_sha256", type: "string", required: false, description: "Required for r8 Parquet: SHA-256 of the imported file, verified on every read. Obtain from the operator import manifest." },
  { name: "file_role", type: "string", required: false, description: "r8 region requires explicit all or cc (both can exist). Schema additionally allows permuted, credible_sets, lbf_variable. Top/credible-set routes select their matching role." },
];
export const releaseEndpoints: ApiEndpoint[] = [
  { method: "GET", path: "/discovery/metadata_snapshot", summary: "Retain the complete r8 beta metadata TSV, columns and SHA-256 for reproducible metadata-change checks.", category: "metadata",
    queryParams: [
      { name: "release", type: "string", required: true, description: "Must explicitly select r8_beta; no r7 fallback." },
      releaseParams[1],
    ],
    responseShape: "{ release, status, assembly, metadata_url, metadata_sha256, raw_metadata_tsv, columns[], total_datasets, retrieved_at, http_status, coverage_complete, coverage_scope, cache_max_age_seconds }",
    example: 'return await api.get("/discovery/metadata_snapshot", { release: "r8_beta" });',
    usageHint: "Adapter-local file snapshot, not a native REST endpoint. Usually staged: preserve the handle and recover payloads.root_json with query_data. Hash covers the complete UTF-8 TSV, including BOM/line endings. The metadata cache lasts up to one hour; retrieved_at is the file observation time. Complete refers only to the selected metadata file, never to association coverage or cross-release equivalence." },
  { method: "GET", path: "/releases", summary: "Discover explicit r7 and opt-in r8_beta sources, formats and release status.", category: "metadata", responseShape: "{ default_release, releases[] }", example: 'return await api.get("/releases");' },
  { method: "GET", path: "/datasets/{dataset_id}/files", summary: "Discover published Parquet links from the exact r8 dataset directories; r7 returns its existing file map.", category: "metadata",
    pathParams: [{ name: "dataset_id", type: "string", required: true, description: "QTD dataset identifier." }], queryParams: releaseParams,
    responseShape: "{ release, assembly, metadata_sha256?, dataset, listings?: [{ url, status, listing_sha256, files: [{url, filename, role, format}] }] }",
    example: 'return await api.get("/datasets/QTD000116/files", { release: "r8_beta" });',
    usageHint: "A metadata record does not prove its Parquet files have been published. Directory 404 is reported as not_published; other upstream failures are errors. Listing hashes are NOT file hashes. Import selected assets outside the Worker. No automatic fallback to r7." },
  { method: "GET", path: "/datasets/{dataset_id}/parquet_schema", summary: "Inspect the actual schema of a checksum-verified imported r8 Parquet snapshot.", category: "metadata",
    pathParams: [{ name: "dataset_id", type: "string", required: true, description: "QTD dataset identifier." }], queryParams: [...releaseParams, ...parquetParams],
    responseShape: "{ release, assembly, dataset_id, metadata, metadata_sha256, file_sha256, file_role, source_url, schema[], schema_metadata, encoding }",
    usageHint: "Requires release r8_beta, metadata_sha256, file_sha256, file_role and a configured EQTL_PARQUET_URL/TOKEN service. Missing service or snapshot returns an explicit error. Do not assume the legacy r7 TSV columns; chromosome values match the Parquet file exactly." },
];
