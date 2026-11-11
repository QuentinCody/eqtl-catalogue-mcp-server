import { loadBetaMetadata } from "./beta-catalogue";
import { eqtlError } from "./release";

/** Adapter snapshot over the complete published file; no row paging or r7 fallback. */
export async function metadataSnapshot(params: Record<string, unknown>) {
  if (params.release !== "r8_beta") eqtlError("metadata_snapshot requires explicit release r8_beta");
  for (const key of Object.keys(params)) if (!["release", "metadata_sha256"].includes(key)) eqtlError(`unsupported metadata_snapshot parameter ${key}`);
  const { datasets, raw_metadata_tsv, provenance } = await loadBetaMetadata(params);
  return { ...provenance, raw_metadata_tsv,
    columns: raw_metadata_tsv.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].split("\t"),
    total_datasets: datasets.length, http_status: 200, coverage_complete: true,
    coverage_scope: "complete selected metadata file; not association files or biological coverage",
    cache_max_age_seconds: 3600 };
}
