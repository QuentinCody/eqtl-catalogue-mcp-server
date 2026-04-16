import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { eqtlFetch } from "./http";

/**
 * Mirror `variant_id` → `snp` to satisfy the current server-side validator
 * and backfill optional filter defaults that the live API rejects when omitted.
 */
const EQTL_ASSOCIATION_DEFAULTS: Record<string, unknown> = {
    quant_method: "ge",
    snp: "",
    study: "",
    tissue: "",
    gene_id: "",
    molecular_trait_id: "",
    qtl_group: "",
    p_lower: 0,
    p_upper: 1,
};

function normalizeEqtlParams(
    path: string,
    params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    const isAssoc = path.includes("associations");
    if (!isAssoc) return params;

    const out: Record<string, unknown> = { ...(params ?? {}) };
    const variantId = out.variant_id;
    const snp = out.snp;
    if (variantId && !snp) out.snp = variantId;
    else if (snp && !variantId) out.variant_id = snp;

    for (const [k, v] of Object.entries(EQTL_ASSOCIATION_DEFAULTS)) {
        if (out[k] === undefined || out[k] === null) out[k] = v;
    }
    return out;
}

export function createEqtlApiFetch(): ApiFetchFn {
    return async (request) => {
        const params = normalizeEqtlParams(request.path, request.params);
        const response = await eqtlFetch(request.path, params);

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = response.statusText;
            }
            const error = new Error(
                `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
            ) as Error & { status: number; data: unknown };
            error.status = response.status;
            error.data = errorBody;
            throw error;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
            const text = await response.text();
            return { status: response.status, data: text };
        }
        const data = await response.json();
        return { status: response.status, data };
    };
}
