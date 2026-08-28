import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { type EqtlDataset, filterDatasets, loadDatasets, summarizeStudies } from "./ftp-catalogue";
import { clampMaxRows, queryRegion, readTsvGz } from "./sumstats";

/**
 * Routes the isolate's `api.get(...)` calls onto the eQTL Catalogue's static
 * files. The paths below are this server's own surface, not upstream REST
 * routes — EBI's REST API is retired (410). Metadata comes from the resources
 * repository; associations come from bgzip/tabix files on the FTP tree.
 */

export type EqtlRoute =
	| { kind: "datasets" }
	| { kind: "dataset"; datasetId: string }
	| { kind: "region"; datasetId: string }
	| { kind: "top-associations"; datasetId: string }
	| { kind: "credible-sets"; datasetId: string }
	| { kind: "studies" }
	| { kind: "study"; studyId: string };

const SUB_ROUTES: Record<string, EqtlRoute["kind"]> = {
	region: "region",
	top_associations: "top-associations",
	credible_sets: "credible-sets",
};

/** Map a request path to a route. Returns undefined for anything unknown. */
export function parseEqtlPath(path: string): EqtlRoute | undefined {
	const segments = path
		.split("?")[0]
		.split("/")
		.filter((segment) => segment.length > 0);
	if (segments[0] === "datasets") {
		if (segments.length === 1) return { kind: "datasets" };
		const datasetId = segments[1].toUpperCase();
		if (segments.length === 2) return { kind: "dataset", datasetId };
		if (segments.length === 3) {
			const kind = SUB_ROUTES[segments[2]];
			if (kind && kind !== "datasets" && kind !== "studies") {
				return { kind, datasetId } as EqtlRoute;
			}
		}
		return undefined;
	}
	if (segments[0] === "studies") {
		if (segments.length === 1) return { kind: "studies" };
		if (segments.length === 2) {
			return { kind: "study", studyId: segments[1].toUpperCase() };
		}
	}
	return undefined;
}

function badRequest(message: string): Error & { status: number } {
	const error = new Error(message) as Error & { status: number };
	error.status = 400;
	return error;
}

function notFound(message: string): Error & { status: number } {
	const error = new Error(message) as Error & { status: number };
	error.status = 404;
	return error;
}

function getString(params: Record<string, unknown> | undefined, name: string): string | undefined {
	const value = params?.[name];
	if (value === undefined || value === null) return undefined;
	const text = String(value).trim();
	return text.length > 0 ? text : undefined;
}

function getInteger(params: Record<string, unknown> | undefined, name: string): number | undefined {
	const text = getString(params, name);
	if (text === undefined) return undefined;
	const value = Number(text.replace(/[,_]/g, ""));
	if (!Number.isFinite(value)) {
		throw badRequest(`eQTL Catalogue: ${name} must be a number (got "${text}")`);
	}
	return Math.trunc(value);
}

function getNumber(params: Record<string, unknown> | undefined, name: string): number | undefined {
	const text = getString(params, name);
	if (text === undefined) return undefined;
	const value = Number(text);
	if (!Number.isFinite(value)) {
		throw badRequest(`eQTL Catalogue: ${name} must be a number (got "${text}")`);
	}
	return value;
}

function rowFiltersFrom(
	params: Record<string, unknown> | undefined,
	names: string[],
): Record<string, string> {
	const filters: Record<string, string> = {};
	for (const name of names) {
		const value = getString(params, name);
		if (value !== undefined) filters[name] = value;
	}
	return filters;
}

async function resolveDataset(datasetId: string): Promise<EqtlDataset> {
	const datasets = await loadDatasets();
	const dataset = datasets.find((candidate) => candidate.dataset_id === datasetId);
	if (!dataset) {
		throw notFound(
			`eQTL Catalogue: no dataset ${datasetId} in the r7 release — list candidates with api.get("/datasets", { search: "..." })`,
		);
	}
	return dataset;
}

async function handleDatasets(params: Record<string, unknown> | undefined) {
	const datasets = await loadDatasets();
	const matched = filterDatasets(datasets, {
		dataset_id: getString(params, "dataset_id")?.toUpperCase(),
		study_id: getString(params, "study_id")?.toUpperCase(),
		study_label: getString(params, "study_label"),
		quant_method: getString(params, "quant_method"),
		tissue_label: getString(params, "tissue_label"),
		tissue_id: getString(params, "tissue_id"),
		sample_group: getString(params, "sample_group"),
		condition_label: getString(params, "condition_label"),
		study_type: getString(params, "study_type"),
		search: getString(params, "search"),
	});
	const offset = Math.max(0, getInteger(params, "offset") ?? 0);
	const size = Math.min(Math.max(1, getInteger(params, "size") ?? 50), 1000);
	return {
		release: "r7",
		total_datasets: datasets.length,
		matched_datasets: matched.length,
		offset,
		datasets: matched.slice(offset, offset + size),
	};
}

async function handleStudies(params: Record<string, unknown> | undefined) {
	const studies = summarizeStudies(await loadDatasets());
	const search = getString(params, "search")?.toLowerCase();
	const matched = search
		? studies.filter((study) =>
				`${study.study_id} ${study.study_label}`.toLowerCase().includes(search),
			)
		: studies;
	return { release: "r7", study_count: matched.length, studies: matched };
}

