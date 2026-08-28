#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assertContains(filePath, haystack, needle, testName) {
  totalTests++;
  if (haystack.includes(needle)) {
    console.log(`${GREEN}✓${RESET} ${testName}`);
    passedTests++;
  } else {
    console.log(`${RED}✗${RESET} ${testName}`);
    console.log(`  Missing: ${needle}`);
    console.log(`  File: ${filePath}`);
    failedTests++;
  }
}

function assertExcludes(filePath, haystack, needle, testName) {
  totalTests++;
  if (!haystack.includes(needle)) {
    console.log(`${GREEN}✓${RESET} ${testName}`);
    passedTests++;
  } else {
    console.log(`${RED}✗${RESET} ${testName}`);
    console.log(`  Present but must not be: ${needle}`);
    console.log(`  File: ${filePath}`);
    failedTests++;
  }
}

function readFile(relPath) {
  const absPath = path.resolve(SERVER_ROOT, relPath);
  return fs.readFileSync(absPath, 'utf8');
}

console.log(`${BLUE}🧪 eQTL Catalogue Structured Content Regression Tests${RESET}`);

const toolExpectations = [
  {
    path: 'src/tools/code-mode.ts',
    required: ['createSearchTool', 'createExecuteTool', 'eqtlCatalog'],
  },
  {
    path: 'src/tools/query-data.ts',
    required: ['createQueryDataHandler', 'eqtl_query_data', 'EQTL_DATA_DO'],
  },
  {
    path: 'src/tools/get-schema.ts',
    required: ['createGetSchemaHandler', 'eqtl_get_schema', 'EQTL_DATA_DO'],
  },
  {
    // The REST API is retired (HTTP 410). The catalog must describe the FTP
    // flat-file substrate, and must not advertise the dead /associations route.
    path: 'src/spec/catalog.ts',
    required: [
      'eqtlCatalog',
      'ftp.ebi.ac.uk/pub/databases/spot/eQTL',
      '/datasets/{dataset_id}/region',
      '/datasets/{dataset_id}/top_associations',
      'COORDINATES ONLY',
    ],
    forbidden: ['baseUrl: "https://www.ebi.ac.uk/eqtl/api'],
  },
  {
    path: 'src/lib/http.ts',
    required: ['ftp.ebi.ac.uk/pub/databases/spot/eQTL', 'registerRateLimitPolicy'],
  },
  {
    path: 'src/lib/api-adapter.ts',
    required: ['parseEqtlPath', 'createEqtlApiFetch', 'queryRegion', 'readTsvGz'],
  },
];

for (const { path: filePath, required, forbidden } of toolExpectations) {
  const content = readFile(filePath);
  for (const token of required) {
    assertContains(filePath, content, token, `${filePath} includes ${token}`);
  }
  for (const token of forbidden ?? []) {
    assertExcludes(filePath, content, token, `${filePath} omits ${token}`);
  }
}

const doContent = readFile('src/do.ts');
for (const table of ['associations', 'top_associations', 'credible_sets', 'datasets']) {
  assertContains('src/do.ts', doContent, `tableName: "${table}"`, `do.ts hints the ${table} table`);
}

const credibleSetHint = doContent.slice(
  doContent.indexOf('tableName: "credible_sets"'),
  doContent.indexOf('// Nominal / conditional cis associations.'),
);
for (const absent of ['"chromosome"', '"position"']) {
  assertExcludes(
    'src/do.ts',
    credibleSetHint,
    absent,
    `do.ts credible_sets index list omits ${absent}`,
  );
}

// A filter naming a column the file does not carry must be a loud 400, never a
// row that fails to match. Matching it against every row returns row_count 0
// with success — a manufactured absence over data that is really there.
const sumstatsContent = readFile('src/lib/sumstats.ts');
for (const token of ['resolveFilters', 'resolveBound', 'status = 400']) {
  assertContains('src/lib/sumstats.ts', sumstatsContent, token, `sumstats.ts includes ${token}`);
}
assertExcludes(
  'src/lib/sumstats.ts',
  sumstatsContent,
  'at === -1 || cells[at] !== value',
  'sumstats.ts does not treat an unknown filter column as a failed row match',
);
assertContains(
  'src/lib/api-adapter.ts',
  readFile('src/lib/api-adapter.ts'),
  'rejectCoordinateFilters',
  'api-adapter.ts rejects chromosome/position on /credible_sets',
);

// The SuSiE credible-set file carries 13 columns and neither chromosome nor
// position. Advertising those is what teaches a model to send the broken call.
const catalogContent = readFile('src/spec/catalog.ts');
const credibleSetShape =
  catalogContent.split('\n').find((line) => line.includes('cs_min_r2, region }]')) ?? '';
assertContains(
  'src/spec/catalog.ts',
  credibleSetShape,
  'cs_id, variant, rsid, cs_size, pip',
  'catalog credible_sets responseShape lists the real columns',
);
for (const absent of ['rsid, chromosome', 'chromosome, position']) {
  assertExcludes(
    'src/spec/catalog.ts',
    credibleSetShape,
    absent,
    `catalog credible_sets responseShape omits ${absent}`,
  );
}

const indexContent = readFile('src/index.ts');
assertContains('src/index.ts', indexContent, 'EqtlDataDO', 'index.ts exports EqtlDataDO');
assertContains('src/index.ts', indexContent, 'StatelessMcpWorker', 'index.ts uses StatelessMcpWorker');

console.log(`\n${BLUE}📊 Test Results Summary${RESET}`);
console.log(`Total tests: ${totalTests}`);
console.log(`${GREEN}Passed: ${passedTests}${RESET}`);
console.log(`${RED}Failed: ${failedTests}${RESET}`);

if (failedTests > 0) {
  console.log(`\n${RED}❌ Regression tests failed.${RESET}`);
  process.exit(1);
}

console.log(`\n${GREEN}✅ eQTL Catalogue structured content regression tests passed.${RESET}`);
