import type { EqtlRoute } from "./api-adapter";
import { type DatasetFilters, filterDatasets, summarizeStudies } from "./ftp-catalogue";
import { CATALOGUE_RESOURCES_BASE, EBI_FTP_BASE, ebiFileFetch, resourcesFetch } from "./http";
import { boundedText, eqtlError, hashParam, sha256 } from "./release";

const TABLE = "/data_tables/dataset_metadata_r8_beta.tsv";
import { parseBetaMetadata, type BetaDataset } from "@bio-mcp/shared/adapters/eqtl/beta-metadata";
export { parseBetaMetadata, type BetaDataset } from "@bio-mcp/shared/adapters/eqtl/beta-metadata";
let cached: { until: number; value: ReturnType<typeof fetchMetadata> } | undefined;

async function fetchMetadata() {
  const response = await resourcesFetch(TABLE, { cacheTtlSeconds: 3600 });
  const text = await boundedText(response);
  return { datasets: parseBetaMetadata(text), raw_metadata_tsv: text, provenance: {
    release: "r8_beta", status: "pre-release", assembly: "GRCh38",
    metadata_url: `${CATALOGUE_RESOURCES_BASE}${TABLE}`, metadata_sha256: await sha256(text),
    retrieved_at: new Date().toISOString(), etag: response.headers.get("etag"),
  } };
}

export function resetBetaCache(): void { cached = undefined; }

export async function loadBetaMetadata(params?: Record<string, unknown>) {
  if (!cached || cached.until < Date.now()) {
    const value = fetchMetadata();
    cached = { until: Date.now() + 3600_000, value };
    value.catch(() => { if (cached?.value === value) cached = undefined; });
  }
  const result = await cached.value;
  const expected = hashParam(params?.metadata_sha256, "metadata_sha256");
  if (expected && expected !== result.provenance.metadata_sha256) eqtlError("r8 metadata snapshot changed; refresh or query a retained backend snapshot by its checksum", 409);
  return result;
}

/** Only links naming direct Parquet children of this exact official directory. */
export function directoryFiles(html: string, directory: string) {
  const urls = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let url: URL;
    try { url = new URL(match[1], directory); } catch { continue; }
    if (!url.href.startsWith(directory) || url.username || url.password || url.search || url.hash) continue;
    const filename = url.href.slice(directory.length);
    if (/^QTD\d{6}\.[a-zA-Z0-9_.-]+\.parquet$/.test(filename)) urls.add(url.href);
  }
  return [...urls].map(url => ({ url, filename: url.slice(directory.length), format: "Parquet", role: roleFor(url) }));
}

function roleFor(url: string): string {
  for (const role of ["all", "cc", "permuted", "credible_sets", "lbf_variable"]) if (url.endsWith(`.${role}.parquet`)) return role;
  return "unclassified";
}

export async function betaFiles(dataset: BetaDataset) {
  const listings = [];
  // Serial requests also respect the shared EBI rate limiter.
  for (const category of ["sumstats", "susie"]) {
    const url = `${EBI_FTP_BASE}/r8_beta/${category}/${dataset.study_id}/${dataset.dataset_id}/`;
    try {
      const response = await ebiFileFetch(url, { cacheTtlSeconds: 3600 });
      const text = await boundedText(response);
      const files = directoryFiles(text, url);
      if (files.some(file => !file.filename.startsWith(`${dataset.dataset_id}.`))) eqtlError("directory contains a different dataset ID", 502);
      listings.push({ url, status: "available", listing_sha256: await sha256(text), retrieved_at: new Date().toISOString(), files });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      listings.push({ url, status: "not_published", files: [] });
    }
  }
  return { dataset, listings, note: "Listing checksums identify discovery responses, not file contents. Bulk download externally, verify file SHA-256 and register with the query service. Both all and cc may exist; choose explicitly." };
}

export async function betaMetadataRoute(route: EqtlRoute, params: Record<string, unknown>) {
  const datasetFilters = ["dataset_id", "study_id", "study_label", "quant_method", "tissue_label", "tissue_id", "sample_group", "condition_label", "study_type", "search"];
  const accepted = ["release", "metadata_sha256", ...(route.kind === "datasets" ? [...datasetFilters, "offset", "size"] : route.kind === "studies" ? ["search"] : [])];
  for (const key of Object.keys(params)) if (!accepted.includes(key)) eqtlError(`unsupported ${route.kind} parameter ${key}`);
  const { datasets, provenance } = await loadBetaMetadata(params);
  if (route.kind === "datasets") {
    return filterBetaDatasets(datasetFilters, params, datasets, provenance);
  }
  if (route.kind === "studies") {
    if (params.search !== undefined && typeof params.search !== "string") eqtlError("search must be a string");
    const studies = summarizeStudies(datasets).filter(s => `${s.study_id} ${s.study_label}`.toLowerCase().includes(String(params.search ?? "").toLowerCase()));
    return { ...provenance, study_count: studies.length, studies };
  }
  if (route.kind === "study") {
    const members = datasets.filter(d => d.study_id === route.studyId);
    if (!members.length) eqtlError(`study ${route.studyId} not found in r8_beta`, 404);
    return { ...provenance, ...summarizeStudies(members)[0], datasets: members };
  }
  if (!("datasetId" in route)) eqtlError("unsupported r8 metadata route");
  const dataset = datasets.find(d => d.dataset_id === route.datasetId);
  if (!dataset) eqtlError(`dataset ${route.datasetId} not found in r8_beta`, 404);
  return route.kind === "files" ? { ...provenance, ...await betaFiles(dataset) } : { ...provenance, ...dataset };
}

function filterBetaDatasets(datasetFilters: string[], params: Record<string, unknown>, datasets: { study_id: string; dataset_id: string; study_label: string; sample_group: string; tissue_id: string; tissue_label: string; condition_label: string; sample_size: number | null; quant_method: string; pmid: string | null; study_type: string | null; release: "r8_beta"; assembly: "GRCh38"; metadata: { [k: string]: string; }; }[], provenance: { release: string; status: string; assembly: string; metadata_url: string; metadata_sha256: string; retrieved_at: string; etag: string | null; }) {
  const filters: DatasetFilters = {};
  for (const key of datasetFilters) {
    if (params[key] !== undefined && typeof params[key] !== "string") eqtlError(`${key} must be a string`);
    if (params[key] !== undefined) (filters as Record<string, string>)[key] = params[key] as string;
  }
  const matched = filterDatasets(datasets, filters);
  const offset = integer(params.offset ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER);
  const size = integer(params.size ?? 50, "size", 1, 1000);
  return { ...provenance, total_datasets: datasets.length, matched_datasets: matched.length, offset, datasets: matched.slice(offset, offset + size) };
}

export function integer(value: unknown, name: string, min: number, max: number): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") eqtlError(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) eqtlError(`${name} must be an integer from ${min} to ${max}`);
  return number;
}