async function handleStudy(studyId: string) {
	const datasets = await loadDatasets();
	const members = datasets.filter((dataset) => dataset.study_id === studyId);
	if (members.length === 0) {
		throw notFound(`eQTL Catalogue: no study ${studyId} in the r7 release`);
	}
	return { ...summarizeStudies(members)[0], datasets: members };
}

async function handleRegion(datasetId: string, params: Record<string, unknown> | undefined) {
	const dataset = await resolveDataset(datasetId);
	const chromosome = getString(params, "chromosome") ?? getString(params, "chr");
	const start = getInteger(params, "start");
	const end = getInteger(params, "end");
	if (!chromosome || start === undefined || end === undefined) {
		throw badRequest(
			"eQTL Catalogue: /region needs chromosome, start and end (GRCh38, 1-based inclusive). " +
				"The files are indexed by coordinate only — resolve a gene or rsID to coordinates first.",
		);
	}
	const result = await queryRegion({
		dataset,
		chromosome,
		start,
		end,
		maxRows: clampMaxRows(params?.max_rows),
		rowFilters: rowFiltersFrom(params, [
			"gene_id",
			"molecular_trait_id",
			"molecular_trait_object_id",
			"rsid",
			"variant",
			"ref",
			"alt",
			"type",
		]),
	});
	return { dataset: datasetContext(dataset), ...result };
}

async function handleTopAssociations(
	datasetId: string,
	params: Record<string, unknown> | undefined,
) {
	const dataset = await resolveDataset(datasetId);
	if (!dataset.permuted_url) {
		throw notFound(
			`eQTL Catalogue: ${datasetId} publishes no permuted top-hit file (sumstats file is ${dataset.sumstats_url})`,
		);
	}
	const pBetaMax = getNumber(params, "p_beta_max");
	const result = await readTsvGz({
		url: dataset.permuted_url,
		maxRows: clampMaxRows(params?.max_rows),
		rowFilters: rowFiltersFrom(params, [
			"molecular_trait_id",
			"molecular_trait_object_id",
			"chromosome",
			"variant",
		]),
		numericMax: pBetaMax === undefined ? undefined : { column: "p_beta", value: pBetaMax },
	});
	return { dataset: datasetContext(dataset), ...result };
}

/**
 * The SuSiE credible-set file carries no chromosome or position column — it
 * locates a set with `region` ("chr1:9210570-11210570"). Accepting either as a
 * row filter dropped every row and answered row_count 0 with success, which is
 * a manufactured absence. Say so instead.
 */
function rejectCoordinateFilters(params: Record<string, unknown> | undefined): void {
	for (const name of ["chromosome", "position"]) {
		if (getString(params, name) === undefined) continue;
		throw badRequest(
			`eQTL Catalogue: /credible_sets has no "${name}" column — the SuSiE file locates a ` +
				'credible set with its "region" column (chrN:start-end), which this route does not ' +
				"filter on. Narrow with molecular_trait_id, gene_id, cs_id, variant or rsid, or use " +
				"/region for a coordinate slice of the nominal statistics.",
		);
	}
}

async function handleCredibleSets(datasetId: string, params: Record<string, unknown> | undefined) {
	const dataset = await resolveDataset(datasetId);
	if (!dataset.credible_sets_url) {
		throw notFound(`eQTL Catalogue: ${datasetId} publishes no SuSiE credible-set file`);
	}
	rejectCoordinateFilters(params);
	const minPip = getNumber(params, "min_pip");
	const result = await readTsvGz({
		url: dataset.credible_sets_url,
		maxRows: clampMaxRows(params?.max_rows),
		rowFilters: rowFiltersFrom(params, [
			"molecular_trait_id",
			"gene_id",
			"variant",
			"rsid",
			"cs_id",
		]),
		numericMin: minPip === undefined ? undefined : { column: "pip", value: minPip },
	});
	return { dataset: datasetContext(dataset), ...result };
}

function datasetContext(dataset: EqtlDataset) {
	return {
		dataset_id: dataset.dataset_id,
		study_id: dataset.study_id,
		study_label: dataset.study_label,
		quant_method: dataset.quant_method,
		tissue_label: dataset.tissue_label,
		condition_label: dataset.condition_label,
		sample_size: dataset.sample_size,
	};
}

export function createEqtlApiFetch(): ApiFetchFn {
	return async (request) => {
		if (request.method.toUpperCase() !== "GET") {
			throw badRequest(
				`eQTL Catalogue: ${request.method} is not supported — the catalogue is a read-only file tree`,
			);
		}
		const route = parseEqtlPath(request.path);
		if (!route) {
			throw notFound(
				`eQTL Catalogue: unknown path "${request.path}". Available: /studies, /studies/{study_id}, ` +
					"/datasets, /datasets/{dataset_id}, /datasets/{dataset_id}/region, " +
					"/datasets/{dataset_id}/top_associations, /datasets/{dataset_id}/credible_sets",
			);
		}

		const params = request.params;
		switch (route.kind) {
			case "datasets":
				return { status: 200, data: await handleDatasets(params) };
			case "dataset":
				return { status: 200, data: await resolveDataset(route.datasetId) };
			case "studies":
				return { status: 200, data: await handleStudies(params) };
			case "study":
				return { status: 200, data: await handleStudy(route.studyId) };
			case "region":
				return { status: 200, data: await handleRegion(route.datasetId, params) };
			case "top-associations":
				return { status: 200, data: await handleTopAssociations(route.datasetId, params) };
			case "credible-sets":
				return { status: 200, data: await handleCredibleSets(route.datasetId, params) };
		}
	};
}
