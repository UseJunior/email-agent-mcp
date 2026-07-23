import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTimeline,
  formatTimestamp,
  frameToMilliseconds,
  sceneAt,
  totalFrames,
} from '../src/core/timeline.mjs';

test('compileTimeline derives contiguous deterministic scene boundaries', () => {
  const timeline = compileTimeline([
    {id: 'one', durationMs: 1_000},
    {id: 'two', durationMs: 2_500},
  ]);

  assert.equal(timeline.durationMs, 3_500);
  assert.deepEqual(
    timeline.scenes.map(({id, startMs, endMs}) => ({id, startMs, endMs})),
    [
      {id: 'one', startMs: 0, endMs: 1_000},
      {id: 'two', startMs: 1_000, endMs: 3_500},
    ],
  );
  assert.equal(sceneAt(timeline, 999).id, 'one');
  assert.equal(sceneAt(timeline, 1_000).id, 'two');
  assert.equal(sceneAt(timeline, 99_000).id, 'two');
});

test('compileTimeline rejects non-positive durations', () => {
  assert.throws(
    () => compileTimeline([{id: 'broken', durationMs: 0}]),
    /positive durationMs/,
  );
});

test('frame and subtitle timing helpers preserve explicit rates', () => {
  assert.equal(frameToMilliseconds(12, 12), 1_000);
  assert.equal(totalFrames(1_001, 12), 13);
  assert.equal(formatTimestamp(3_723_004), '01:02:03.004');
  assert.equal(formatTimestamp(63_000, false), '00:01:03');
});
