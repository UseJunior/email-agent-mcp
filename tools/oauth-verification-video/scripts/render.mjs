#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  statSync,
} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChromePipe } from './chrome-pipe.mjs';
import {
  findChromeExecutable,
  findFfmpegExecutable,
} from './binary-discovery.mjs';
import { preflight, formatPreflight } from './preflight.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(SCRIPT_DIR, '..');

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

function printHelp() {
  console.error(`OAuth verification video renderer

Usage:
  node scripts/render.mjs [options]

Options:
  --mode <storyboard|final>  Render mode (default: storyboard)
  --project <path>           Project manifest served to the compositor
                             (default: project.example.json)
  --input <path>             Compositor HTML relative to the tool root
                             (default: src/index.html)
  --url <url>                Render an already-served page instead of starting
                             the local static server
  --output <path>            Output MP4 path
  --narration <path>         Reviewed narration audio to mux in final mode
  --fps <number>             Override the compositor frame rate
  --frames <number>          Override the compositor frame count
  --start-frame <number>     Start at this global compositor frame (default: 0)
  --width <pixels>           Viewport width (default: 1920)
  --height <pixels>          Viewport height (default: 1080)
  --chrome <path>            Chromium-compatible executable
  --ffmpeg <path>            ffmpeg executable
  --frames-dir <path>        Directory for captured PNG frames
  --keep-frames              Keep the temporary PNG frame directory
  --timeout-ms <number>      Browser/CDP timeout (default: 30000)
  --no-sandbox               Pass --no-sandbox to Chromium
  --doctor                   Print binary discovery and version information
  --help                     Show this help

Environment overrides:
  OAUTH_VIDEO_CHROME
  OAUTH_VIDEO_FFMPEG
`);
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function positiveNumber(raw, option, { integer = false } = {}) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${option} must be a positive ${integer ? 'integer' : 'number'}.`);
  }
  return parsed;
}

export function parseRenderArgs(argv) {
  const options = {
    mode: 'storyboard',
    project: 'project.example.json',
    input: 'src/index.html',
    width: 1920,
    height: 1080,
    timeoutMs: 30_000,
    keepFrames: false,
    startFrame: 0,
    noSandbox: false,
    doctor: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];

    switch (option) {
      case '--mode':
        options.mode = requireValue(argv, index, option);
        index += 1;
        break;
      case '--project':
        options.project = requireValue(argv, index, option);
        index += 1;
        break;
      case '--input':
        options.input = requireValue(argv, index, option);
        index += 1;
        break;
      case '--url':
        options.url = requireValue(argv, index, option);
        index += 1;
        break;
      case '--output':
        options.output = requireValue(argv, index, option);
        index += 1;
        break;
      case '--narration':
        options.narration = requireValue(argv, index, option);
        index += 1;
        break;
      case '--fps':
        options.fps = positiveNumber(requireValue(argv, index, option), option);
        index += 1;
        break;
      case '--frames':
        options.frames = positiveNumber(
          requireValue(argv, index, option),
          option,
          { integer: true },
        );
        index += 1;
        break;
      case '--start-frame':
        options.startFrame = Number(requireValue(argv, index, option));
        if (!Number.isInteger(options.startFrame) || options.startFrame < 0) {
          throw new Error(`${option} must be a non-negative integer.`);
        }
        index += 1;
        break;
      case '--width':
        options.width = positiveNumber(
          requireValue(argv, index, option),
          option,
          { integer: true },
        );
        index += 1;
        break;
      case '--height':
        options.height = positiveNumber(
          requireValue(argv, index, option),
          option,
          { integer: true },
        );
        index += 1;
        break;
      case '--chrome':
        options.chrome = requireValue(argv, index, option);
        index += 1;
        break;
      case '--ffmpeg':
        options.ffmpeg = requireValue(argv, index, option);
        index += 1;
        break;
      case '--frames-dir':
        options.framesDir = requireValue(argv, index, option);
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = positiveNumber(
          requireValue(argv, index, option),
          option,
          { integer: true },
        );
        index += 1;
        break;
      case '--keep-frames':
        options.keepFrames = true;
        break;
      case '--no-sandbox':
        options.noSandbox = true;
        break;
      case '--doctor':
        options.doctor = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  validateRenderOptions(options);

  options.output ??= options.mode === 'final'
    ? 'dist/oauth-verification-final.mp4'
    : 'dist/oauth-verification-storyboard.mp4';

  return options;
}

export function validateRenderOptions(options) {
  if (!['storyboard', 'final'].includes(options.mode)) {
    throw new Error('--mode must be either storyboard or final.');
  }
  if (options.fps !== undefined && options.fps > 60) {
    throw new Error('--fps must not exceed 60.');
  }
  if (options.mode === 'final' && options.url) {
    throw new Error('--url is available only in storyboard mode; final mode requires a validated local project.');
  }
  if (options.narration && options.mode !== 'final') {
    throw new Error('--narration is available only in final mode.');
  }
  if (options.mode === 'final' && options.input !== 'src/index.html') {
    throw new Error('--input is available only in storyboard mode; final mode uses the reviewed compositor entry point.');
  }
  if (options.mode === 'final' && options.frames !== undefined) {
    throw new Error('--frames is available only in storyboard mode; final mode always renders the complete timeline.');
  }
  if (options.mode === 'final' && options.startFrame !== 0) {
    throw new Error('--start-frame is available only in storyboard mode; final mode always starts at frame 0.');
  }
  if (
    options.mode === 'final'
    && (options.width !== 1920 || options.height !== 1080 || (options.fps ?? 30) !== 30)
  ) {
    throw new Error('Final mode requires the reviewed 1920x1080, 30 fps format.');
  }
}

function resolveFromRoot(path) {
  return isAbsolute(path) ? resolve(path) : resolve(TOOL_ROOT, path);
}

function relativeProjectPath(project) {
  const resolved = resolveFromRoot(project);
  const localPath = relative(TOOL_ROOT, resolved);
  if (localPath === '..' || localPath.startsWith(`..${sep}`) || isAbsolute(localPath)) {
    throw new Error(
      `The project manifest must be inside ${TOOL_ROOT} so Chromium can load it.`,
    );
  }
  return localPath.split(sep).join('/');
}

function safeStaticPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }

  const relativePath = decoded.replace(/^\/+/, '') || 'src/index.html';
  const path = resolve(root, relativePath);
  const localPath = relative(root, path);

  if (localPath === '..' || localPath.startsWith(`..${sep}`) || isAbsolute(localPath)) {
    return undefined;
  }

  return path;
}

export async function startStaticServer(root = TOOL_ROOT) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = safeStaticPath(root, requestUrl.pathname);

    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': MIME_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream',
    });

    const stream = createReadStream(path);
    stream.on('error', error => {
      console.error(`[oauth-video] Failed to read ${path}: ${error.message}`);
      response.destroy(error);
    });
    stream.pipe(response);
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to determine the compositor server address.');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise, reject) => {
      server.close(error => error ? reject(error) : resolvePromise());
    }),
  };
}

function buildCompositorUrl(options, origin) {
  if (options.url) return options.url;

  const input = options.input.replace(/^\/+/, '');
  const url = new URL(input, `${origin}/`);
  url.searchParams.set('mode', options.mode);
  url.searchParams.set('project', relativeProjectPath(options.project));
  if (options.fps) url.searchParams.set('fps', String(options.fps));
  return url.href;
}

function readinessExpression() {
  return `(async () => {
    const api = window.__oauthVideo;
    if (!api) return null;
    if (api.error) return {error: String(api.error)};
    if (typeof api.seek !== 'function') return null;
    if (api.ready === false) return null;
    if (api.ready && typeof api.ready.then === 'function') await api.ready;
    return {
      fps: Number(api.fps),
      durationMs: Number(api.durationMs),
      totalFrames: Number(api.totalFrames),
    };
  })()`;
}

async function waitForCompositor(
  chrome,
  sessionId,
  {
    timeoutMs,
    pollIntervalMs = 100,
  },
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const metadata = await chrome.evaluate(
        sessionId,
        readinessExpression(),
        { timeoutMs: Math.min(timeoutMs, 5_000) },
      );
      if (metadata?.error) {
        throw new Error(`Compositor initialization failed: ${metadata.error}`);
      }
      if (metadata) return metadata;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Compositor initialization failed:')) {
        throw error;
      }
      lastError = error;
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, pollIntervalMs));
  }

  const bodyText = await chrome.evaluate(
    sessionId,
    'document.body?.innerText?.slice(0, 1000) ?? ""',
    { timeoutMs: 2_000 },
  ).catch(() => '');

  throw new Error(
    `Compositor did not expose a ready window.__oauthVideo API within ${timeoutMs}ms.` +
    `${lastError ? ` Last browser error: ${lastError.message}.` : ''}` +
    `${bodyText ? ` Page text: ${JSON.stringify(bodyText)}` : ''}`,
  );
}

function resolveTiming(options, metadata) {
  const fps = options.fps ?? metadata.fps;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('No valid frame rate was provided by --fps or window.__oauthVideo.fps.');
  }
  if (Number.isFinite(metadata.fps) && Math.abs(metadata.fps - fps) > 0.001) {
    throw new Error(`Renderer/compositor FPS mismatch: encoder=${fps}, compositor=${metadata.fps}.`);
  }

  const compositorFrames = Number.isInteger(metadata.totalFrames) && metadata.totalFrames > 0
    ? metadata.totalFrames
    : Math.ceil((metadata.durationMs / 1000) * fps);
  if (options.startFrame >= compositorFrames) {
    throw new Error(`--start-frame ${options.startFrame} is outside the ${compositorFrames}-frame storyboard.`);
  }
  const totalFrames = options.frames ?? (compositorFrames - options.startFrame);

  if (!Number.isInteger(totalFrames) || totalFrames <= 0) {
    throw new Error(
      'No valid frame count was provided by --frames, totalFrames, or durationMs.',
    );
  }

  return { fps, totalFrames, startFrame: options.startFrame };
}

function seekExpression(frame) {
  return `(async () => {
    const api = window.__oauthVideo;
    if (!api || typeof api.seek !== 'function') {
      throw new Error('window.__oauthVideo.seek(frame) is unavailable');
    }
    await api.seek(${JSON.stringify(frame)});
    if (document.fonts?.ready) await document.fonts.ready;
    const pendingImages = [...document.images]
      .filter(image => !image.complete)
      .map(image => image.decode?.().catch(() => undefined));
    await Promise.all(pendingImages);
    return true;
  })()`;
}

async function captureFrames({
  chrome,
  sessionId,
  framesDir,
  totalFrames,
  startFrame,
  timeoutMs,
}) {
  const digits = Math.max(6, String(totalFrames - 1).length);
  const progressStep = Math.max(1, Math.floor(totalFrames / 20));

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const compositorFrame = startFrame + frame;
    await chrome.evaluate(
      sessionId,
      seekExpression(compositorFrame),
      { timeoutMs },
    );

    const png = await chrome.capturePng(sessionId);
    const filename = `frame-${String(frame).padStart(digits, '0')}.png`;
    await writeFile(join(framesDir, filename), png);

    if (frame === 0 || frame === totalFrames - 1 || (frame + 1) % progressStep === 0) {
      const percent = Math.round(((frame + 1) / totalFrames) * 100);
      console.error(`[oauth-video] Captured ${frame + 1}/${totalFrames} frames (${percent}%)`);
    }
  }

  return { digits };
}

function runFfmpeg(
  executablePath,
  {
    framesDir,
    digits,
    fps,
    totalFrames,
    output,
    narration,
  },
) {
  const inputPattern = join(framesDir, `frame-%0${digits}d.png`);
  const durationSeconds = totalFrames / fps;
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-framerate', String(fps),
    '-start_number', '0',
    '-i', inputPattern,
    '-frames:v', String(totalFrames),
  ];
  if (narration) {
    args.push(
      '-i', narration,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-af', `apad=whole_dur=${durationSeconds}`,
      '-t', String(durationSeconds),
      '-c:a', 'aac',
      '-b:a', '192k',
    );
  } else {
    args.push('-an');
  }
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-threads', '1',
    '-map_metadata', '-1',
    '-metadata', 'creation_time=1970-01-01T00:00:00Z',
    '-movflags', '+faststart',
    output,
  );

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
        ),
      );
    });
  });
}

function binaryVersion(path) {
  for (const flag of ['--version', '-version']) {
    const result = spawnSync(path, [flag], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status === 0) {
      return (result.stdout || result.stderr).split(/\r?\n/, 1)[0].trim();
    }
  }

  return 'version unavailable';
}

function runDoctor(options) {
  const chrome = findChromeExecutable(options.chrome);
  const ffmpeg = findFfmpegExecutable(options.ffmpeg);

  console.error(`[oauth-video] Chromium: ${chrome}`);
  console.error(`[oauth-video]             ${binaryVersion(chrome)}`);
  console.error(`[oauth-video] ffmpeg:  ${ffmpeg}`);
  console.error(`[oauth-video]             ${binaryVersion(ffmpeg)}`);
}

export async function renderVideo(options) {
  validateRenderOptions(options);
  const chromePath = findChromeExecutable(options.chrome);
  const ffmpegPath = findFfmpegExecutable(options.ffmpeg);
  const outputPath = resolveFromRoot(options.output);
  const narrationPath = options.narration
    ? resolveFromRoot(options.narration)
    : undefined;

  if (options.mode === 'final' && !options.url) {
    const result = preflight({ projectArg: options.project, mode: 'final' });
    if (result.errors.length > 0) {
      throw new Error(`Final preflight failed:\n${formatPreflight(result)}`);
    }
  }

  if (!options.url) {
    const inputPath = resolveFromRoot(options.input);
    if (!existsSync(inputPath)) {
      throw new Error(`Compositor entry point not found: ${inputPath}`);
    }

    const projectPath = resolveFromRoot(options.project);
    if (!existsSync(projectPath)) {
      throw new Error(`Project manifest not found: ${projectPath}`);
    }
  }
  if (narrationPath && (!existsSync(narrationPath) || !statSync(narrationPath).isFile())) {
    throw new Error(`Narration audio not found: ${narrationPath}`);
  }

  await mkdir(dirname(outputPath), { recursive: true });

  let temporaryFramesRoot;
  const framesDir = options.framesDir
    ? resolveFromRoot(options.framesDir)
    : await mkdtemp(join(tmpdir(), 'email-agent-oauth-video-'));

  if (!options.framesDir) temporaryFramesRoot = framesDir;
  await mkdir(framesDir, { recursive: true });

  const profileDir = await mkdtemp(join(tmpdir(), 'email-agent-oauth-chrome-'));
  let server;
  let chrome;

  try {
    if (!options.url) server = await startStaticServer(TOOL_ROOT);
    const url = buildCompositorUrl(options, server?.origin);

    const chromeArgs = [
      '--headless',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-breakpad',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-renderer-backgrounding',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      `--user-data-dir=${profileDir}`,
      `--window-size=${options.width},${options.height}`,
    ];
    if (options.noSandbox) chromeArgs.push('--no-sandbox');

    console.error(`[oauth-video] Chromium: ${chromePath}`);
    console.error(`[oauth-video] Compositor: ${url}`);

    chrome = await ChromePipe.launch({
      executablePath: chromePath,
      args: chromeArgs,
      timeoutMs: options.timeoutMs,
    });

    const page = await chrome.createPage();
    await chrome.setViewport(page.sessionId, {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
    });
    await chrome.navigate(page.sessionId, url, { timeoutMs: options.timeoutMs });

    const metadata = await waitForCompositor(chrome, page.sessionId, {
      timeoutMs: options.timeoutMs,
    });
    const timing = resolveTiming(options, metadata);

    console.error(
      `[oauth-video] Rendering ${timing.totalFrames} frames at ${timing.fps} fps ` +
      `(${options.width}x${options.height}), starting at frame ${timing.startFrame}`,
    );

    const frameResult = await captureFrames({
      chrome,
      sessionId: page.sessionId,
      framesDir,
      totalFrames: timing.totalFrames,
      startFrame: timing.startFrame,
      timeoutMs: options.timeoutMs,
    });

    await chrome.close();
    chrome = undefined;

    console.error(`[oauth-video] Encoding H.264: ${outputPath}`);
    await runFfmpeg(ffmpegPath, {
      framesDir,
      digits: frameResult.digits,
      fps: timing.fps,
      totalFrames: timing.totalFrames,
      output: outputPath,
      narration: narrationPath,
    });

    console.error(`[oauth-video] Render complete: ${outputPath}`);
    return outputPath;
  } finally {
    await chrome?.close({ force: true }).catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true });

    if (temporaryFramesRoot && !options.keepFrames) {
      await rm(temporaryFramesRoot, { recursive: true, force: true });
    } else {
      console.error(`[oauth-video] PNG frames: ${framesDir}`);
    }
  }
}

async function main() {
  const options = parseRenderArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.doctor) {
    runDoctor(options);
    return;
  }

  await renderVideo(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[oauth-video] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
