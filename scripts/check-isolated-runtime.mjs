#!/usr/bin/env node
// Isolated runtime smoke test — packs all workspace packages as local tarballs,
// installs in a temp directory, and verifies the MCP server starts and reports 15 tools.

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const EXPECTED_TOOL_COUNT = 15;
const PACKAGES = [
  'email-core',
  'provider-microsoft',
  'provider-gmail',
  'email-mcp',
  'agent-email',
];

async function main() {
  const repoRoot = process.cwd();
  const tmpDir = mkdtempSync(join(tmpdir(), 'agent-email-smoke-'));

  try {
    console.error(`[smoke] Packing workspace packages into ${tmpDir}...`);

    // Pack all workspace packages
    const tarballs = [];
    for (const pkg of PACKAGES) {
      const pkgDir = join(repoRoot, 'packages', pkg);
      const output = execSync('npm pack --json', { cwd: pkgDir, encoding: 'utf-8' });
      const [info] = JSON.parse(output);
      const tarball = join(pkgDir, info.filename);
      tarballs.push(tarball);
      console.error(`[smoke] Packed ${info.name}@${info.version} (${info.filename})`);
    }

    // Initialize an isolated project and install from tarballs
    console.error('[smoke] Installing tarballs in isolated temp directory...');
    execSync('npm init -y', { cwd: tmpDir, stdio: 'pipe' });
    execSync(`npm install ${tarballs.join(' ')}`, { cwd: tmpDir, stdio: 'pipe', timeout: 60000 });

    // Spawn the MCP server and send JSON-RPC requests
    console.error('[smoke] Starting MCP server...');
    const result = await testMcpServer(tmpDir);

    if (result.success) {
      console.error(`[smoke] PASS: MCP server responded with ${result.toolCount} tools`);
    } else {
      console.error(`[smoke] FAIL: ${result.error}`);
      process.exit(1);
    }

    // Clean up tarballs
    for (const pkg of PACKAGES) {
      const pkgDir = join(repoRoot, 'packages', pkg);
      const files = execSync('ls *.tgz 2>/dev/null || true', { cwd: pkgDir, encoding: 'utf-8' }).trim();
      if (files) {
        for (const f of files.split('\n')) {
          rmSync(join(pkgDir, f), { force: true });
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    console.error('[smoke] Cleaned up temp directory');
  }
}

function testMcpServer(installDir) {
  return new Promise((resolve) => {
    const serverBin = join(installDir, 'node_modules', '.bin', 'agent-email');
    const proc = spawn(serverBin, ['serve'], {
      cwd: installDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_EMAIL_HOME: join(installDir, '.agent-email') },
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ success: false, error: 'Timeout waiting for MCP response' });
    }, 15000);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();

      // Check if we got a response to tools/list
      try {
        // JSON-RPC responses are newline-delimited
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timeout);
            proc.kill();
            const toolCount = msg.result.tools.length;
            if (toolCount === EXPECTED_TOOL_COUNT) {
              resolve({ success: true, toolCount });
            } else {
              resolve({ success: false, error: `Expected ${EXPECTED_TOOL_COUNT} tools, got ${toolCount}` });
            }
            return;
          }
        }
      } catch {
        // Not complete JSON yet — keep reading
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: `Failed to start: ${err.message}` });
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        resolve({ success: false, error: `Process exited with code ${code}: ${stderr}` });
      }
    });

    // Send MCP initialize request
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '1.0.0' },
      },
    }) + '\n';

    // Wait a moment for server to start, then send requests
    setTimeout(() => {
      proc.stdin.write(initRequest);

      // After init, wait for response then send tools/list
      setTimeout(() => {
        const toolsRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }) + '\n';
        proc.stdin.write(toolsRequest);
      }, 2000);
    }, 1000);
  });
}

main().catch((err) => {
  console.error(`[smoke] Fatal: ${err.message}`);
  process.exit(1);
});
