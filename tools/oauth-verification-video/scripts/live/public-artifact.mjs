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
const URL_TOKEN = /https:\/\/[A-Za-z0-9./_-]+/g;

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
  const urls = new Set(text.match(URL_TOKEN) ?? []);
  if (!urls.has(EXPECTED_SCOPE)) {
    throw new Error(`Published Gmail provider does not contain ${EXPECTED_SCOPE}`);
  }
  if (urls.has(LEGACY_SCOPE)) {
    throw new Error(`Published Gmail provider still contains legacy scope ${LEGACY_SCOPE}`);
  }
  return true;
}

function readPublishedDependency(exec, packageSpec, dependencyName) {
  const raw = exec(
    'npm',
    ['view', packageSpec, `dependencies.${dependencyName}`, '--json'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
  ).trim();
  if (!raw) {
    throw new Error(`Published ${packageSpec} does not depend on ${dependencyName}`);
  }
  const dependency = JSON.parse(raw);
  if (typeof dependency !== 'string') {
    throw new Error(`Published ${packageSpec} has an invalid ${dependencyName} dependency`);
  }
  return dependency;
}

function requireLockstepRange(packageSpec, dependencyName, range, packageVersion) {
  if (![packageVersion, `^${packageVersion}`, `~${packageVersion}`].includes(range)) {
    throw new Error(
      `Published ${packageSpec} must use the release version of ${dependencyName}; found ${range}`,
    );
  }
}

export function resolvePublishedGmailProviderVersion(
  packageVersion,
  {exec = execFileSync} = {},
) {
  const cliSpec = `email-agent-mcp@${packageVersion}`;
  const mcpRange = readPublishedDependency(
    exec,
    cliSpec,
    '@usejunior/email-mcp',
  );
  requireLockstepRange(cliSpec, '@usejunior/email-mcp', mcpRange, packageVersion);

  const mcpSpec = `@usejunior/email-mcp@${packageVersion}`;
  const gmailRange = readPublishedDependency(
    exec,
    mcpSpec,
    '@usejunior/provider-gmail',
  );
  requireLockstepRange(
    mcpSpec,
    '@usejunior/provider-gmail',
    gmailRange,
    packageVersion,
  );
  return packageVersion;
}

export function inspectPublicArtifact(
  packageVersion,
  {exec = execFileSync} = {},
) {
  const temporary = mkdtempSync(join(tmpdir(), 'email-agent-oauth-release-'));
  try {
    const dependency = resolvePublishedGmailProviderVersion(packageVersion, {exec});

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
