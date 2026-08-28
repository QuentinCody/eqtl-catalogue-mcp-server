# eqtl-catalogue-mcp-server

MCP server over the [EBI eQTL Catalogue](https://www.ebi.ac.uk/eqtl/) — uniformly reprocessed QTL summary statistics across 42 studies (BLUEPRINT, GTEx, DICE, CEDAR, OneK1K, BrainSeq, GEUVADIS, …).

Runs on Cloudflare Workers. Exposes four Code Mode tools: `eqtl_search`, `eqtl_execute`, `eqtl_query_data`, `eqtl_get_schema`.

- Upstream data access: https://www.ebi.ac.uk/eqtl/Data_access/
- Local dev port: 8878
- Licence: CC BY 4.0

## The REST API is gone — this server reads the flat files

`https://www.ebi.ac.uk/eqtl/api/v3/*` returns **HTTP 410 "This API is no longer
available"**, and so do the unversioned base and the `/api/docs` route that the
Data_access page still links to. There is no route to repoint to.

EBI publishes the same data as static bgzip/tabix files, served over HTTPS with
`Accept-Ranges: bytes` and `Access-Control-Allow-Origin: *`. This server reads
two bases:

| Base | What it provides |
| --- | --- |
| `https://ftp.ebi.ac.uk/pub/databases/spot/eQTL` | summary statistics, permuted top hits, SuSiE credible sets |
| `https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/master` | `tabix/tabix_ftp_paths.tsv` (dataset → file map) and `data_tables/dataset_metadata_r7.tsv` (pmid, study_type) |

`src/lib/bgzf.ts` and `src/lib/tabix.ts` are a ~300-line reader over `fetch`
Range GETs and `DecompressionStream` — no htslib, no npm dependency.

## Surface

The paths are this server's own, not upstream REST routes.

| Path | Reads |
| --- | --- |
| `GET /studies`, `/studies/{study_id}` | metadata tables |
| `GET /datasets`, `/datasets/{dataset_id}` | metadata tables, incl. resolved file URLs |
| `GET /datasets/{id}/region?chromosome&start&end` | one tabix range GET into `.all`/`.cc.tsv.gz` |
| `GET /datasets/{id}/top_associations` | whole `.permuted.tsv.gz` (0.5–2 MB) |
| `GET /datasets/{id}/credible_sets` | streamed `susie/*.credible_sets.tsv.gz` (~10 MB) |

## Things that will bite you

- **Coordinates only.** The association files are tabix-indexed by GRCh38
  position. There is no gene- or rsID-keyed lookup, and the retired API's
  cross-study `/associations` route has no equivalent. Resolve a symbol or rsID
  to coordinates first (ensembl, gnomad, gwas-catalog), then call `/region`.
  Requesting `/associations` returns a 404 that says so rather than an empty result.
- **Not every dataset ships every file.** `quant_method` `ge` (280),
  `microarray` (25) and `aptamer` (1) publish `.all.tsv.gz`; `exon` / `tx` /
  `txrev` / `leafcutter` publish `.cc.tsv.gz` (113 each, 452 of the 758
  datasets). Counted from `tabix_ftp_paths.tsv` on 2026-08-27. Both carry the
  same 19 columns and a `.tbi`. The URL is read verbatim from
  `tabix_ftp_paths.tsv` — never assemble a filename from a suffix.
- **Release r7.** The FTP `sumstats/` tree matches `dataset_metadata_r7.tsv`
  (758 datasets, 42 studies). `dataset_metadata_r8.tsv` describes datasets that
  mostly 404 on the tree, and `r8_beta/` holds only QTS000036–QTS000039. If EBI
  cuts over, the resolver follows the metadata table; re-check which release the
  tree serves.
- **EBI blacklists frequent tabix requests.** The Data_access page says so
  explicitly, and a Worker egresses from shared Cloudflare addresses, so a
  blacklisting would hit the whole fleet. Every FTP read goes through one
  rate-limit key at 1.5 s apart (`src/lib/http.ts`), the ~2 MB `.tbi` and the
  header line are cached per isolate and in the Cache API, and a region span is
  capped at 5 Mb. Keep Code Mode fan-out to a handful of datasets.
- **`DecompressionStream("gzip")` cannot read a BGZF file whole.** Verified in
  workerd: feeding the concatenated members in throws
  `TypeError: Trailing bytes after end of compressed data`. `src/lib/bgzf.ts`
  inflates one member at a time using BSIZE from the `BC` extra subfield.
  The `.permuted` and `.credible_sets` files are plain single-member gzip and do
  stream through `DecompressionStream` directly.
- **A filter column that the file does not have is a 400, not an empty result.**
  The three file shapes carry different columns — in particular the SuSiE
  `.credible_sets.tsv.gz` has **no `chromosome` and no `position`**; its 13
  columns are `molecular_trait_id, gene_id, cs_id, variant, rsid, cs_size, pip,
  pvalue, beta, se, z, cs_min_r2, region`, and a set's locus lives in `region`
  (`chr1:9210570-11210570`). Matching an absent column against every row would
  drop all of them and answer `row_count: 0` with `success: true` — a
  manufactured absence. `resolveFilters` in `src/lib/sumstats.ts` checks every
  filter against the file's own header first and throws a 400 that lists the
  real columns.
- **The TSVs are CRLF.** Every line reader strips the carriage return; without
  it the last column of every row (`rsid`) carries a `\r`.

## Cost

A region query is 3 upstream requests cold (index, header, range) and **1** warm.
Measured in `wrangler dev` against the live tree: `QTD000021` at
`20:46120612-46120613` returned the expected 27 rows in 5.9 s cold / 0.5 s warm,
reading a 114 kB range out of a 2.99 GB file.
