import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class EqtlDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        if (Array.isArray(data)) {
            const sample = data[0];
            if (sample && typeof sample === "object") {
                // Association records
                if ("variant_id" in sample || "rsid" in sample || "pvalue" in sample) {
                    return {
                        tableName: "associations",
                        indexes: [
                            "variant_id",
                            "rsid",
                            "gene_id",
                            "molecular_trait_id",
                            "study_id",
                            "tissue",
                            "qtl_group",
                            "pvalue",
                        ],
                    };
                }
                // Study metadata
                if ("study_id" in sample && ("study_label" in sample || "tissue" in sample)) {
                    return {
                        tableName: "studies",
                        indexes: ["study_id", "tissue", "qtl_group"],
                    };
                }
                // Tissues
                if ("tissue_ontology_id" in sample || "tissue_label" in sample) {
                    return {
                        tableName: "tissues",
                        indexes: ["tissue_ontology_id", "tissue_label"],
                    };
                }
            }
        }

        return undefined;
    }
}
