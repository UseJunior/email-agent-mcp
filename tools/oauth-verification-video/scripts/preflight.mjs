import {existsSync, statSync} from 'node:fs';
import {extname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from './args.mjs';
import {readProject, resolveMediaPath} from './project-io.mjs';
import {toolRoot} from './paths.mjs';
import {validateProjectShape} from '../src/core/project.mjs';
import {scenes} from '../src/storyboard.mjs';

const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

function numberedFrame(pattern, frameNumber) {
  const match = pattern.match(/%(0?)(\d*)d/);
  if (!match) return pattern;
  const width = Number(match[2] || 0);
  return pattern.replace(match[0], String(frameNumber).padStart(width, '0'));
}

export function preflight({projectArg = 'project.example.json', mode = 'storyboard'} = {}) {
  if (!['storyboard', 'final'].includes(mode)) {
    throw new Error('mode must be storyboard or final');
  }

  const {path, project} = readProject(projectArg);
  const validation = validateProjectShape(project, scenes, mode);
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];

  for (const requirement of validation.requirements) {
    const capture = project?.captures?.[requirement.id];
    if (!capture?.file) continue;
    const mediaPath = resolveMediaPath(capture.file);
    if (!existsSync(mediaPath) || !statSync(mediaPath).isFile()) {
      errors.push(`${requirement.id}: capture file does not exist: ${capture.file}`);
      continue;
    }
    if (mode === 'final' && requirement.requiredKind === 'video') {
      const extension = extname(mediaPath).toLowerCase();
      if (capture.kind === 'image' || IMAGE_EXTENSIONS.has(extension)) {
        errors.push(`${requirement.id}: ${capture.file} is static; final interactive evidence must be video`);
      }
      if (capture.frames && Number.isInteger(capture.frameCount) && capture.frameCount > 0) {
        const firstFrame = capture.startFrame ?? 0;
        const lastFrame = firstFrame + capture.frameCount - 1;
        for (const [label, frame] of [['first', firstFrame], ['last', lastFrame]]) {
          const framePath = resolveMediaPath(numberedFrame(capture.frames, frame));
          if (!existsSync(framePath) || !statSync(framePath).isFile()) {
            errors.push(`${requirement.id}: normalized ${label} frame does not exist: ${numberedFrame(capture.frames, frame)}`);
          }
        }
      }
    }
  }

  return {
    mode,
    projectPath: relative(toolRoot, path),
    errors,
    warnings,
    requirements: validation.requirements,
  };
}

export function formatPreflight(result) {
  const lines = [
    `OAuth verification video preflight (${result.mode})`,
    `Project: ${result.projectPath}`,
    `Required captures: ${result.requirements.length}`,
  ];
  for (const warning of result.warnings) lines.push(`WARN  ${warning}`);
  for (const error of result.errors) lines.push(`ERROR ${error}`);
  lines.push(result.errors.length === 0 ? 'PASS' : `FAIL (${result.errors.length} error${result.errors.length === 1 ? '' : 's'})`);
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedPath) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = preflight({
      projectArg: args.project === true ? undefined : args.project,
      mode: args.mode === true ? undefined : args.mode,
    });
    process.stderr.write(`${formatPreflight(result)}\n`);
    process.exitCode = result.errors.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
