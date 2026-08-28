import { BGZF_MAX_BLOCK_SIZE, inflateBgzf, readBgzfLines, readGzipLines } from "./bgzf";
import type { EqtlDataset } from "./ftp-catalogue";
import { ebiFileFetch } from "./http";
import {
	compressedOffset,
	parseTabixIndex,
	queryChunks,
	resolveReferenceName,
	type TabixIndex,
} from "./tabix";

/**
 * Reads over the eQTL Catalogue flat files: a tabix region slice of the
 * nominal summary statistics, and whole-file scans of the permuted top hits
 * and the SuSiE credible sets (neither of which ships an index).
 */

/** Columns that hold numbers in the catalogue's three table shapes. */
const NUMERIC_COLUMNS = new Set([
	"position",
	"ma_samples",
	"maf",
	"pvalue",
	"beta",
	"se",
	"ac",
	"an",
	"r2",
	"median_tpm",
	"n_traits",
	"n_variants",
	"p_perm",
	"p_beta",
	"pip",
	"z",
	"cs_min_r2",
	"cs_avg_r2",
	"cs_size",
	"cs_index",
	"cs_log10bf",
	"posterior_mean",
	"posterior_sd",
]);

/** A region wider than this is refused rather than dragged over the wire. */
const MAX_REGION_SPAN_BP = 5_000_000;
/** Cap on rows returned by one call before truncation is reported. */
export const DEFAULT_MAX_ROWS = 500;
export const HARD_MAX_ROWS = 20_000;

export type TableRow = Record<string, string | number | null>;

export interface TableResult {
	columns: string[];
	rows: TableRow[];
	row_count: number;
	/** True when the row cap stopped the scan before the data ran out. */
	truncated: boolean;
	source_file: string;
	lines_scanned: number;
}

export interface RegionResult extends TableResult {
	chromosome: string;
	start: number;
	end: number;
	index_file: string;
	byte_range: { start: number; end: number } | null;
}

function coerceRow(columns: string[], cells: string[]): TableRow {
	const row: TableRow = {};
	for (let i = 0; i < columns.length; i++) {
		const raw = cells[i];
		if (raw === undefined || raw === "" || raw === "NA") {
			row[columns[i]] = null;
			continue;
		}
		if (NUMERIC_COLUMNS.has(columns[i])) {
			const value = Number(raw);
			row[columns[i]] = Number.isFinite(value) ? value : raw;
			continue;
		}
		row[columns[i]] = raw;
	}
	return row;
}

export function clampMaxRows(requested: unknown): number {
	const value = Number(requested);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ROWS;
	return Math.min(Math.floor(value), HARD_MAX_ROWS);
}

/** A caller error. Tagged so the tool layer answers 400, not 500. */
function badRequest(message: string): Error & { status: number } {
	const error = new Error(message) as Error & { status: number };
	error.status = 400;
	return error;
}

function unknownColumnError(
	unknown: string[],
	columns: string[],
	sourceFile: string,
): Error & { status: number } {
	return badRequest(
		`eQTL Catalogue: ${sourceFile} has no column ${unknown.map((name) => `"${name}"`).join(", ")} — ` +
			`the file's own header is: ${columns.join(", ")}`,
	);
}

export interface ResolvedFilter {
	column: string;
	at: number;
	value: string;
}

/**
 * Resolve each requested equality filter to its index in the file's own header.
 *
 * A filter naming a column the file does not have is a caller error, never a
 * row that fails to match. Matching it against every row would drop all of them
 * and report row_count 0 with success — a confident absence for data that is
 * really there. This throws a 400 naming the columns the file does have.
 */
export function resolveFilters(
	columns: string[],
	wanted: Record<string, string> | undefined,
	sourceFile: string,
): ResolvedFilter[] {
	const resolved: ResolvedFilter[] = [];
	const unknown: string[] = [];
	for (const [column, value] of Object.entries(wanted ?? {})) {
		if (value === undefined || value === "") continue;
		const at = columns.indexOf(column);
		if (at === -1) unknown.push(column);
		else resolved.push({ column, at, value });
	}
	if (unknown.length > 0) throw unknownColumnError(unknown, columns, sourceFile);
	return resolved;
}

/** Same contract as `resolveFilters`, for a numeric bound on one column. */
export function resolveBound(
	columns: string[],
	bound: { column: string; value: number } | undefined,
	sourceFile: string,
): { at: number; value: number } | undefined {
	if (!bound) return undefined;
	const at = columns.indexOf(bound.column);
	if (at === -1) throw unknownColumnError([bound.column], columns, sourceFile);
	return { at, value: bound.value };
}

// ── Per-isolate caches ───────────────────────────────────────────────────
// The .tbi files are ~2 MB and immutable within a release, and every region
// query needs the same header line. Refetching either per call is what would
// trip EBI's DoS heuristics.

