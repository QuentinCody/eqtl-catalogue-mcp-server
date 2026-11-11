import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileEvidence } from "./file-evidence";
import { boundedText } from "./release";

afterEach(() => vi.useRealTimers());
describe("eQTL body deadlines", () => {
  it.each(["text", "file"])("terminates stalled %s reads even when cancellation never settles", async kind => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel }));
    const run = kind === "text" ? boundedText(response) : readFileEvidence(response, "https://example.org/file", 100);
    const check = expect(run).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(25_001);
    await check;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("rejects partial metadata while preserving its original body", async () => {
    await expect(boundedText(new Response("native\tbytes\n", { status: 206, headers: { "content-range": "bytes 0-12/100" } })))
      .rejects.toMatchObject({ status: 502, data: { response: "native\tbytes\n", http_status: 206 } });
  });

  it("does not wait for cancellation after rejecting oversized metadata", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("abcdef")); },
      cancel: () => new Promise<void>(() => {}),
    }));
    await expect(boundedText(response, 5)).rejects.toMatchObject({ status: 502 });
  });
});
