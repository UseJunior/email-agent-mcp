import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRenderArgs} from '../scripts/render.mjs';

test('renderer defaults to the watermarked storyboard project', () => {
  const options = parseRenderArgs([]);
  assert.equal(options.mode, 'storyboard');
  assert.equal(options.project, 'project.example.json');
  assert.equal(options.output, 'dist/oauth-verification-storyboard.mp4');
  assert.equal(options.width, 1920);
  assert.equal(options.height, 1080);
});

test('renderer accepts the reviewed final-mode project and format', () => {
  const options = parseRenderArgs([
    '--mode', 'final',
    '--project', '.work/project.render.json',
    '--fps', '30',
    '--output', 'dist/final.mp4',
  ]);
  assert.equal(options.mode, 'final');
  assert.equal(options.fps, 30);
  assert.equal(options.startFrame, 0);
  assert.equal(options.frames, undefined);
  assert.equal(options.output, 'dist/final.mp4');
});

test('renderer rejects invalid modes and frame counts', () => {
  assert.throws(() => parseRenderArgs(['--mode', 'preview']), /storyboard or final/);
  assert.throws(() => parseRenderArgs(['--frames', '1.5']), /positive integer/);
  assert.throws(() => parseRenderArgs(['--mode', 'final', '--frames', '1']), /complete timeline/);
  assert.throws(() => parseRenderArgs(['--mode', 'final', '--url', 'http:\/\/127.0.0.1']), /validated local project/);
  assert.throws(() => parseRenderArgs(['--mode', 'final', '--input', 'src/other.html']), /reviewed compositor/);
  assert.throws(() => parseRenderArgs(['--fps', '1000']), /must not exceed 60/);
  assert.throws(() => parseRenderArgs(['--mode', 'final', '--width', '1']), /1920x1080, 30 fps/);
});
