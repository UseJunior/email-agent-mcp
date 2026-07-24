import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function isExecutable(path) {
  if (!path || !existsSync(path)) return false;

  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function commandPath(command) {
  const result = spawnSync('sh', ['-lc', `command -v "${command}"`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0) return undefined;
  const path = result.stdout.trim();
  return isExecutable(path) ? path : undefined;
}

function numericSuffix(path) {
  const match = basename(path).match(/-(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function playwrightChromiumCandidates() {
  const cacheRoots = process.platform === 'darwin'
    ? [join(homedir(), 'Library', 'Caches', 'ms-playwright')]
    : [join(homedir(), '.cache', 'ms-playwright')];

  const candidates = [];

  for (const cacheRoot of cacheRoots) {
    if (!existsSync(cacheRoot)) continue;

    const installations = readdirSync(cacheRoot, { withFileTypes: true })
      .filter(entry =>
        entry.isDirectory() &&
        (
          entry.name.startsWith('chromium_headless_shell-') ||
          entry.name.startsWith('chromium-')
        ))
      .map(entry => join(cacheRoot, entry.name))
      .sort((left, right) => numericSuffix(right) - numericSuffix(left));

    for (const installation of installations) {
      if (process.platform === 'darwin') {
        candidates.push(
          join(
            installation,
            'chrome-headless-shell-mac-arm64',
            'chrome-headless-shell',
          ),
          join(
            installation,
            'chrome-headless-shell-mac-x64',
            'chrome-headless-shell',
          ),
          join(
            installation,
            'chrome-mac-arm64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing',
          ),
          join(
            installation,
            'chrome-mac-x64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing',
          ),
        );
      } else if (process.platform === 'linux') {
        candidates.push(
          join(installation, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
          join(installation, 'chrome-linux64', 'chrome'),
        );
      }
    }
  }

  return candidates;
}

export function findChromeExecutable(override = process.env['OAUTH_VIDEO_CHROME']) {
  const candidates = [
    override,
    process.env['CHROME_BIN'],
    ...(process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          join(
            homedir(),
            'Applications',
            'Google Chrome.app',
            'Contents',
            'MacOS',
            'Google Chrome',
          ),
        ]
      : []),
    ...playwrightChromiumCandidates(),
  ];

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  for (const command of [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ]) {
    const path = commandPath(command);
    if (path) return path;
  }

  throw new Error(
    'No Chromium-compatible browser found. Set OAUTH_VIDEO_CHROME or pass --chrome /path/to/chrome.',
  );
}

export function findFfmpegExecutable(override = process.env['OAUTH_VIDEO_FFMPEG']) {
  const candidates = [
    override,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  const path = commandPath('ffmpeg');
  if (path) return path;

  throw new Error(
    'ffmpeg was not found. Set OAUTH_VIDEO_FFMPEG or pass --ffmpeg /path/to/ffmpeg.',
  );
}