const indexCache = new Map<string, Promise<TabixIndex>>();
const headerCache = new Map<string, Promise<string[]>>();
const MAX_CACHED_INDEXES = 4;

async function fetchTabixIndex(indexUrl: string): Promise<TabixIndex> {
	const response = await ebiFileFetch(indexUrl, {
		cacheTtlSeconds: 86_400,
		timeout: 30_000,
		deadlineMs: 60_000,
	});
	const compressed = new Uint8Array(await response.arrayBuffer());
	return parseTabixIndex(await inflateBgzf(compressed));
}

export function loadTabixIndex(indexUrl: string): Promise<TabixIndex> {
	let cached = indexCache.get(indexUrl);
	if (!cached) {
		if (indexCache.size >= MAX_CACHED_INDEXES) indexCache.clear();
		cached = fetchTabixIndex(indexUrl).catch((error) => {
			indexCache.delete(indexUrl);
			throw error;
		});
		indexCache.set(indexUrl, cached);
	}
	return cached;
}

/** Read the column names from the file's own first line, never a hardcoded list. */
export function loadHeaderColumns(fileUrl: string): Promise<string[]> {
	let cached = headerCache.get(fileUrl);
	if (!cached) {
		cached = (async () => {
			const response = await ebiFileFetch(fileUrl, {
				range: { start: 0, end: BGZF_MAX_BLOCK_SIZE - 1 },
			});
			const first = await inflateBgzf(new Uint8Array(await response.arrayBuffer()), {
				maxBlocks: 1,
			});
			const text = new TextDecoder().decode(first);
			const newline = text.indexOf("\n");
			// The files are CRLF-terminated — the CR has to come off or the last
			// column name carries it into every staged table.
			const line = (newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, "");
			const columns = line.replace(/^#/, "").split("\t");
			if (columns.length < 2) {
				throw new Error(`eQTL Catalogue: no header row found in ${fileUrl}`);
			}
			return columns;
		})().catch((error) => {
			headerCache.delete(fileUrl);
			throw error;
		});
		headerCache.set(fileUrl, cached);
	}
	return cached;
}

/** Drop the per-isolate index/header caches. For tests. */
export function resetFileCaches(): void {
	indexCache.clear();
	headerCache.clear();
}

export interface RegionQuery {
	dataset: EqtlDataset;
	chromosome: string;
	/** 1-based inclusive. */
	start: number;
	/** 1-based inclusive. */
	end: number;
	maxRows?: number;
	/** Extra equality filters applied to the decoded rows. */
	rowFilters?: Record<string, string>;
}

/**
 * Fetch every nominal association in a genomic window, using the tabix index to
 * turn the window into a single byte range.
 *
 * The files are indexed by coordinate only. A gene- or rsID-centric question
 * must resolve to GRCh38 coordinates first (the ensembl, gnomad or gwas-catalog
 * servers do that); `rowFilters` then narrows the window's rows.
 */
export async function queryRegion(query: RegionQuery): Promise<RegionResult> {
	const { dataset, chromosome, start, end } = query;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
		throw badRequest(
			`eQTL Catalogue: invalid region ${chromosome}:${start}-${end} (1-based inclusive, end >= start)`,
		);
	}
	if (end - start + 1 > MAX_REGION_SPAN_BP) {
		throw badRequest(
			`eQTL Catalogue: region span ${end - start + 1} bp exceeds the ${MAX_REGION_SPAN_BP} bp limit — narrow the window`,
		);
	}

	const maxRows = clampMaxRows(query.maxRows);
	const index = await loadTabixIndex(dataset.sumstats_index_url);
	const referenceName = resolveReferenceName(index, chromosome);
	if (referenceName === undefined) {
		throw badRequest(
			`eQTL Catalogue: ${dataset.dataset_id} has no chromosome "${chromosome}" (indexed: ${index.names.join(", ")})`,
		);
	}
	const reference = index.refs.get(referenceName);
	if (!reference) {
		throw new Error(`eQTL Catalogue: index for ${referenceName} is missing from the .tbi`);
	}

	const columns = await loadHeaderColumns(dataset.sumstats_url);
	// Before anything can return zero rows: every filter column must exist in
	// the file's own header, or the "no rows" answer would be manufactured.
	const filters = resolveFilters(columns, query.rowFilters, dataset.sumstats_url);
	const base: Omit<RegionResult, "rows" | "row_count" | "truncated" | "lines_scanned"> = {
		columns,
		chromosome: referenceName,
		start,
		end,
		source_file: dataset.sumstats_url,
		index_file: dataset.sumstats_index_url,
		byte_range: null,
	};

	const chunks = queryChunks(reference, start - 1, end);
	if (chunks.length === 0) {
		// The index itself says no block covers the window. That is a verified
		// negative, not a failed read.
		return { ...base, rows: [], row_count: 0, truncated: false, lines_scanned: 0 };
	}

	let byteStart = Number.POSITIVE_INFINITY;
	let byteEnd = 0;
	for (const chunk of chunks) {
		byteStart = Math.min(byteStart, compressedOffset(chunk.begin));
		byteEnd = Math.max(byteEnd, compressedOffset(chunk.end) + BGZF_MAX_BLOCK_SIZE - 1);
	}

	const seqColumn = index.colSeq - 1;
	const posColumn = index.colBeg - 1;

	const rows: TableRow[] = [];
	let truncated = false;

	const response = await ebiFileFetch(dataset.sumstats_url, {
		range: { start: byteStart, end: byteEnd },
		timeout: 30_000,
		deadlineMs: 60_000,
	});
	if (!response.body) {
		throw new Error(`eQTL Catalogue: empty body for ${dataset.sumstats_url}`);
	}

	const linesScanned = await readBgzfLines(response.body, (line) => {
		if (line.length === 0 || line.startsWith(index.meta)) return;
		const cells = line.split("\t");
		// A range read starts mid-member, so the first line is usually a
		// fragment. Column count is the cheap, reliable discriminator.
		if (cells.length !== columns.length) return;
		if (cells[seqColumn] !== referenceName) return;
		const position = Number(cells[posColumn]);
		if (!Number.isFinite(position)) return;
		if (position < start) return;
		// Records are coordinate-sorted, so the first row past the window ends
		// the scan instead of streaming the rest of the byte range.
		if (position > end) return false;
		for (const filter of filters) {
			if (cells[filter.at] !== filter.value) return;
		}
		if (rows.length >= maxRows) {
			truncated = true;
			return false;
		}
		rows.push(coerceRow(columns, cells));
	});

	return {
		...base,
		byte_range: { start: byteStart, end: byteEnd },
		rows,
		row_count: rows.length,
		truncated,
		lines_scanned: linesScanned,
	};
}

