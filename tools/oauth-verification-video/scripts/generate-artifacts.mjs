import {mkdirSync, writeFileSync} from 'node:fs';
import {compileTimeline, formatTimestamp} from '../src/core/timeline.mjs';
import {scenes} from '../src/storyboard.mjs';
import {fromToolRoot} from './paths.mjs';

const timeline = compileTimeline(scenes);

export function buildShotList() {
  const lines = [
    '# Google OAuth verification shot list',
    '',
    '> Generated from `src/storyboard.mjs`. Do not edit timestamps here.',
    '>',
    '> Final footage must show authentic interactions. Animation is used only for framing, labels, and the data-flow explanation.',
    '',
  ];
  for (const scene of timeline.scenes) {
    lines.push(`## ${formatTimestamp(scene.startMs, false)}–${formatTimestamp(scene.endMs, false)} — ${scene.title}`);
    lines.push('');
    if (scene.type === 'capture') {
      lines.push(`Capture ID: \`${scene.capture}\``);
      lines.push('');
      lines.push(scene.recordingInstruction);
    } else {
      lines.push(`Generated ${scene.type} scene; no authentic capture required.`);
    }
    lines.push('');
    lines.push(`Narration: ${scene.narration}`);
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

export function buildNarration() {
  const lines = [
    '# Narration script',
    '',
    '> Generated from `src/storyboard.mjs`.',
    '',
  ];
  for (const scene of timeline.scenes) {
    lines.push(`- **${formatTimestamp(scene.startMs, false)} — ${scene.title}:** ${scene.narration}`);
  }
  return `${lines.join('\n')}\n`;
}

export function buildSubtitles() {
  const lines = ['WEBVTT', ''];
  for (const [index, scene] of timeline.scenes.entries()) {
    const start = scene.startMs + 350;
    const end = Math.max(start + 500, scene.endMs - 350);
    lines.push(String(index + 1));
    lines.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}`);
    lines.push(scene.narration);
    lines.push('');
  }
  return lines.join('\n');
}

export function generateArtifacts() {
  const outputDir = fromToolRoot('review');
  mkdirSync(outputDir, {recursive: true});
  writeFileSync(`${outputDir}/SHOT_LIST.md`, buildShotList());
  writeFileSync(`${outputDir}/NARRATION.md`, buildNarration());
  writeFileSync(`${outputDir}/subtitles.vtt`, buildSubtitles());
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  generateArtifacts();
  process.stderr.write('Generated review/SHOT_LIST.md, review/NARRATION.md, and review/subtitles.vtt\n');
}
