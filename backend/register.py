"""Register already downloaded official files; never download or infer an asset.

The supplied source URL must come from the server's /files listing. Metadata and
Parquet paths remain operator-managed and must be retained for pinned queries.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from query import execute, QueryError, read_json, require


def digest_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def register(manifest_path, metadata_path, parquet_path, source_url, expected_file_sha256=None):
    match = re.fullmatch(r"https://ftp\.ebi\.ac\.uk/pub/databases/spot/eQTL/r8_beta/(sumstats|susie)/(QTS\d{6})/(QTD\d{6})/\3\.(all|cc|permuted|credible_sets|lbf_variable)\.parquet", source_url)
    require(match is not None, "source_url must be a discovered official dataset Parquet URL")
    manifest_path = Path(manifest_path).resolve()
    metadata_path, parquet_path = Path(metadata_path).resolve(), Path(parquet_path).resolve()
    file_hash = digest_file(parquet_path)
    require(expected_file_sha256 is None or file_hash == expected_file_sha256, "download checksum differs from expected file checksum", 409)
    entry = {"release": "r8_beta", "dataset_id": match[3], "file_role": match[4], "assembly": "GRCh38",
             "source_url": source_url, "metadata_sha256": digest_file(metadata_path), "file_sha256": file_hash,
             "path": str(parquet_path), "metadata_path": str(metadata_path)}
    manifest = read_json(manifest_path) if manifest_path.exists() else {"version": 1, "files": []}
    require(manifest.get("version") == 1 and isinstance(manifest.get("files"), list), "invalid manifest")
    identity = ("release", "dataset_id", "file_role", "metadata_sha256", "file_sha256")
    require(not any(all(old.get(k) == entry[k] for k in identity) for old in manifest["files"]), "snapshot already registered; existing manifest preserved", 409)
    manifest["files"].append(entry)
    # Validate actual metadata identity, source path and actual Parquet schema before
    # the atomic replacement. Operators must serialize registration operations.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=manifest_path.parent, suffix=".json", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(manifest, stream)
    try:
        request = {key: entry[key] for key in identity}
        request.update(operation="schema", filters=[], max_rows=1)
        result = execute(temporary, request)
        os.replace(temporary, manifest_path)
        return result
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("parquet", type=Path)
    parser.add_argument("source_url")
    parser.add_argument("--expected-file-sha256")
    args = parser.parse_args()
    try:
        print(json.dumps(register(args.manifest, args.metadata, args.parquet, args.source_url, args.expected_file_sha256)))
    except QueryError as error:
        parser.error(str(error))
