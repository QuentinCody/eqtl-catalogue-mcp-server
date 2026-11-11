"""Read-only, checksum-pinned eQTL Parquet query subprocess. No network or SQL.

Input is one JSON request on stdin; the manifest is operator-owned. Run through
serve.py to enforce a hard wall-clock limit even during Arrow native calls.
"""
import base64
import csv
import datetime
import decimal
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys

import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq

MAX_OUTPUT = 2 * 1024 * 1024
ROLES = {"all", "cc", "permuted", "credible_sets", "lbf_variable"}


class QueryError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def require(condition, message, status=400):
    if not condition:
        raise QueryError(message, status)


def read_json(path):
    with open(path, "rb") as stream:
        data = stream.read(MAX_OUTPUT + 1)
    require(len(data) <= MAX_OUTPUT, "manifest exceeds 2 MiB", 413)
    return json.loads(data)


def validate_request(request):
    require(isinstance(request, dict), "request must be an object")
    allowed = {"release", "dataset_id", "file_role", "metadata_sha256", "file_sha256", "operation", "filters", "max_rows"}
    require(set(request) == allowed, "request fields do not match the contract")
    require(request["release"] == "r8_beta", "release must be r8_beta")
    require(isinstance(request["dataset_id"], str) and re.fullmatch(r"QTD\d{6}", request["dataset_id"]), "invalid dataset ID")
    require(request["file_role"] in ROLES, "unsupported file role")
    for name in ("metadata_sha256", "file_sha256"):
        require(isinstance(request[name], str) and re.fullmatch(r"[a-f0-9]{64}", request[name]), "invalid checksum")
    require(request["operation"] in ("schema", "query"), "unsupported operation")
    require(type(request["max_rows"]) is int and 1 <= request["max_rows"] <= 5000, "max_rows must be 1..5000")
    require(isinstance(request["filters"], list) and len(request["filters"]) <= 20, "at most 20 predicates")
    require(request["operation"] != "schema" or not request["filters"], "schema does not accept predicates")


def resolve_entry(manifest_path, request):
    manifest = read_json(manifest_path)
    require(manifest.get("version") == 1 and isinstance(manifest.get("files"), list), "invalid manifest", 503)
    identity = ("release", "dataset_id", "file_role", "metadata_sha256", "file_sha256")
    matches = [entry for entry in manifest["files"] if all(entry.get(key) == request[key] for key in identity)]
    require(len(matches) == 1, "snapshot is missing or ambiguous", 404)
    entry = matches[0]
    require(entry.get("assembly") == "GRCh38", "unsupported assembly", 409)
    root = Path(manifest_path).resolve().parent
    # These paths come only from the operator manifest, never from requests.
    parquet_path = root / entry["path"]
    metadata_path = root / entry["metadata_path"]
    with open(metadata_path, "rb") as stream:
        metadata_bytes = stream.read(MAX_OUTPUT + 1)
    require(len(metadata_bytes) <= MAX_OUTPUT, "metadata exceeds 2 MiB", 413)
    require(hashlib.sha256(metadata_bytes).hexdigest() == request["metadata_sha256"], "metadata checksum mismatch", 409)
    reader = csv.DictReader(io.StringIO(metadata_bytes.decode("utf-8-sig")), delimiter="\t")
    require(reader.fieldnames and len(set(reader.fieldnames)) == len(reader.fieldnames), "invalid metadata header", 409)
    rows = [row for row in reader if row.get("dataset_id") == request["dataset_id"]]
    require(len(rows) == 1 and None not in rows[0] and None not in rows[0].values(), "dataset missing or ambiguous in metadata snapshot", 409)
    metadata = rows[0]
    require(re.fullmatch(r"QTS\d{6}", metadata.get("study_id", "")), "invalid study ID", 409)
    category = "susie" if request["file_role"] in ("credible_sets", "lbf_variable") else "sumstats"
    expected_url = ("https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/"
                    f"{category}/{metadata['study_id']}/{request['dataset_id']}/"
                    f"{request['dataset_id']}.{request['file_role']}.parquet")
    require(entry.get("source_url") == expected_url, "source URL does not match snapshot identity", 409)
    return entry, parquet_path, metadata


