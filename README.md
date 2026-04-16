# eqtl-catalogue-mcp-server

MCP server wrapping the [EBI eQTL Catalogue REST API](https://www.ebi.ac.uk/eqtl/api-docs/) — a resource of harmonised QTL associations across studies (GTEx, BLUEPRINT, eQTLGen, and more).

Runs on Cloudflare Workers. Exposes four Code Mode tools (`eqtl_search`, `eqtl_execute`, `eqtl_query_data`, `eqtl_get_schema`) plus a thin `eqtl_search` convenience wrapper.

- Upstream docs: https://www.ebi.ac.uk/eqtl/api-docs/
- Base URL: `https://www.ebi.ac.uk/eqtl/api`
- Local dev port: 8878
- Category focus: associations (gene / study / variant / chromosome scoped) and metadata (studies, tissues, QTL groups).

The upstream API is **fragile** — intermittent 400/500/timeout responses occur even on documented parameter sets. The adapter mirrors `variant_id` → `snp` and backfills defaults for `quant_method`, `p_lower`, `p_upper`, and blank string filters to reduce 400s.
