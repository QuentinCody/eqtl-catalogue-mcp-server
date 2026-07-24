import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { eqtlFetch } from "./http";

/**
 * Translate the legacy catalog's variant aliases to API v3 and discard v1
 * filters that FastAPI no longer documents. API v3 accepts `rsid` for rs IDs
 * and `variant` for chr_pos_ref_alt identifiers.
 */
export function normalizeEqtlParams(
	path: string,
	params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const isAssoc = path.includes("associations");
	if (!isAssoc) return params;

	const out: Record<string, unknown> = { ...(params ?? {}) };
	const legacyVariant = out.variant_id ?? out.snp;
	if (typeof legacyVariant === "string" && legacyVariant.length > 0) {
		if (/^rs\d+$/i.test(legacyVariant)) {
			out.rsid ??= legacyVariant;
		} else {
			out.variant ??= legacyVariant;
		}
	}

	for (const legacyKey of [
		"variant_id",
		"snp",
		"study",
		"tissue",
		"qtl_group",
		"quant_method",
		"p_lower",
		"p_upper",
		"page",
	]) {
		delete out[legacyKey];
	}

	return Object.keys(out).length > 0 ? out : undefined;
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
