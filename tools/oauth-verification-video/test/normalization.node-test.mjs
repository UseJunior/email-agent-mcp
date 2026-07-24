import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {normalizeCaptures} from '../scripts/normalize-captures.mjs';

test('normalization removes stale tail frames before replacing a capture', () => {
  const suffix = randomUUID();
  const workDir = `.work/normalization-test-${suffix}`;
  const workUrl = new URL(`../${workDir}/`, import.meta.url);
  const workPath = workUrl.pathname;

  try {
    mkdirSync(`${workPath}/captures/identity`, {recursive: true});
    writeFileSync(`${workPath}/captures/identity/frame-999999.jpg`, 'stale');
    writeFileSync(`${workPath}/input.mov`, 'synthetic input marker');

    const project = JSON.parse(
      readFileSync(new URL('../project.example.json', import.meta.url), 'utf8'),
    );
    project.captures.identity.file = `${workDir}/input.mov`;
    project.captures.identity.kind = 'video';
    writeFileSync(`${workPath}/project.json`, `${JSON.stringify(project)}\n`);

    const fakeFfmpeg = `${workPath}/fake-ffmpeg.mjs`;
    writeFileSync(fakeFfmpeg, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const pattern = process.argv.at(-1);
writeFileSync(pattern.replace('%06d', '000000'), 'fresh');
`);
    chmodSync(fakeFfmpeg, 0o755);

    const result = normalizeCaptures({
      projectArg: `${workDir}/project.json`,
      fps: 30,
      ffmpeg: fakeFfmpeg,
      workDir,
    });

    assert.equal(result.captures.find(capture => capture.id === 'identity').frameCount, 1);
    assert.equal(existsSync(`${workPath}/captures/identity/frame-999999.jpg`), false);
    assert.equal(existsSync(`${workPath}/captures/identity/frame-000000.jpg`), true);
  } finally {
    rmSync(workPath, {recursive: true, force: true});
  }
});
