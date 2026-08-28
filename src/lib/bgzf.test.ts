import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	bgzfBlockSize,
	inflateBgzf,
	inflateGzipMember,
	isGzipMember,
	readBgzfLines,
	readGzipLines,
} from "./bgzf";

/** Build one BGZF member the way bgzip does: gzip + the "BC" extra subfield. */
function bgzfMember(payload: string): Uint8Array {
	const raw = Buffer.from(payload, "utf8");
	const deflated = zlib.deflateRawSync(raw);
	const total = 18 + deflated.length + 8;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	out.set([0x1f, 0x8b, 0x08, 0x04], 0);
	view.setUint32(4, 0, true);
	out[8] = 0;
	out[9] = 0xff;
	view.setUint16(10, 6, true);
	out.set([0x42, 0x43], 12);
	view.setUint16(14, 2, true);
	view.setUint16(16, total - 1, true);
	out.set(deflated, 18);
	view.setUint32(18 + deflated.length, zlib.crc32(raw), true);
	view.setUint32(22 + deflated.length, raw.length, true);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function bodyOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			// Hand the bytes over in small slices so the member-boundary
			// buffering is exercised, not bypassed by one big chunk.
			for (let at = 0; at < bytes.length; at += 7) {
				controller.enqueue(bytes.slice(at, at + 7));
			}
			controller.close();
		},
	});
}

describe("bgzfBlockSize", () => {
	it("reads BSIZE out of the BC extra subfield", () => {
		const member = bgzfMember("hello\n");
		expect(isGzipMember(member)).toBe(true);
		expect(bgzfBlockSize(member)).toBe(member.length);
	});

	it("returns undefined for a gzip member with no extra field", () => {
		const plain = new Uint8Array(zlib.gzipSync(Buffer.from("hello\n")));
		expect(isGzipMember(plain)).toBe(true);
		expect(bgzfBlockSize(plain)).toBeUndefined();
	});
});

describe("inflateGzipMember", () => {
	it("round-trips a single BGZF member", async () => {
		const out = await inflateGzipMember(bgzfMember("one\ttwo\n"));
		expect(new TextDecoder().decode(out)).toBe("one\ttwo\n");
	});
});

describe("inflateBgzf", () => {
	it("concatenates every complete member and drops a truncated tail", async () => {
		const first = bgzfMember("alpha\n");
		const second = bgzfMember("beta\n");
		const truncated = bgzfMember("gamma\n").subarray(0, 20);
		const out = await inflateBgzf(concat([first, second, truncated]));
		expect(new TextDecoder().decode(out)).toBe("alpha\nbeta\n");
	});

	it("honours maxBlocks so a header read costs one member", async () => {
		const out = await inflateBgzf(concat([bgzfMember("head\n"), bgzfMember("body\n")]), {
			maxBlocks: 1,
		});
		expect(new TextDecoder().decode(out)).toBe("head\n");
	});
});

describe("readBgzfLines", () => {
	it("emits lines across member boundaries", async () => {
		const bytes = concat([bgzfMember("a\tb\nc\t"), bgzfMember("d\ne\tf\n")]);
		const seen: string[] = [];
		await readBgzfLines(bodyOf(bytes), (line) => {
			seen.push(line);
		});
		expect(seen).toEqual(["a\tb", "c\td", "e\tf"]);
	});

	it("drops the carriage return of a CRLF file", async () => {
		// The eQTL Catalogue TSVs are CRLF-terminated; leaving the CR on
		// corrupts the last column of every row.
		const bytes = concat([bgzfMember("a\tb\r\nc\td\r\n")]);
		const seen: string[] = [];
		await readBgzfLines(bodyOf(bytes), (line) => {
			seen.push(line);
		});
		expect(seen).toEqual(["a\tb", "c\td"]);
	});

	it("stops as soon as the callback returns false", async () => {
		const bytes = concat([bgzfMember("1\n2\n3\n4\n")]);
		const seen: string[] = [];
		await readBgzfLines(bodyOf(bytes), (line) => {
			seen.push(line);
			return line !== "2";
		});
		expect(seen).toEqual(["1", "2"]);
	});
});

describe("readGzipLines", () => {
	it("drops the carriage return of a CRLF file", async () => {
		const gz = new Uint8Array(zlib.gzipSync(Buffer.from("h1\th2\r\nv1\tv2\r\n")));
		const seen: string[] = [];
		await readGzipLines(bodyOf(gz), (line) => {
			seen.push(line);
		});
		expect(seen).toEqual(["h1\th2", "v1\tv2"]);
	});

	it("streams a plain single-member gzip body", async () => {
		const gz = new Uint8Array(zlib.gzipSync(Buffer.from("h1\th2\nv1\tv2\n")));
		const seen: string[] = [];
		await readGzipLines(bodyOf(gz), (line) => {
			seen.push(line);
		});
		expect(seen).toEqual(["h1\th2", "v1\tv2"]);
	});
});
