import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EqtlDataset } from "./ftp-catalogue";

// The unit under test is the reader, so its one I/O dependency is injected.
// Everything below the mock — BGZF framing, the tabix index, line splitting,
// filtering — is the real code.
vi.mock("@bio-mcp/shared/adapters/eqtl/http", () => ({ ebiFileFetch: vi.fn() }));

import { ebiFileFetch } from "./http";
import { createIndexedFileReader } from "./indexed-file";
import { queryRegion, readTsvGz, resetFileCaches } from "./sumstats";

const fetchMock = vi.mocked(ebiFileFetch);

// ── Fixtures ─────────────────────────────────────────────────────────────

/** Build one BGZF member the way bgzip does: gzip + the "BC" extra subfield. */
function bgzfMember(payload: Uint8Array): Uint8Array {
	const raw = Buffer.from(payload);
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

interface BinSpec {
	bin: number;
	chunks: Array<{ begin: number; end: number }>;
}

/** A one-reference .tbi body in htslib's tbi_index layout. */
function tabixIndexBody(
	name: string,
	bins: BinSpec[],
	intervals: number[],
	colSeq: number,
	colBeg: number,
): Uint8Array {
	const nameBytes = new TextEncoder().encode(`${name}\0`);
	const binBytes = bins.reduce((sum, spec) => sum + 8 + spec.chunks.length * 16, 0);
	const total = 36 + nameBytes.length + 4 + binBytes + 4 + intervals.length * 8;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);

	out.set([0x54, 0x42, 0x49, 0x01], 0); // "TBI\1"
	view.setInt32(4, 1, true); // n_ref
	view.setInt32(8, 0, true); // format
	view.setInt32(12, colSeq, true);
	view.setInt32(16, colBeg, true);
	view.setInt32(20, 0, true); // col_end
	view.setInt32(24, "#".charCodeAt(0), true);
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

/** The catalogue's real 19-column nominal header, in the published order. */
const NOMINAL_COLUMNS = [
	"molecular_trait_id",
	"chromosome",
	"position",
	"ref",
	"alt",
	"variant",
	"ma_samples",
	"maf",
	"pvalue",
	"beta",
	"se",
	"type",
	"ac",
	"an",
	"r2",
	"molecular_trait_object_id",
	"gene_id",
	"median_tpm",
	"rsid",
];

function nominalRow(position: number, rsid: string): string {
	return [
		"ENSG00000062598",
		"20",
		String(position),
		"T",
		"C",
		`chr20_${position}_T_C`,
		"100",
		"0.3",
		"0.220888",
		"0.1",
		"0.05",
		"SNP",
		"60",
		"200",
		"0.99",
		"ENSG00000062598",
		"ENSG00000062598",
		"12.5",
		rsid,
	].join("\t");
}

const WINDOW_START = 46120612;
const LEAF_BIN = 4681 + ((WINDOW_START - 1) >> 14);
const ENCODER = new TextEncoder();

const SUMSTATS_URL =
	"https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/sumstats/QTS000002/QTD000021/QTD000021.all.tsv.gz";

const DATASET = {
	dataset_id: "QTD000021",
	sumstats_url: SUMSTATS_URL,
	sumstats_index_url: `${SUMSTATS_URL}.tbi`,
} as EqtlDataset;

/**
 * A two-member BGZF file: the header line alone, then the data block the
 * index points at. The files upstream are CRLF-terminated, so this one is too.
 */
function buildSumstatsFile(customRows?: string[]): { bytes: Uint8Array; dataOffset: number; dataLength: number } {
	const header = bgzfMember(ENCODER.encode(`${NOMINAL_COLUMNS.join("\t")}\r\n`));
	const dataText = (customRows ?? [
		nominalRow(WINDOW_START, "rs4239702"),
		nominalRow(WINDOW_START + 1, "rs11121529"),
		nominalRow(WINDOW_START + 400, "rs00000000"),
	])
		.map((row) => `${row}\r\n`)
		.join("");
	const data = bgzfMember(ENCODER.encode(dataText));
	const bytes = new Uint8Array(header.length + data.length);
	bytes.set(header, 0);
	bytes.set(data, header.length);
	return { bytes, dataOffset: header.length, dataLength: dataText.length };
}

const FILE = buildSumstatsFile();

function tbiFor(bins: BinSpec[]): Uint8Array {
	return bgzfMember(tabixIndexBody("20", bins, [0], 2, 3));
}

const COVERING_BINS: BinSpec[] = [
	{
		bin: LEAF_BIN,
		chunks: [
			{
				begin: FILE.dataOffset * 65536,
				end: FILE.dataOffset * 65536 + FILE.dataLength,
			},
		],
	},
];

/** Serve the synthesized index and file, honouring the Range the reader asks for. */
function serveSumstats(bins: BinSpec[] = COVERING_BINS, file = FILE): void {
	const tbi = tbiFor(bins);
	fetchMock.mockImplementation(async (url: string, opts?: { range?: { start: number; end?: number } }) => {
		if (url.endsWith(".tbi")) return new Response(tbi.slice());
		const range = opts?.range;
		const slice = range
			? file.bytes.slice(range.start, range.end === undefined ? undefined : range.end + 1)
			: file.bytes.slice();
		return new Response(slice, range ? { status: 206, headers: {
			"Content-Range": `bytes ${range.start}-${Math.min(range.end ?? file.bytes.length - 1, file.bytes.length - 1)}/${file.bytes.length}`,
		} } : undefined);
	});
}

function gzipTsv(lines: string[]): Uint8Array {
	return new Uint8Array(zlib.gzipSync(Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8")));
}

/** The real 13 columns of a SuSiE .credible_sets.tsv.gz — no chromosome, no position. */
const CREDIBLE_SET_COLUMNS = [
	"molecular_trait_id",
	"gene_id",
	"cs_id",
	"variant",
	"rsid",
	"cs_size",
	"pip",
	"pvalue",
	"beta",
	"se",
	"z",
	"cs_min_r2",
	"region",
];

const CREDIBLE_SETS_URL =
	"https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/susie/QTS000002/QTD000021/QTD000021.credible_sets.tsv.gz";

function serveCredibleSets(): void {
	const body = gzipTsv([
		CREDIBLE_SET_COLUMNS.join("\t"),
		[
			"ENSG00000054523",
			"ENSG00000054523",
			"ENSG00000054523_L1",
			"chr1_10230108_G_A",
			"rs11121529",
			"3",
			"1",
			"1.2e-20",
			"0.5",
			"0.05",
			"10",
			"0.8",
			"chr1:9210570-11210570",
		].join("\t"),
		[
			"ENSG00000000001",
			"ENSG00000000001",
			"ENSG00000000001_L1",
			"chr1_10230999_C_T",
			"rs99999999",
			"2",
			"0.42",
			"3.0e-06",
			"0.2",
			"0.06",
			"3",
			"0.7",
			"chr1:9210570-11210570",
		].join("\t"),
	]);
	fetchMock.mockImplementation(async () => new Response(body.slice()));
}

beforeEach(() => {
	resetFileCaches();
	fetchMock.mockReset();
});

// ── readTsvGz ────────────────────────────────────────────────────────────

describe("readTsvGz", () => {
	it("reads the columns from the file's own header and coerces the numeric ones", async () => {
		serveCredibleSets();
		const result = await readTsvGz({ url: CREDIBLE_SETS_URL });
		expect(result.columns).toEqual(CREDIBLE_SET_COLUMNS);
		expect(result.row_count).toBe(2);
		// CRLF stripped: the last column must not carry a trailing \r.
		expect(result.rows[0].region).toBe("chr1:9210570-11210570");
		expect(result.rows[0].pip).toBe(1);
		expect(result.rows[0].rsid).toBe("rs11121529");
	});

	it("applies an equality filter the file does carry", async () => {
		serveCredibleSets();
		const result = await readTsvGz({
			url: CREDIBLE_SETS_URL,
			rowFilters: { rsid: "rs11121529" },
		});
		expect(result.rows.map((row) => row.molecular_trait_id)).toEqual(["ENSG00000054523"]);
	});

	// THE regression gate. A filter naming a column the file does not have used
	// to drop every row and answer row_count 0 with success — a manufactured
	// absence over data that is really there.
	it("refuses a filter naming a column the file does not have", async () => {
		serveCredibleSets();
		await expect(
			readTsvGz({ url: CREDIBLE_SETS_URL, rowFilters: { chromosome: "1" } }),
		).rejects.toMatchObject({ status: 400 });

		serveCredibleSets();
		await expect(
			readTsvGz({ url: CREDIBLE_SETS_URL, rowFilters: { chromosome: "1" } }),
		).rejects.toThrow(/has no column "chromosome"[\s\S]*molecular_trait_id[\s\S]*region/);
	});

	it("refuses a numeric bound naming a column the file does not have", async () => {
		serveCredibleSets();
		await expect(
			readTsvGz({ url: CREDIBLE_SETS_URL, numericMin: { column: "posterior_mean", value: 1 } }),
		).rejects.toMatchObject({ status: 400 });
	});

	it("keeps a real empty result empty when the filter column exists", async () => {
		serveCredibleSets();
		const result = await readTsvGz({
			url: CREDIBLE_SETS_URL,
			rowFilters: { rsid: "rs_not_in_this_file" },
		});
		expect(result.row_count).toBe(0);
		expect(result.columns).toEqual(CREDIBLE_SET_COLUMNS);
	});

	it("applies a numeric lower bound and reports truncation at the row cap", async () => {
		serveCredibleSets();
		const filtered = await readTsvGz({
			url: CREDIBLE_SETS_URL,
			numericMin: { column: "pip", value: 0.95 },
		});
		expect(filtered.row_count).toBe(1);
		expect(filtered.truncated).toBe(false);

		serveCredibleSets();
		const capped = await readTsvGz({ url: CREDIBLE_SETS_URL, maxRows: 1 });
		expect(capped.row_count).toBe(1);
		expect(capped.truncated).toBe(true);
	});

	it("throws rather than reporting an empty table when there is no header line", async () => {
		fetchMock.mockImplementation(async () => new Response(zlib.gzipSync(Buffer.from(""))));
		await expect(readTsvGz({ url: CREDIBLE_SETS_URL })).rejects.toThrow(/no header row/);
	});
});

// ── queryRegion ──────────────────────────────────────────────────────────

describe("queryRegion", () => {
	it("runs the complete BGZF/tabix reader through isolated caller-supplied transports", async () => {
		serveSumstats();
		const serve = fetchMock.getMockImplementation()!;
		fetchMock.mockReset();
		const query = { dataset: DATASET, chromosome: "20", start: WINDOW_START, end: WINDOW_START };
		const first = vi.fn(serve); const second = vi.fn(serve);
		const firstIo = { ...createIndexedFileReader(first), fetchFile: first };
		const a = await queryRegion(query, firstIo);
		const b = await queryRegion(query, { ...createIndexedFileReader(second), fetchFile: second });
		expect(a.rows).toEqual(b.rows); expect(a.rows.length).toBeGreaterThan(0);
		expect(first).toHaveBeenCalledTimes(3); expect(second).toHaveBeenCalledTimes(3);
		await queryRegion(query, firstIo);
		expect(first).toHaveBeenCalledTimes(4); // Only the range is fetched again within one reader.
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("preserves underflowing numeric text, NA and empty cells without conflating the originals", async () => {
		const row = nominalRow(WINDOW_START, "rs4239702").replace("0.220888", "1e-400").replace("0.1\t0.05", "NA\t");
		serveSumstats(COVERING_BINS, buildSumstatsFile([row]));
		const result = await queryRegion({ dataset: DATASET, chromosome: "20", start: WINDOW_START, end: WINDOW_START });
		expect(result.rows[0]).toMatchObject({ pvalue: 0, beta: null, se: null });
		expect(result.raw_rows).toEqual([row]);
	});

	it("uses the virtual offset to skip a leading partial record, and refuses malformed complete rows", async () => {
		const row = nominalRow(WINDOW_START, "rs4239702");
		const prefix = "fragment\r\n";
		const file = buildSumstatsFile([prefix + row]);
		serveSumstats([{ bin: LEAF_BIN, chunks: [{ begin: file.dataOffset * 65536 + prefix.length, end: file.dataOffset * 65536 + file.dataLength }] }], file);
		expect((await queryRegion({ dataset: DATASET, chromosome: "20", start: WINDOW_START, end: WINDOW_START })).raw_rows).toEqual([row]);
		resetFileCaches();
		serveSumstats(COVERING_BINS, buildSumstatsFile(["malformed\trow"]));
		await expect(queryRegion({ dataset: DATASET, chromosome: "20", start: WINDOW_START, end: WINDOW_START })).rejects.toThrow(/row width/);
	});
	it("retains native rows and independent byte proofs through pinned repeat reads", async () => {
		serveSumstats();
		const query = { dataset: DATASET, chromosome: "20", start: WINDOW_START, end: WINDOW_START + 1 };
		const result = await queryRegion(query);
		const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
		expect(result.native_header).toBe(NOMINAL_COLUMNS.join("\t"));
		expect(result.raw_rows).toEqual([nominalRow(WINDOW_START, "rs4239702"), nominalRow(WINDOW_START + 1, "rs11121529")]);
		expect(result.coverage_complete).toBe(false);
		expect(result.file_evidence.index.sha256).toBe(hash(tbiFor(COVERING_BINS)));
		expect(result.file_evidence.header.sha256).toBe(hash(FILE.bytes));
		expect(result.file_evidence.range?.sha256).toBe(hash(FILE.bytes.slice(FILE.dataOffset)));
		const pins = { index_sha256: result.file_evidence.index.sha256, header_sha256: result.file_evidence.header.sha256, range_sha256: result.file_evidence.range!.sha256 };
		expect((await queryRegion({ ...query, ...pins })).raw_rows).toEqual(result.raw_rows);
		for (const key of Object.keys(pins)) {
			await expect(queryRegion({ ...query, ...pins, [key]: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
		}
	});
	it("returns the rows inside the window and stops at the first row past it", async () => {
		serveSumstats();
		const result = await queryRegion({
			dataset: DATASET,
			chromosome: "20",
			start: WINDOW_START,
			end: WINDOW_START + 1,
		});
		expect(result.columns).toEqual(NOMINAL_COLUMNS);
		expect(result.row_count).toBe(2);
		expect(result.rows.map((row) => row.position)).toEqual([WINDOW_START, WINDOW_START + 1]);
		expect(result.rows[0].rsid).toBe("rs4239702");
		expect(result.chromosome).toBe("20");
		expect(result.byte_range).not.toBeNull();
	});

	it("accepts a chr-prefixed chromosome and a filter the file does carry", async () => {
		serveSumstats();
		const result = await queryRegion({
			dataset: DATASET,
			chromosome: "chr20",
			start: WINDOW_START,
			end: WINDOW_START + 1,
			rowFilters: { rsid: "rs11121529" },
		});
		expect(result.rows.map((row) => row.position)).toEqual([WINDOW_START + 1]);
	});

	// Same gate as readTsvGz: an unknown filter column must not silently empty
	// a window that has rows in it.
	it("refuses a filter naming a column the sumstats file does not have", async () => {
		serveSumstats();
		await expect(
			queryRegion({
				dataset: DATASET,
				chromosome: "20",
				start: WINDOW_START,
				end: WINDOW_START + 1,
				rowFilters: { pip: "1" },
			}),
		).rejects.toMatchObject({ status: 400 });
	});

	it("reports an unknown chromosome as a 400 naming the indexed references", async () => {
		serveSumstats();
		await expect(
			queryRegion({ dataset: DATASET, chromosome: "ZZ", start: 1, end: 2 }),
		).rejects.toMatchObject({ status: 400, message: /no chromosome "ZZ" \(indexed: 20\)/ });
	});

	it("reports an over-wide span and an inverted window as 400s", async () => {
		serveSumstats();
		await expect(
			queryRegion({ dataset: DATASET, chromosome: "20", start: 1, end: 9_000_000 }),
		).rejects.toMatchObject({ status: 400, message: /exceeds the 5000000 bp limit/ });
		await expect(
			queryRegion({ dataset: DATASET, chromosome: "20", start: 100, end: 1 }),
		).rejects.toMatchObject({ status: 400, message: /invalid region/ });
	});

	it("reports an index with no covering block without claiming exhaustive absence", async () => {
		serveSumstats();
		const far = 1_000_000;
		const result = await queryRegion({
			dataset: DATASET,
			chromosome: "20",
			start: far,
			end: far + 1,
		});
		expect(result.row_count).toBe(0);
		expect(result.lines_scanned).toBe(0);
		expect(result.byte_range).toBeNull();
		expect(result.raw_rows).toEqual([]);
		expect(result.file_evidence.range).toBeNull();
		expect(result.coverage_complete).toBe(false);
	});
});
