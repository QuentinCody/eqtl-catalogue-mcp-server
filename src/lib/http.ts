import { restFetch } from "@bio-mcp/shared/http/rest-fetch";
import type { RestFetchOptions } from "@bio-mcp/shared/http/rest-fetch";

const EQTL_BASE = "https://www.ebi.ac.uk/eqtl/api/v3";

export interface EqtlFetchOptions extends Omit<RestFetchOptions, "retryOn"> {
	baseUrl?: string;
}

/**
 * Fetch from the EBI eQTL Catalogue API.
 *
 * API v3 provides study, dataset, and association routes. Legacy v1/v2 query
 * aliases are normalized by the adapter before they reach this layer.
 */
export async function eqtlFetch(
	path: string,
	params?: Record<string, unknown>,
	opts?: EqtlFetchOptions,
): Promise<Response> {
	const baseUrl = opts?.baseUrl ?? EQTL_BASE;
	const headers: Record<string, string> = {
		Accept: "application/json",
		...(opts?.headers ?? {}),
	};

	return restFetch(baseUrl, path, params, {
		...opts,
		headers,
		retryOn: [429, 500, 502, 503, 504],
		retries: opts?.retries ?? 3,
		timeout: opts?.timeout ?? 30_000,
		userAgent: "eqtl-catalogue-mcp-server/1.0 (bio-mcp)",
	});
}
