#!/usr/bin/env node

// OpenSpec scenario <-> test traceability checker.
//
// 1. Parses every "#### Scenario: <name>" from openspec/specs/*/spec.md
// 2. Scans all *.test.ts files for it('Scenario: <name>') strings
// 3. Reports coverage gaps and exits non-zero if any scenario lacks a test.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SPECS_DIR = join(ROOT, 'openspec', 'specs');
const PACKAGES_DIR = join(ROOT, 'packages');

// ── Spec parsing ────────────────────────────────────────────────────────────

/**
 * Walk openspec/specs/* /spec.md and extract every `#### Scenario: <name>`.
 * Returns Map<specId, { requirement: string, scenario: string }[]>
 */
async function parseScenariosFromSpecs() {
  /** @type {Map<string, { requirement: string, scenario: string }[]>} */
  const specMap = new Map();

  const specDirs = await readdir(SPECS_DIR, { withFileTypes: true });

  for (const dir of specDirs) {
    if (!dir.isDirectory()) continue;

    const specId = dir.name;
    const specPath = join(SPECS_DIR, specId, 'spec.md');
    let content;
    try {
      content = await readFile(specPath, 'utf-8');
    } catch {
      continue; // skip if no spec.md
    }

    const scenarios = [];
    let currentRequirement = '(unknown)';

    for (const line of content.split('\n')) {
      const reqMatch = line.match(/^###\s+Requirement:\s+(.+)/);
      if (reqMatch) {
        currentRequirement = reqMatch[1].trim();
        continue;
      }

      const scenarioMatch = line.match(/^####\s+Scenario:\s+(.+)/);
      if (scenarioMatch) {
        scenarios.push({
          requirement: currentRequirement,
          scenario: scenarioMatch[1].trim(),
        });
      }
    }

    if (scenarios.length > 0) {
      specMap.set(specId, scenarios);
    }
  }

  return specMap;
}

// ── Test scanning ───────────────────────────────────────────────────────────

/**
 * Recursively find all *.test.ts files under packages/.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function findTestFiles(dir) {
  /** @type {string[]} */
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      results.push(...(await findTestFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      results.push(full);
    }
  }

  return results;
}

/**
 * Extract all scenario names from test files.
 * Looks for patterns:
 *   it('Scenario: <name>', ...)
 *   it("Scenario: <name>", ...)
 *   it(`Scenario: <name>`, ...)
 *
 * Also extracts the describe block's spec-id for mapping.
 *
 * Returns Map<specId, Set<scenarioName>>
 */
async function parseScenariosFromTests() {
  /** @type {Map<string, Set<string>>} */
  const testMap = new Map();

  const testFiles = await findTestFiles(PACKAGES_DIR);

  for (const filePath of testFiles) {
    const content = await readFile(filePath, 'utf-8');

    // Extract describe block spec-ids: describe('spec-id/requirement', ...)
    const describeMatches = [...content.matchAll(/describe\s*\(\s*['"`]([^'"`/]+)\//g)];
    const specIds = new Set(describeMatches.map((m) => m[1].trim()));

    // Extract scenario names: it('Scenario: name', ...)
    const scenarioMatches = [...content.matchAll(/it\s*\(\s*['"`]Scenario:\s+([^'"`]+)['"`]/g)];

    for (const specId of specIds) {
      if (!testMap.has(specId)) {
        testMap.set(specId, new Set());
      }
      const set = testMap.get(specId);
      for (const match of scenarioMatches) {
        set.add(match[1].trim());
      }
    }
  }

  return testMap;
}

// ── Report ──────────────────────────────────────────────────────────────────

async function main() {
  const specMap = await parseScenariosFromSpecs();
  const testMap = await parseScenariosFromTests();

  let totalScenarios = 0;
  let coveredScenarios = 0;
  let missingScenarios = 0;
  /** @type {{ specId: string, requirement: string, scenario: string }[]} */
  const missing = [];

  console.log('\n📋 OpenSpec Scenario Coverage Report\n');
  console.log('='.repeat(60));

  for (const [specId, scenarios] of specMap) {
    const testScenarios = testMap.get(specId) ?? new Set();
    const covered = scenarios.filter((s) => testScenarios.has(s.scenario));
    const uncovered = scenarios.filter((s) => !testScenarios.has(s.scenario));

    totalScenarios += scenarios.length;
    coveredScenarios += covered.length;
    missingScenarios += uncovered.length;

    const status = uncovered.length === 0 ? '✅' : '❌';
    console.log(`\n${status} ${specId} — ${covered.length}/${scenarios.length} scenarios covered`);

    for (const s of uncovered) {
      console.log(`   MISSING: ${s.requirement} → "${s.scenario}"`);
      missing.push({ specId, ...s });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`\nTotal: ${coveredScenarios}/${totalScenarios} scenarios covered`);
  console.log(`Missing: ${missingScenarios}`);

  if (missingScenarios > 0) {
    console.log('\n❌ FAIL — Some scenarios have no tests:\n');
    for (const m of missing) {
      console.log(`  - ${m.specId}/${m.requirement} → "Scenario: ${m.scenario}"`);
    }
    console.log('');
    process.exit(1);
  } else {
    console.log('\n✅ PASS — All scenarios have tests.\n');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(2);
});
