# eqtl-catalogue-mcp-server

MCP server over the [EBI eQTL Catalogue](https://www.ebi.ac.uk/eqtl/) — uniformly reprocessed QTL summary statistics, with r7 as the default and explicit opt-in r8 beta Parquet support.

Runs on Cloudflare Workers. Exposes search, execute, query_data, get_schema and metadata_snapshot under both `eqtl_*` and `mcp_eqtl_*`. Results above 30 KiB stage through the data DO.

## Complete r8 metadata snapshots

`eqtl_metadata_snapshot` and `mcp_eqtl_metadata_snapshot` accept
`{ "release": "r8_beta" }`, with an optional `metadata_sha256` drift guard.
The equivalent Code Mode route is `/discovery/metadata_snapshot`. These are
adapter-local operations over the provider's published metadata file, not
restored native REST endpoints. No Parquet query service is required.

The response retains complete UTF-8 TSV text (including BOM/line endings),
columns, dataset count, file SHA-256, source URL and retrieval time. Existing
metadata caching lasts up to one hour; retrieval time identifies the cached
file observation. `coverage_complete` refers only to that selected metadata
file. It does not establish association-file, biological or cross-release coverage.
Malformed or partial files and mismatched hashes fail explicitly. Large results
stage with a verifiable citation; recover the complete envelope from
`payloads.root_json` using `eqtl_query_data`.

The monitor server's `eqtl-r8-metadata` source uses the dedicated tool to rehash
and reparse complete file evidence, then compares native dataset definitions
and file pins separately. No subscription or schedule is created by these changes.

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

The reader in `packages/mcp-shared/src/adapters/eqtl/` uses `fetch` Range GETs
and `DecompressionStream` without htslib or an added npm dependency. Local
`src/lib/` modules re-export the shared implementation so existing imports and
Code Mode routes remain intact. L2G reuses the same reader with request-scoped
cancellation and caches for its optional r7 context lookup.

## Surface

The paths are this server's own, not upstream REST routes.

| Path | Reads |
| --- | --- |
| `GET /releases` | release status, formats, metadata and versioned merged credible-set links |
| `GET /studies`, `/studies/{study_id}` | metadata tables |
| `GET /datasets`, `/datasets/{dataset_id}` | metadata tables, incl. resolved file URLs |
| `GET /datasets/{id}/files` | r7 file map, or exact links from the two published r8 directories |
| `GET /datasets/{id}/parquet_schema` | actual schema of an imported, checksum-pinned r8 file |
| `GET /datasets/{id}/region?chromosome&start&end` | one tabix range GET into `.all`/`.cc.tsv.gz` |
| `GET /datasets/{id}/top_associations` | whole `.permuted.tsv.gz` (0.5–2 MB) |
| `GET /datasets/{id}/credible_sets` | bounded whole `susie/*.credible_sets.tsv.gz` |

The three association routes above default to **r7**. With `release: "r8_beta"`
they query the separately configured Parquet service described below. They never
fall back to r7. URL query parameters and Code Mode parameter objects both work;
duplicate parameters and GET bodies are rejected.

## r8 beta: discover, import, query

[September 2026 release notes](https://www.ebi.ac.uk/eqtl/Release_notes/) announce
GTEx v10, MAGE and IBDverse additions and Parquet delivery. Final r8 is scheduled
for December 2026; `r8_beta` is a mutable pre-release. Metadata is read exclusively
from `dataset_metadata_r8_beta.tsv`, including unknown new columns. For example,
QTD000244 names a newer GTEx v10 analysis in r8 than in r7. Never join releases by
dataset ID alone. Metadata results include a SHA-256 and retrieval time; optional
`metadata_sha256` rejects drift. r7 results also identify their metadata/path-table
snapshots, but those hashes do not make upstream `master` or the FTP files immutable.

For r7, every catalogue/data result carries `catalogue_snapshot`, including empty
searches and pages. Pass its `metadata_sha256` and `paths_sha256` back on subsequent
reads to reject a changed catalogue with HTTP 409 **before** fetching association
files. The cached catalogue is joined only when dataset identity, study, tissue,
condition, sample group and quantification method agree between the
two tables; missing/duplicate IDs or malformed tables fail explicitly. These guards
verify the catalogue used by the Worker, not the contents of association files or
the current upstream state beyond its cache. There is no historical snapshot lookup.

The provider's two r7 tables report different sample sizes for some datasets.
For compatibility, `sample_size` still uses the file map; `sample_size_provenance`
retains both original strings, the selected source and an `agreement` flag. A
disagreement is not evidence of equivalent analysis sample sizes. Study-level
`sample_size_max` remains a summary of the file-map values; inspect dataset records
before using a sample count for analysis.

```js
const discovery = await api.get("/datasets/QTD000021", { release: "r7" });
if (discovery.__api_error || discovery.__staged || !discovery.catalogue_snapshot) return discovery;
const { metadata_sha256, paths_sha256 } = discovery.catalogue_snapshot;
return await api.get("/datasets/QTD000021/region", {
  release: "r7", metadata_sha256, paths_sha256,
  chromosome: "20", start: 46120612, end: 46120613, max_rows: 100,
});
```

Keep returned errors or staging handles intact. `paths_sha256` is specific to r7;
r8 rejects it and retains its separate metadata/file checksum contract.

r7 region results also include `native_header`, aligned `raw_rows`, and
`file_evidence` for the index, header range and association range. Raw rows retain
numeric text and distinguish `NA` from empty cells; CRLF line endings are normalized.
Use these when JavaScript numeric conversion would lose precision (for example,
`1e-400` becomes zero in the parsed `rows`). Staging preserves the complete response
in its canonical payload as well as materializing the association table.

The optional `index_sha256`, `header_sha256` and `range_sha256` parameters guard a
repeat of the same r7 region query. Hashes describe the complete compressed HTTP
response bytes: the header hash covers its first up-to-64 KiB range, not just the
header line. Index/header caches retain their evidence; guards do not force a fresh
upstream read. Mismatches or conflicting ETag/Last-Modified values return 409.
Independently downloaded files cannot establish a release-wide snapshot, so
`coverage_complete` is always false, including empty results. Other routes and
r8 reject these three region-specific parameters.

Range reads require HTTP 206 with matching Content-Range and body length.
Compressed index reads are capped at 8 MiB and region reads at 16 MiB, with a
15-second body deadline. BGZF inflation is bounded to 64 KiB per member and 64 MiB
per read; individual lines are capped at 1 MiB. The reader honors tabix record
offsets, rejects malformed complete rows, and omits incomplete trailing rows.
Narrow the region if a size limit is exceeded.

The two whole-file r7 routes also retain `native_header`, aligned `raw_rows` and
`file_evidence`. Their SHA-256 covers the complete compressed file, even when a
row cap stops decoding early. Reads require HTTP 200 without Content-Range and
are bounded to 16 MiB compressed, 64 MiB inflated, 1 MiB per line and 25 seconds
of decoding. Malformed complete rows, duplicate headers and invalid UTF-8 fail
explicitly. Missing numeric cells do not become zero-valued filter matches.
Oversized files require offline analysis. These results do not claim release-wide
coverage. Both tool aliases preserve citations and native errors; complete MCP
envelopes above 30 KiB are staged. Biological SQL tables retain `native_json`,
`source_tsv` and `source_index`, while `response_context` retains the remaining
metadata and `payloads` retains the complete response.

```js
return await api.get("/datasets/QTD000116/files", { release: "r8_beta" });
```

`/files` reads published links from the dataset's `sumstats` and `susie` directories.
Both `all` and `cc` can exist for one dataset, so a region query requires explicit
`file_role`. A 404 directory is marked `not_published`; other failures are errors.
Listing checksums identify the HTML listing, **not the Parquet contents**.
The release discovery response also links the separately versioned
[merged credible-set snapshot](https://zenodo.org/records/22846842); this backend
currently queries the per-dataset FTP files, not the merged Zenodo assets.

Download the desired official files outside the Worker and retain their matching
metadata TSV. Use [backend/register.py](backend/register.py) to hash, validate and
atomically register them; [backend/README.md](backend/README.md) covers service setup.
The Worker needs `EQTL_PARQUET_URL` (HTTPS endpoint ending `/query`) and the secret
`EQTL_PARQUET_TOKEN`. Without configuration, discovery works and Parquet queries
return an explicit 503. No public backend is assumed or deployed by this change.

```js
// Replace the two placeholders with checksums from the operator's import result.
const pin = {
  release: "r8_beta", file_role: "all",
  metadata_sha256: "<64 lowercase hex characters>",
  file_sha256: "<64 lowercase hex characters>",
};
return await api.get("/datasets/QTD000116/parquet_schema", pin);
// Then query using chromosome values exactly as the file stores them:
// return await api.get("/datasets/QTD000116/region", {
//   ...pin, chromosome: "chr1", start: 100000, end: 101000, max_rows: 100,
// });
```

The backend verifies both files on every call and retains metadata, schema, source
URL, checksums, assembly and all returned columns. It preserves duplicate/multi-rsid
rows and ALT effect-allele orientation; no normalization, deduplication or aggregation
is performed. Query identity includes both checksums, so retained older snapshots
remain queryable after upstream metadata changes. Missing columns are errors.
Inspect `parquet_schema` instead of applying legacy TSV column assumptions to r8.

Queries have a 30-second subprocess deadline, at most 5,000 rows and a 2 MiB
response budget; timeouts are errors, row/byte caps report `truncated` and its reason.
No exact total is claimed. Large integer and decimal values serialize as strings;
schema/encoding metadata explains conversions. The scanner streams local batches;
it does not perform remote Parquet range queries or promise indexed row-group pruning.
Very large or slow files may require offline analysis. Service deployment also needs
an operator-set container memory limit (see backend instructions).

### Native acceptance on October 4, 2026

Original metadata bytes validated all 758 r7 and 592 r8 beta datasets, including
120 r7 sample-count disagreements. Local Worker queries reproduced the provider's
27-row QTD000021 chr20 example and selected rows from its permuted/credible-set
files, preserving compressed-file hashes and original TSV through SQL staging.
Both catalog recipes and all eight tool aliases passed canonical citation checks.

Offline use of the existing importer/query code also validated complete native
QTD000116 r8 beta `permuted` and `credible_sets` Parquet files (22,748 and 274,812
rows). Every schema field and the returned bounded/trait-selected rows matched
independent PyArrow reads. This establishes those two files' observed schemas,
including the credible-set chromosome/position columns absent from r7. It does
not qualify the multi-gigabyte `all`, `cc` or `lbf_variable` files, release-wide
coverage, production throughput or Worker-to-HTTPS-backend integration. No service
was provisioned or deployed. Receipts are in `scratch/2026-10-04-eqtl/`.

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
- **Release selection.** The default r7 resolver uses its own metadata and file
  map. r8 uses separate metadata and discovered Parquet listings; neither silently
  substitutes the other. Release-level reproducibility also requires retaining
  the original files, not merely remembering a QTD ID.
- **EBI blacklists frequent tabix requests.** The Data_access page says so
  explicitly, and a Worker egresses from shared Cloudflare addresses, so a
  blacklisting would hit the whole fleet. Every FTP read goes through one
  rate-limit key at 2 s apart (`src/lib/http.ts`), the ~2 MB `.tbi` and the
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
  r7 `.credible_sets.tsv.gz` has **no `chromosome` and no `position`**; its 13
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

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from eQTL Catalogue and stays under the terms of that source: CC BY 4.0.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
