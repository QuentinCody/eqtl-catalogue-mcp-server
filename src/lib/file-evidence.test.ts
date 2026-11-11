import { afterEach, expect, it, vi } from "vitest";
import { assertFileHash, assertSameFile, readFileEvidence } from "./file-evidence";

const url = "https://example.test/data.tsv.gz";
const range = { start: 10, end: 99 };
const headers = { "Content-Range": "bytes 10-12/13" };
const read = (response: Response, max = 100) => readFileEvidence(response, url, max, range);
afterEach(() => vi.useRealTimers());

it("accepts EOF-clipped ranges and hashes exactly the returned bytes", async () => {
  const result = await read(new Response("abc", { status: 206, headers }));
  expect(result.evidence).toMatchObject({ source_url: url, http_status: 206, byte_length: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    content_range: "bytes 10-12/13", hash_scope: "complete_response_bytes" });
  expect(new TextDecoder().decode(result.bytes)).toBe("abc");
  expect(() => assertFileHash(result.evidence, result.evidence.sha256)).not.toThrow();
  expect(() => assertFileHash(result.evidence, "0".repeat(64))).toThrow(/hash changed/);
  expect(() => assertSameFile({ ...result.evidence, etag: "old" }, { ...result.evidence, etag: "new" })).toThrow(/file changed/);
  expect(() => assertSameFile({ ...result.evidence, last_modified: "old" }, { ...result.evidence, last_modified: "new" })).toThrow(/file changed/);
});

it.each([
  { status: 200, headers },
  { status: 206, headers: {} },
  { status: 206, headers: { "Content-Range": "bytes 10-12/*" } },
  { status: 206, headers: { "Content-Range": "bytes 11-13/14" } },
  { status: 206, headers: { "Content-Range": "bytes 10-12/100" } },
  { status: 206, headers: { ...headers, "Content-Length": "2" } },
  { status: 206, headers: { ...headers, "Content-Length": "no" } },
  { status: 206, headers: { ...headers, "Content-Encoding": "gzip" } },
])("rejects and cancels invalid range responses: %j", async init => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), init);
  await expect(read(response)).rejects.toMatchObject({ status: 502 });
  expect(cancel).toHaveBeenCalledOnce();
});

it("rejects oversized and short bodies, including an undeclared index size", async () => {
  await expect(read(new Response("abc", { status: 206, headers }), 2)).rejects.toMatchObject({ status: 502 });
  for (const body of ["a", "abcd"]) {
    await expect(read(new Response(body, { status: 206, headers }))).rejects.toMatchObject({ status: 502 });
  }
  await expect(readFileEvidence(new Response("abcd"), url, 3)).rejects.toMatchObject({ status: 502 });
  await expect(readFileEvidence(new Response("abc", { status: 206 }), url, 3)).rejects.toMatchObject({ status: 502 });
  expect((await readFileEvidence(new Response("abc"), url, 3)).evidence.byte_length).toBe(3);
});

it("cancels a stalled body at its deadline and releases its reader", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { status: 206, headers });
  const rejection = expect(read(response)).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(15_000);
  await rejection;
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
