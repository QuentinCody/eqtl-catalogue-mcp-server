import { detectArrays } from "@bio-mcp/shared/staging/schema-inference";
import { expect, it, vi } from "vitest";

vi.mock("@bio-mcp/shared/staging/rest-staging-do", () => ({ RestStagingDO: class {} }));

import { EqtlDataDO } from "./do";

it("selects biological Parquet rows rather than schema or filter records for staging hints", () => {
  const data = { schema: [{ name: "pip", type: "double" }], filters: [{ column: "pip", op: "ge", value: .5 }], rows: [{ cs_id: "cs1", pip: .9 }, { cs_id: "cs1", pip: .9 }] };
  const project = (EqtlDataDO.prototype as unknown as { getTabularData: (data: unknown) => unknown }).getTabularData;
  expect(project(data)).toMatchObject({ credible_sets: data.rows, response_context: expect.any(Array) });
  expect(detectArrays(data)).toEqual([{ key: "rows", rows: data.rows }]);
  expect(project({ datasets: [{ dataset_id: "QTD000116", release: "r8_beta", study_id: "QTS000015" }] })).toMatchObject({ datasets: [{ dataset_id: "QTD000116" }] });
});

it("keeps native TSV text and file proofs from displacing association rows", () => {
  const data = { native_header: "molecular_trait_id\tpvalue", raw_rows: ["ENSG1\t1e-400"],
    file_evidence: { index: { sha256: "a".repeat(64) }, range: { sha256: "b".repeat(64) } },
    rows: [{ molecular_trait_id: "ENSG1", pvalue: 0 }] };
  const project = (EqtlDataDO.prototype as unknown as { getTabularData: (data: unknown) => unknown }).getTabularData;
  expect(project(data)).toMatchObject({ associations: [{ source_tsv: "ENSG1\t1e-400", pvalue: 0, source_index: 0 }], response_context: expect.any(Array) });
  expect(detectArrays(data)).toEqual([{ key: "rows", rows: data.rows }]);
});
