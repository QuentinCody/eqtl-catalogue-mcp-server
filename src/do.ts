import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";
import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";

/**
 * The staged payload reaches the DO either as the row array itself or inside
 * this server's envelope (`{ dataset, columns, rows, ... }`). Pick the first
 * array of records — `columns` is an array of strings and must not win.
 */
function firstRecord(data: unknown): Record<string, unknown> | undefined {
    const candidates: unknown[] = Array.isArray(data)
        ? [data]
        : data && typeof data === "object"
            ? Object.values(data as Record<string, unknown>).filter(Array.isArray)
            : [];
    for (const candidate of candidates) {
        const head = (candidate as unknown[])[0];
        if (head && typeof head === "object" && !Array.isArray(head)) {
            return head as Record<string, unknown>;
        }
    }
    return undefined;
}

/**
 * Staging schema hints for the four table shapes the eQTL Catalogue files
 * produce: the 19-column nominal/conditional associations (.all/.cc.tsv.gz),
 * the permutation top hits (.permuted.tsv.gz), the SuSiE credible sets, and
 * the dataset/study metadata tables.
 */
export class EqtlDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        const sample = firstRecord(data);
        if (!sample) return undefined;

        // Permuted top hits — checked first; they also carry pvalue/beta.
        if ("p_beta" in sample || "p_perm" in sample) {
            return {
                tableName: "top_associations",
                indexes: [
                    "molecular_trait_object_id",
                    "molecular_trait_id",
                    "chromosome",
                    "position",
                    "variant",
                    "p_beta",
                ],
            };
        }

        // SuSiE credible sets. The file has no chromosome/position column —
        // its locus column is `region` (chrN:start-end).
        if ("cs_id" in sample || "pip" in sample) {
            return {
                tableName: "credible_sets",
                indexes: [
                    "molecular_trait_id",
                    "gene_id",
                    "cs_id",
                    "variant",
                    "rsid",
                    "region",
                    "pip",
                ],
            };
        }

        // Nominal / conditional cis associations.
        if ("molecular_trait_id" in sample && "pvalue" in sample) {
            return {
                tableName: "associations",
                indexes: [
                    "molecular_trait_id",
                    "molecular_trait_object_id",
                    "gene_id",
                    "variant",
                    "rsid",
                    "chromosome",
                    "position",
                    "pvalue",
                ],
            };
        }

        // Dataset catalogue rows.
        if ("dataset_id" in sample && "sumstats_url" in sample) {
            return {
                tableName: "datasets",
                indexes: [
                    "dataset_id",
                    "study_id",
                    "study_label",
                    "quant_method",
                    "tissue_label",
                    "condition_label",
                ],
            };
        }

        // Study summaries.
        if ("study_id" in sample && "dataset_count" in sample) {
            return {
                tableName: "studies",
                indexes: ["study_id", "study_label", "study_type"],
            };
        }

        return undefined;
    }
}
