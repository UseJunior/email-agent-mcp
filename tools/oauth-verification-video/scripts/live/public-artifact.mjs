import {execFileSync} from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const EXPECTED_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const LEGACY_SCOPE = 'https://mail.google.com/';

function filesBelow(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...filesBelow(path));
    else if (/\.(?:c?js|mjs|json)$/.test(name)) files.push(path);
  }
  return files;
}

export function validatePublishedScopeText(text) {
  if (!text.includes(EXPECTED_SCOPE)) {
    throw new Error(`Published Gmail provider does not contain ${EXPECTED_SCOPE}`);
  }
  if (text.includes(LEGACY_SCOPE)) {
    throw new Error(`Published Gmail provider still contains legacy scope ${LEGACY_SCOPE}`);
  }
  return true;
}

export function inspectPublicArtifact(
  packageVersion,
  {exec = execFileSync} = {},
) {
  const temporary = mkdtempSync(join(tmpdir(), 'email-agent-oauth-release-'));
  try {
    const dependencyRaw = exec(
      'npm',
      [
        'view',
        `email-agent-mcp@${packageVersion}`,
        'dependencies.@usejunior/provider-gmail',
        '--json',
      ],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
    ).trim();
    const dependency = JSON.parse(dependencyRaw);
    if (typeof dependency !== 'string' || !/^\d+\.\d+\.\d+(?:-.+)?$/.test(dependency)) {
      throw new Error('Published email-agent-mcp must pin an exact @usejunior/provider-gmail version');
    }

    const archiveRaw = exec(
      'npm',
      ['pack', `@usejunior/provider-gmail@${dependency}`, '--json', '--pack-destination', temporary],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
    );
    const archiveInfo = JSON.parse(archiveRaw);
    const filename = archiveInfo?.[0]?.filename;
    if (!filename) throw new Error('npm pack did not report the Gmail provider archive');

    const unpacked = join(temporary, 'unpacked');
    exec('mkdir', ['-p', unpacked], {stdio: 'ignore'});
    exec('tar', ['-xzf', join(temporary, filename), '-C', unpacked], {stdio: 'ignore'});
    const text = filesBelow(unpacked)
      .map(path => readFileSync(path, 'utf8'))
      .join('\n');
    validatePublishedScopeText(text);
    return {packageVersion, gmailProviderVersion: dependency};
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
}