def predicate(schema, filters):
    result = None
    require(len(set(schema.names)) == len(schema.names), "duplicate Parquet column names", 409)
    for item in filters:
        require(isinstance(item, dict) and set(item) == {"column", "op", "value"}, "invalid predicate")
        name, op, value = item["column"], item["op"], item["value"]
        require(isinstance(name, str) and name in schema.names, "predicate column is absent; inspect schema")
        require(op in ("eq", "ge", "le"), "unsupported predicate operator")
        kind = schema.field(name).type
        if pa.types.is_dictionary(kind):
            kind = kind.value_type
        if pa.types.is_integer(kind):
            require((type(value) is int) or (isinstance(value, str) and re.fullmatch(r"-?\d+", value)), "integer predicate required")
            value = int(value)
        elif pa.types.is_floating(kind) or pa.types.is_decimal(kind):
            require(type(value) in (int, float, str), "numeric predicate required")
            value = decimal.Decimal(str(value)) if pa.types.is_decimal(kind) else float(value)
            require(math.isfinite(value), "finite predicate required")
        elif pa.types.is_string(kind) or pa.types.is_large_string(kind):
            require(isinstance(value, str) and len(value) <= 4096, "string predicate required")
        else:
            raise QueryError("predicate column type is unsupported; inspect schema")
        scalar = pa.scalar(value, type=kind)
        field = ds.field(name)
        expression = field == scalar if op == "eq" else field >= scalar if op == "ge" else field <= scalar
        result = expression if result is None else result & expression
    return result


def json_value(value):
    if isinstance(value, dict):
        return {key: json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if type(value) is int and abs(value) > 9007199254740991:
        return str(value)
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, bytes):
        return {"base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, (datetime.date, datetime.time, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return str(value)
    return value


def signature(stream):
    stat = os.fstat(stream.fileno())
    return stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def encoded_metadata(metadata):
    return [[base64.b64encode(k).decode(), base64.b64encode(v).decode()] for k, v in (metadata or {}).items()]


def execute(manifest_path, request):
    validate_request(request)
    entry, path, metadata = resolve_entry(manifest_path, request)
    with open(path, "rb") as stream:
        before = signature(stream)
        digest = hashlib.sha256()
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
        require(digest.hexdigest() == request["file_sha256"], "Parquet checksum mismatch", 409)
        stream.seek(0)
        parquet = pq.ParquetFile(stream)
        schema = parquet.schema_arrow
        condition = predicate(schema, request["filters"])
        result = {key: entry[key] for key in ("release", "dataset_id", "file_role", "metadata_sha256", "file_sha256", "assembly", "source_url")}
        result.update({"status": "pre-release", "metadata": metadata,
                       "retrieved_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       "coordinate_system": "GRCh38, 1-based inclusive; chromosome values match file exactly",
                       "schema": [{"name": field.name, "type": str(field.type), "nullable": field.nullable,
                                   "metadata": encoded_metadata(field.metadata)} for field in schema],
                       "schema_metadata": encoded_metadata(schema.metadata),
                       "encoding": "Unsafe JS integers and decimals are strings; nonfinite floats are strings; binary uses base64 objects; timestamps use ISO 8601. No deduplication or aggregation."})
        if request["operation"] == "query":
            rows = []
            truncated = False
            reason = None
            used = len(json.dumps(result, ensure_ascii=False).encode())
            # Same open descriptor as checksum verification: replacing the path cannot
            # substitute a different file after validation. Row batches bound buffering;
            # the service subprocess timeout bounds native reads and scans.
            scanner = ds.Scanner.from_batches(parquet.iter_batches(batch_size=256, use_threads=False), schema=schema, filter=condition, use_threads=False)
            for batch in scanner.to_batches():
                for raw in batch.to_pylist():
                    if len(rows) == request["max_rows"]:
                        truncated, reason = True, "max_rows"
                        break
                    row = json_value(raw)
                    size = len(json.dumps(row, ensure_ascii=False).encode()) + 2
                    if used + size > MAX_OUTPUT - 4096:
                        truncated, reason = True, "response_bytes"
                        break
                    used += size
                    rows.append(row)
                if truncated:
                    break
            result.update(rows=rows, row_count=len(rows), truncated=truncated, truncation_reason=reason,
                          filters=request["filters"], total_matching_rows=None)
        require(signature(stream) == before, "Parquet file changed during query", 409)
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
    require(len(encoded.encode()) <= MAX_OUTPUT, "result schema exceeds byte budget", 413)
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(64 * 1024 + 1)
        require(len(raw) <= 64 * 1024, "request exceeds 64 KiB", 413)
        result = execute(sys.argv[1], json.loads(raw))
        print(json.dumps({"status": 200, "data": result}, ensure_ascii=False, allow_nan=False))
    except QueryError as error:
        print(json.dumps({"status": error.status, "error": str(error)}))
    except Exception:
        # Do not disclose local paths, stack traces or file contents over HTTP.
        print(json.dumps({"status": 400, "error": "Invalid request, manifest or Parquet data"}))


if __name__ == "__main__":
    main()
