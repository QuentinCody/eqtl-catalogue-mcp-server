"""Synthetic Parquet tests; these do not assert live r8 file schemas."""
import hashlib
import io
import json
from email.message import Message
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

import pyarrow as pa
import pyarrow.parquet as pq

from query import execute, QueryError, MAX_OUTPUT
from serve import run_query, handler
from register import register


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.metadata = b"study_id\tdataset_id\tstudy_label\tsample_size\textra\nQTS000015\tQTD000116\tGTEx_v10\t711\tretained\n"
        (self.root / "metadata.tsv").write_bytes(self.metadata)
        self.rows = [{"chromosome": "chr1", "position": 100, "pip": .9, "rsid": "rs1", "large_id": 9007199254740993},
                     {"chromosome": "chr1", "position": 100, "pip": .9, "rsid": "rs2", "large_id": 9007199254740993},
                     {"chromosome": "chr1", "position": 200, "pip": .1, "rsid": None, "large_id": 1}]
        self.write_rows(self.rows)

    def write_rows(self, rows):
        table = pa.Table.from_pylist(rows).replace_schema_metadata({b"fixture": b"synthetic"})
        pq.write_table(table, self.root / "fixture.parquet", row_group_size=1)
        self.request = {"release": "r8_beta", "dataset_id": "QTD000116", "file_role": "credible_sets",
                        "metadata_sha256": hashlib.sha256(self.metadata).hexdigest(),
                        "file_sha256": hashlib.sha256((self.root / "fixture.parquet").read_bytes()).hexdigest(),
                        "operation": "query", "filters": [], "max_rows": 500}
        entry = {key: self.request[key] for key in ("release", "dataset_id", "file_role", "metadata_sha256", "file_sha256")}
        entry.update(assembly="GRCh38", path="fixture.parquet", metadata_path="metadata.tsv",
                     source_url="https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/susie/QTS000015/QTD000116/QTD000116.credible_sets.parquet")
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(json.dumps({"version": 1, "files": [entry]}))

    def query(self, **changes):
        return execute(self.manifest, {**self.request, **changes})

    def test_preserves_multirsid_rows_precision_null_and_metadata(self):
        result = self.query()
        self.assertEqual([row["rsid"] for row in result["rows"]], ["rs1", "rs2", None])
        self.assertEqual(result["rows"][0]["large_id"], "9007199254740993")
        self.assertEqual(result["metadata"]["study_label"], "GTEx_v10")
        self.assertEqual(result["metadata"]["extra"], "retained")
        self.assertEqual(result["file_sha256"], self.request["file_sha256"])
        self.assertFalse(result["truncated"])
        self.assertIsNone(result["total_matching_rows"])

    def test_filters_actual_coordinate_and_pip_columns(self):
        result = self.query(filters=[{"column": "position", "op": "le", "value": 100}, {"column": "pip", "op": "ge", "value": .5}])
        self.assertEqual(result["row_count"], 2)
        self.assertFalse(result["truncated"])

    def test_schema_without_rows(self):
        result = self.query(operation="schema")
        self.assertNotIn("rows", result)
        self.assertEqual(result["schema"][1]["name"], "position")
        self.assertEqual(result["schema"][1]["type"], "int64")
        self.assertTrue(result["schema_metadata"])

    def test_absent_column_is_error_not_empty_evidence(self):
        with self.assertRaisesRegex(QueryError, "column is absent"):
            self.query(filters=[{"column": "region", "op": "eq", "value": "chr1:1-200"}])

    def test_row_cap_distinguishes_exact_result_from_truncation(self):
        self.assertTrue(self.query(max_rows=2)["truncated"])
        self.assertFalse(self.query(max_rows=3)["truncated"])

    def test_response_byte_cap_is_explicit(self):
        self.write_rows([{"payload": "é" * (MAX_OUTPUT // 2)}])
        result = self.query()
        self.assertEqual(result["row_count"], 0)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["truncation_reason"], "response_bytes")

    def test_metadata_drift(self):
        (self.root / "metadata.tsv").write_bytes(self.metadata.replace(b"711", b"493"))
        with self.assertRaisesRegex(QueryError, "metadata checksum"):
            self.query()

    def test_file_drift(self):
        with (self.root / "fixture.parquet").open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(QueryError, "Parquet checksum"):
            self.query()

    def test_snapshot_is_not_silently_replaced(self):
        with self.assertRaisesRegex(QueryError, "missing or ambiguous"):
            self.query(file_sha256="f" * 64)

    def test_rejects_sql_paths_and_invalid_values(self):
        for changes in ({"sql": "SELECT *"}, {"path": "/etc/passwd"}, {"release": "r7"}, {"max_rows": True}, {"max_rows": 5001},
                        {"filters": [{"column": "position", "op": "eq", "value": 100.5}]},
                        {"filters": [{"column": "pip", "op": "ge", "value": "nan"}]}):
            with self.subTest(changes=changes), self.assertRaises(QueryError):
                self.query(**changes)

    def test_subprocess_returns_real_query_and_no_local_paths(self):
        status, result = run_query(self.manifest, json.dumps(self.request).encode())
        self.assertEqual(status, 200)
        self.assertEqual(result["row_count"], 3)
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_timeout_does_not_report_empty_complete(self):
        with patch("serve.subprocess.run", side_effect=subprocess.TimeoutExpired("query", 30)):
            status, result = run_query(self.manifest, b"{}")
        self.assertEqual(status, 504)
        self.assertNotIn("rows", result)

    def test_registration_validates_then_preserves_existing_snapshots(self):
        manifest = self.root / "imported.json"
        url = "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/susie/QTS000015/QTD000116/QTD000116.credible_sets.parquet"
        result = register(manifest, self.root / "metadata.tsv", self.root / "fixture.parquet", url, self.request["file_sha256"])
        self.assertEqual(result["file_sha256"], self.request["file_sha256"])
        original = manifest.read_bytes()
        with self.assertRaisesRegex(QueryError, "already registered"):
            register(manifest, self.root / "metadata.tsv", self.root / "fixture.parquet", url)
        self.assertEqual(manifest.read_bytes(), original)
        with self.assertRaisesRegex(QueryError, "checksum differs"):
            register(manifest, self.root / "metadata.tsv", self.root / "fixture.parquet", url, "0" * 64)
        self.assertEqual(manifest.read_bytes(), original)

    def test_failed_registration_does_not_publish_manifest(self):
        manifest = self.root / "imported.json"
        url = "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/sumstats/QTS000099/QTD000116/QTD000116.all.parquet"
        with self.assertRaisesRegex(QueryError, "source URL"):
            register(manifest, self.root / "metadata.tsv", self.root / "fixture.parquet", url)
        self.assertFalse(manifest.exists())

    def test_http_auth_and_request_limits_without_listener(self):
        token = "synthetic-test-secret" * 2
        Handler = handler(self.manifest, token)
        for authorization, lengths, expected in [("wrong", ["2"], 401), (f"Bearer {token}", ["65537"], 413), (f"Bearer {token}", ["2", "2"], 400)]:
            instance = object.__new__(Handler)
            instance.path = "/query"
            instance.headers = Message()
            instance.headers["Authorization"] = authorization
            for length in lengths:
                instance.headers["Content-Length"] = length
            instance.rfile = io.BytesIO(b"{}")
            responses = []
            instance.send_json = lambda status, data: responses.append((status, data))
            with patch("serve.run_query") as query:
                instance.do_POST()
                query.assert_not_called()
            self.assertEqual(responses[0][0], expected)


if __name__ == "__main__":
    unittest.main()
