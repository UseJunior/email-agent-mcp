import {existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs, positiveNumber} from './args.mjs';
import {readProject, resolveMediaPath} from './project-io.mjs';
import {fromToolRoot, toolRoot} from './paths.mjs';
import {captureRequirements} from '../src/core/project.mjs';
import {scenes} from '../src/storyboard.mjs';

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr.trim()}`);
  }
}

function safeCaptureId(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Unsafe capture ID: ${id}`);
  return id;
}

export function normalizeCaptures({
  projectArg = 'project.local.json',
  fps = 30,
  ffmpeg = process.env.OAUTH_VIDEO_FFMPEG || 'ffmpeg',
  workDir = '.work',
} = {}) {
  if (!/^\.work(?:\/[a-zA-Z0-9._-]+)*$/.test(workDir)) {
    throw new Error('workDir must be .work or a safe directory beneath .work');
  }
  const {project} = readProject(projectArg);
  const outputRoot = fromToolRoot(`${workDir}/captures`);
  mkdirSync(outputRoot, {recursive: true});

  const renderProject = structuredClone(project);
  const results = [];
  for (const requirement of captureRequirements(scenes)) {
    const capture = renderProject?.captures?.[requirement.id];
    if (!capture?.file) {
      results.push({id: requirement.id, skipped: true, reason: 'missing'});
      continue;
    }

    const input = resolveMediaPath(capture.file);
    if (!existsSync(input)) {
      throw new Error(`${requirement.id}: capture file does not exist: ${capture.file}`);
    }
    if (capture.kind === 'image') {
      results.push({id: requirement.id, skipped: true, reason: 'static-image'});
      continue;
    }

    const id = safeCaptureId(requirement.id);
    const outputDir = fromToolRoot(`${workDir}/captures/${id}`);
    // This directory is a generated, gitignored cache scoped by a validated
    // capture ID. Clear it so a shorter replacement recording cannot retain
    // stale tail frames from an earlier normalization.
    rmSync(outputDir, {recursive: true, force: true});
    mkdirSync(outputDir, {recursive: true});
    const outputPattern = `${outputDir}/frame-%06d.jpg`;

    run(ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', input,
      '-vf', `fps=${fps},scale=1600:720:force_original_aspect_ratio=decrease,pad=1600:720:(ow-iw)/2:(oh-ih)/2:color=0x07101f,setsar=1`,
      '-q:v', '2',
      '-start_number', '0',
      outputPattern,
    ]);

    const frameCount = readdirSync(outputDir)
      .filter(name => /^frame-\d{6}\.jpg$/.test(name))
      .length;
    if (frameCount === 0) {
      throw new Error(`${requirement.id}: ffmpeg produced no capture frames`);
    }

    Object.assign(capture, {
      kind: 'video',
      frames: `${workDir}/captures/${id}/frame-%06d.jpg`,
      fps,
      startFrame: 0,
      frameCount,
    });
    results.push({id, frameCount});
  }

  const renderProjectPath = fromToolRoot(`${workDir}/project.render.json`);
  writeFileSync(renderProjectPath, `${JSON.stringify(renderProject, null, 2)}\n`);
  return {
    projectPath: relative(toolRoot, renderProjectPath),
    captures: results,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = normalizeCaptures({
      projectArg: args.project === true ? undefined : args.project,
      fps: positiveNumber(args.fps, 30, 'fps'),
      ffmpeg: args.ffmpeg === true ? undefined : args.ffmpeg,
    });
    for (const capture of result.captures) {
      if (capture.skipped) {
        process.stderr.write(`SKIP ${capture.id} (${capture.reason})\n`);
      } else {
        process.stderr.write(`OK   ${capture.id} (${capture.frameCount} frames)\n`);
      }
    }
    process.stderr.write(`Wrote ${result.projectPath}\n`);
  } catch (error) {
    process.stderr.write(`Capture normalization failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
