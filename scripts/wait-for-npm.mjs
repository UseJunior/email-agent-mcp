import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Wait for the exact metadata the MCP Registry validates, bypassing local npm caches. */
export async function waitForNpm(packages, {
  fetchImpl = fetch,
  attempts = 30,
  pause = () => new Promise(resolve => setTimeout(resolve, 20_000)),
  log = console.error,
} = {}) {
  const pending = packages.filter(p => p.registryType === 'npm');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const missing = [];
    for (const pkg of pending) {
      try {
        const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.identifier)}/${encodeURIComponent(pkg.version)}`;
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
        if (response.status !== 404 && !response.ok) throw new Error(`npm returned HTTP ${response.status}`);
        if (!response.ok || (await response.json()).version !== pkg.version) missing.push(pkg);
      } catch (err) {
        // Network/registry outages are bounded by the same propagation deadline.
        log(`npm lookup failed: ${err instanceof Error ? err.message : 'unknown error'}`);
        missing.push(pkg);
      }
    }
    if (missing.length === 0) return;
    log(`npm propagation ${attempt}/${attempts}: waiting for ${missing.map(p => `${p.identifier}@${p.version}`).join(', ')}`);
    if (attempt < attempts) await pause();
  }
  throw new Error('npm propagation deadline exceeded; MCP Registry publish was not attempted');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = JSON.parse(await readFile(process.argv[2] ?? 'packages/email-agent-mcp/server.json', 'utf8'));
  if (!server.packages?.some(p => p.registryType === 'npm')) throw new Error('No npm package metadata found');
  await waitForNpm(server.packages);
}
