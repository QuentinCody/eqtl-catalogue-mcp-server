# eQTL Parquet query service

This service reads operator-imported local r8 beta files. It has no download,
arbitrary SQL, caller-selected URL, or caller-selected filesystem path endpoint.
Python 3.10+ and PyArrow 19.0.0 are the tested runtime (exact dependency in
`requirements.txt`). The committed tests use synthetic files; they do not validate
EBI's live schemas or throughput. No service is deployed by adding this directory.

An October 4, 2026 offline acceptance run used complete official QTD000116
`permuted` (22,748 rows) and `credible_sets` (274,812 rows) Parquet downloads with
the matching original r8 beta metadata. Registration, schema reads, 1,000-row
caps and exact-trait queries (1 and 51 rows) matched independent PyArrow reads;
wrong hashes and missing columns failed explicitly. The temporary registry was
removed after the run. File hashes and native schemas are retained in
`scratch/2026-10-04-eqtl/parquet-acceptance.json`. The larger `all`, `cc` and
`lbf_variable` files were not downloaded or queried. HTTPS service integration,
operator memory limits and production throughput remain unverified.

1. Discover the desired file using the MCP `/datasets/{id}/files` route with
   `release: "r8_beta"`. Download the exact official URL externally, plus the
   matching [metadata TSV](https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/master/data_tables/dataset_metadata_r8_beta.tsv).
   Retain both files, ideally in a read-only snapshot directory. The pre-release
   metadata can change during a download; compare the MCP metadata checksum with
   the importer output and resolve any mismatch before using the snapshot.
2. Register one file (repeat serially for additional datasets/roles). Existing
   different-checksum snapshots are retained; duplicate identities are rejected.

   ```bash
   python3 backend/register.py /srv/eqtl/manifest.json \
     /srv/eqtl/snapshot/dataset_metadata_r8_beta.tsv \
     /srv/eqtl/snapshot/QTD000116.all.parquet \
     https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/sumstats/QTS000015/QTD000116/QTD000116.all.parquet
   ```

   `--expected-file-sha256 <hash>` additionally checks a previously known checksum.
   The import result contains the hashes needed by Code Mode plus the actual schema.
   The local hash proves byte identity on subsequent calls; it is not an EBI
   signature or proof that an arbitrary local file originated at the supplied URL.
   Only register complete official per-dataset files, not locally derived subsets.
   Store imports outside the repository. No sample manifest with fabricated hashes
   is supplied. The manifest stores absolute local paths and is operator-only.
3. Provision `EQTL_PARQUET_TOKEN` securely in the service environment (at least
   32 characters), then run:

   ```bash
   python3 backend/serve.py /srv/eqtl/manifest.json --host 127.0.0.1 --port 8098
   ```

   Put an HTTPS reverse proxy in front of `/query`, with request/queue limits.
   Set a container/process memory limit appropriate for the imported schemas
   (start with 2 GiB and measure). Native Arrow decompression can allocate memory
   before a batch becomes visible to Python; row caps alone do not cap memory.
   Use a read-only data mount and an unprivileged runtime account. The service
   processes one query at a time, kills its child after 30 seconds and does not
   expose local error traces. Reverse-proxy timeout should exceed 35 seconds.
4. Set the Worker `EQTL_PARQUET_URL` to the full HTTPS `/query` endpoint and
   `EQTL_PARQUET_TOKEN` to the same secret. Keep both out of Code Mode programs.
The Worker refuses redirects and checks returned snapshot identity. Deploy
only after testing real imported files through the Worker.

The Worker requires HTTP 200 with JSON and no Content-Range, and applies one
35-second deadline to connection and body reads. Requests are capped at 64 KiB;
responses at 2 MiB. Backend error bodies are discarded, including partial or
malformed responses. Invalid UTF-8, malformed JSON and credential-bearing JSON
produce sanitized errors. Cancellation never extends the response deadline.
Returned metadata must identify the requested dataset and its exact study/file
URL. Query filter echoes, schema columns, complete row column sets and truncation
evidence must agree with the request and backend contract. These consistency
checks do not independently establish that a backend applied each predicate;
native-file comparisons remain necessary.

Every query hashes the complete Parquet file before scanning, then uses the same
open file descriptor to avoid path-replacement races. It checks file size/mtime/ctime
again after the read. Metadata is hashed and parsed from the same bytes. The service
does not silently query the latest metadata when an older checksum is requested.
Hashing and scanning large files can exceed the deadline; use offline analysis in
that case. No partial timeout response is presented as a complete empty result.

The query payload has exactly these fields: `release`, `dataset_id`, `file_role`,
`metadata_sha256`, `file_sha256`, `operation` (`schema` or `query`), `filters`
(`[{column, op: "eq"|"ge"|"le", value}]`, at most 20), and `max_rows` (1–5000).
Predicates are checked against the observed Arrow schema. All returned columns
remain present; duplicates and nulls are retained. Result encoding is documented
in `encoding`; schema and field metadata use arrays of base64 key/value pairs.
The response is at most 2 MiB, with `truncated`, `truncation_reason`, and no claimed
total match count. The Worker stages results above 30 KiB.

Run local tests without starting a listener:

```bash
python3 -m unittest discover -s backend -v
```

The fixture suite verifies actual Parquet reads, hash mismatches, release identity,
filter validation, precision, duplicate rows, truncation, atomic registration, and
subprocess timeout handling. Live upstream-file and HTTPS integration checks remain
separate deployment prerequisites.
