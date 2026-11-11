import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bio-mcp/shared/adapters/eqtl/http", () => ({ ebiFileFetch: vi.fn() }));

import { ebiFileFetch } from "./http";
import { readTsvGz } from "./sumstats";

const url = "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/example.permuted.tsv.gz";
const serve = (text: string | Uint8Array, headers = {}) => {
  const bytes = gzipSync(text);
  vi.mocked(ebiFileFetch).mockResolvedValue(new Response(bytes, { headers }));
  return bytes;
};
beforeEach(() => vi.resetAllMocks());

describe("complete compressed file evidence", () => {
  it("retains original precision, NA and row order separately from numeric projections", async () => {
    const text = "molecular_trait_id\tp_beta\tbeta\nENSG1\t1.00000000000000001e-310\tNA\nENSG1\t1.00000000000000001e-310\tNA\n";
    const bytes = serve(text, { etag: '"native"' });
    const result = await readTsvGz({ url });
    expect(result.raw_rows).toEqual(text.trimEnd().split("\n").slice(1));
    expect(result.rows).toEqual([{ molecular_trait_id: "ENSG1", p_beta: 1e-310, beta: null }, { molecular_trait_id: "ENSG1", p_beta: 1e-310, beta: null }]);
    expect(result.native_header).toBe("molecular_trait_id\tp_beta\tbeta");
    expect(result.file_evidence).toMatchObject({ sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length, hash_scope: "complete_response_bytes", etag: '"native"' });
    expect(result.coverage_complete).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("does not manufacture zero from an empty numeric filter value", async () => {
    serve("id\tp_beta\na\t\nb\tNA\nc\t0\nd\t0.01\n");
    const result = await readTsvGz({ url, numericMax: { column: "p_beta", value: 0 } });
    expect(result.rows).toEqual([{ id: "c", p_beta: 0 }]);
    expect(result.raw_rows).toEqual(["c\t0"]);
  });

  it("hashes the complete compressed file even when the decoded row cap stops early", async () => {
    const bytes = serve("id\tp_beta\na\t0.01\nb\t0.02\nc\t0.03\n");
    const result = await readTsvGz({ url, maxRows: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.file_evidence.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it.each([
    ["id\tid\na\tb\n", "duplicate TSV columns"],
    ["id\tp_beta\na\n", "malformed complete TSV row"],
    ["id\tp_beta\na\tb\tc\n", "malformed complete TSV row"],
    [`id\n${"x".repeat(1024 * 1024 + 1)}\n`, "line exceeds 1 MiB"],
  ])("rejects malformed tables without reporting absence", async (text, message) => {
    serve(text);
    await expect(readTsvGz({ url })).rejects.toThrow(message);
  });

  it("rejects invalid UTF-8", async () => {
    serve(new Uint8Array([105, 100, 10, 255, 10]));
    await expect(readTsvGz({ url })).rejects.toThrow();
  });

  it("rejects a partial HTTP 200 as complete file evidence", async () => {
    serve("id\na\n", { "content-range": "bytes 0-9/100" });
    await expect(readTsvGz({ url })).rejects.toMatchObject({ status: 502 });
  });
});