export interface WholeFileQuery {
	url: string;
	maxRows?: number;
	/** Equality filters on decoded columns. */
	rowFilters?: Record<string, string>;
	/** Optional upper bound on a numeric column (for example p_beta). */
	numericMax?: { column: string; value: number };
	/** Optional lower bound on a numeric column (for example pip). */
	numericMin?: { column: string; value: number };
}

/**
 * Stream a whole plain-gzip TSV (permuted top hits, SuSiE credible sets) and
 * keep the rows that pass the filters. These files carry no tabix index, so
 * there is no byte-range shortcut — the scan is streamed and stops at the cap.
 */
export async function readTsvGz(query: WholeFileQuery): Promise<TableResult> {
	const maxRows = clampMaxRows(query.maxRows);
	const response = await ebiFileFetch(query.url, { timeout: 45_000, deadlineMs: 90_000 });
	if (!response.body) throw new Error(`eQTL Catalogue: empty body for ${query.url}`);

	let columns: string[] = [];
	const rows: TableRow[] = [];
	let truncated = false;
	// These files carry no index, so the header only arrives with the stream.
	// The filter columns are checked against it on the header line and the scan
	// is stopped there — an unknown column ends the call loudly instead of
	// dropping every row and reporting a zero the data does not support.
	let filters: ResolvedFilter[] = [];
	let numericMax: { at: number; value: number } | undefined;
	let numericMin: { at: number; value: number } | undefined;
	let columnError: Error | undefined;

	const linesScanned = await readGzipLines(response.body, (line) => {
		if (line.length === 0) return;
		const cells = line.split("\t");
		if (columns.length === 0) {
			columns = cells.map((cell) => cell.replace(/^#/, ""));
			try {
				filters = resolveFilters(columns, query.rowFilters, query.url);
				numericMax = resolveBound(columns, query.numericMax, query.url);
				numericMin = resolveBound(columns, query.numericMin, query.url);
			} catch (error) {
				columnError = error as Error;
				return false;
			}
			return;
		}
		if (cells.length !== columns.length) return;
		for (const filter of filters) {
			if (cells[filter.at] !== filter.value) return;
		}
		if (numericMax) {
			const value = Number(cells[numericMax.at]);
			if (!Number.isFinite(value) || value > numericMax.value) return;
		}
		if (numericMin) {
			const value = Number(cells[numericMin.at]);
			if (!Number.isFinite(value) || value < numericMin.value) return;
		}
		if (rows.length >= maxRows) {
			truncated = true;
			return false;
		}
		rows.push(coerceRow(columns, cells));
	});

	if (columnError) throw columnError;
	if (columns.length === 0) {
		// No header line at all: the read failed or the file is not the table it
		// claims to be. Reporting that as an empty result would be a lie.
		throw new Error(`eQTL Catalogue: no header row found in ${query.url}`);
	}

	return {
		columns,
		rows,
		row_count: rows.length,
		truncated,
		source_file: query.url,
		lines_scanned: linesScanned,
	};
}
