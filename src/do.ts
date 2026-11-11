import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import { detectArrays, flattenObject, type SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const row = (value: unknown) => ({
  ...(record(value) ? { ...flattenObject(value, 2), ...Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, item !== null && typeof item === "object" ? JSON.stringify(item) : item])) } : { value }),
  native_json: JSON.stringify(value),
});
const unwrap = (value: unknown) => record(value) && Array.isArray(value.content) && record(value.structuredContent) && "data" in value.structuredContent
  ? value.structuredContent.data : value;

function tableName(sample: unknown, fallback: string): string {
  if (!record(sample)) return fallback;
  if ("p_beta" in sample || "p_perm" in sample) return "top_associations";
  if ("cs_id" in sample || "pip" in sample) return "credible_sets";
  if ("molecular_trait_id" in sample && "pvalue" in sample) return "associations";
  if ("dataset_id" in sample && ("sumstats_url" in sample || "release" in sample)) return "datasets";
  if ("study_id" in sample && "dataset_count" in sample) return "studies";
  return fallback;
}

/** Preserve existing biological tables, aligned native TSV and complete response context. */
export class EqtlDataDO extends RestStagingDO {
  protected getTabularData(value: unknown): unknown {
    const data = unwrap(value);
    if (Array.isArray(data)) return { [tableName(data[0], "observations")]: data.map(row) };
    if (!record(data)) return data;
    if (typeof data.sql === "string" && Array.isArray(data.rows)) return { query_rows: data.rows.map(row) };
    const primary = detectArrays(data)[0];
    if (!primary) return { native_observations: [row(data)] };
    const name = tableName(primary.rows[0], "observations");
    const raw = primary.key === "rows" && Array.isArray(data.raw_rows) ? data.raw_rows : undefined;
    if (raw && (raw.length !== primary.rows.length || raw.some(line => typeof line !== "string"))) throw new Error("Native TSV rows are not aligned with parsed rows");
    return {
      [name]: primary.rows.map((value, index) => ({ ...row(value), source_index: index, ...(raw ? { source_tsv: raw[index] } : {}) })),
      response_context: [{ native_json: JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== primary.key && !(raw && key === "raw_rows")))) }],
    };
  }

  protected getSchemaHints(value: unknown): SchemaHints {
    const tables = this.getTabularData(value);
    const columnTypes: Record<string, string> = { native_json: "TEXT", source_tsv: "TEXT" };
    if (record(tables)) for (const values of Object.values(tables)) {
      if (!Array.isArray(values)) continue;
      for (const item of values) if (record(item)) for (const [key, value] of Object.entries(item)) {
        if (typeof value === "string") columnTypes[key] = "TEXT";
      }
    }
    return { columnTypes };
  }
}
