import { describe, expect, it } from "vitest";
import {
	compressedOffset,
	parseTabixIndex,
	queryChunks,
	reg2bins,
	resolveReferenceName,
	uncompressedOffset,
} from "./tabix";

interface BinSpec {
	bin: number;
	chunks: Array<{ begin: number; end: number }>;
}

/** Build a one-reference .tbi body matching htslib's tbi_index layout. */
function tabixIndex(name: string, bins: BinSpec[], intervals: number[]): Uint8Array {
	const nameBytes = new TextEncoder().encode(`${name}\0`);
	const binBytes = bins.reduce((sum, spec) => sum + 8 + spec.chunks.length * 16, 0);
	const total = 36 + nameBytes.length + 4 + binBytes + 4 + intervals.length * 8;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);

	out.set([0x54, 0x42, 0x49, 0x01], 0); // "TBI\1"
	view.setInt32(4, 1, true); // n_ref
	view.setInt32(8, 0, true); // format (generic, position only)
	view.setInt32(12, 1, true); // col_seq
	view.setInt32(16, 2, true); // col_beg
	view.setInt32(20, 0, true); // col_end
	view.setInt32(24, "#".charCodeAt(0), true); // meta
	view.setInt32(28, 1, true); // skip
	view.setInt32(32, nameBytes.length, true);
	out.set(nameBytes, 36);

	let at = 36 + nameBytes.length;
	view.setInt32(at, bins.length, true);
	at += 4;
	for (const spec of bins) {
		view.setUint32(at, spec.bin, true);
		at += 4;
		view.setInt32(at, spec.chunks.length, true);
		at += 4;
		for (const chunk of spec.chunks) {
			view.setBigUint64(at, BigInt(chunk.begin), true);
			view.setBigUint64(at + 8, BigInt(chunk.end), true);
			at += 16;
		}
	}
	view.setInt32(at, intervals.length, true);
	at += 4;
	for (const interval of intervals) {
		view.setBigUint64(at, BigInt(interval), true);
		at += 8;
	}
	return out;
}

const virtualOffset = (block: number, inside: number) => block * 65536 + inside;

describe("reg2bins", () => {
	it("covers the five binning levels for a point query", () => {
		const bins = reg2bins(46120611, 46120612);
		expect(bins).toContain(0);
		expect(bins).toContain(1 + (46120611 >> 26));
		expect(bins).toContain(4681 + (46120611 >> 14));
		expect(bins).toHaveLength(6);
	});
});

describe("virtual offsets", () => {
	it("splits into a block offset and an offset inside the block", () => {
		const vo = virtualOffset(121712780, 12345);
		expect(compressedOffset(vo)).toBe(121712780);
		expect(uncompressedOffset(vo)).toBe(12345);
	});
});

describe("parseTabixIndex", () => {
	it("reads the header, reference names, bins, and linear index", () => {
		const index = parseTabixIndex(
			tabixIndex(
				"20",
				[{ bin: 4681 + (46120611 >> 14), chunks: [{ begin: 100, end: 200 }] }],
				[64],
			),
		);
		expect(index.colSeq).toBe(1);
		expect(index.colBeg).toBe(2);
		expect(index.meta).toBe("#");
		expect(index.skip).toBe(1);
		expect(index.names).toEqual(["20"]);
		expect(index.refs.get("20")?.intervals).toEqual([64]);
	});

	it("rejects a body that is not a TBI index", () => {
		expect(() => parseTabixIndex(new Uint8Array(64))).toThrow(/bad magic/);
	});
});

describe("resolveReferenceName", () => {
	it("accepts the indexed name with or without a chr prefix", () => {
		const index = parseTabixIndex(tabixIndex("20", [], [0]));
		expect(resolveReferenceName(index, "20")).toBe("20");
		expect(resolveReferenceName(index, "chr20")).toBe("20");
		expect(resolveReferenceName(index, "21")).toBeUndefined();
	});
});

describe("queryChunks", () => {
	const position = 46120612;
	const leafBin = 4681 + ((position - 1) >> 14);

	it("drops chunks that end before the linear index offset", () => {
		const stale = { begin: virtualOffset(10, 0), end: virtualOffset(20, 0) };
		const live = { begin: virtualOffset(400, 0), end: virtualOffset(401, 0) };
		const index = parseTabixIndex(
			tabixIndex("20", [{ bin: leafBin, chunks: [stale, live] }], [virtualOffset(300, 0)]),
		);
		// The linear index only holds one 16 kb window, so every query clamps to
		// it; the stale chunk must not survive.
		const chunks = queryChunks(index.refs.get("20")!, position - 1, position);
		expect(chunks).toEqual([live]);
	});

	it("merges chunks that land in the same BGZF member", () => {
		const index = parseTabixIndex(
			tabixIndex(
				"20",
				[
					{
						bin: leafBin,
						chunks: [
							{ begin: virtualOffset(400, 0), end: virtualOffset(400, 500) },
							{ begin: virtualOffset(400, 500), end: virtualOffset(400, 900) },
						],
					},
				],
				[0],
			),
		);
		const chunks = queryChunks(index.refs.get("20")!, position - 1, position);
		expect(chunks).toEqual([{ begin: virtualOffset(400, 0), end: virtualOffset(400, 900) }]);
	});

	it("returns nothing when no bin covers the window", () => {
		const index = parseTabixIndex(
			tabixIndex("20", [{ bin: leafBin, chunks: [{ begin: 1, end: 2 }] }], [0]),
		);
		const far = 1_000_000;
		expect(queryChunks(index.refs.get("20")!, far, far + 1)).toEqual([]);
	});
});
