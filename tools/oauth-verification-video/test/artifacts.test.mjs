import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNarration,
  buildShotList,
  buildSubtitles,
} from '../scripts/generate-artifacts.mjs';
import {scenes} from '../src/storyboard.mjs';

test('companion artifacts derive every scene from the storyboard', () => {
  const shotList = buildShotList();
  const narration = buildNarration();
  const subtitles = buildSubtitles();

  for (const scene of scenes) {
    assert.ok(shotList.includes(scene.title), `shot list missing ${scene.id}`);
    assert.ok(narration.includes(scene.narration), `narration missing ${scene.id}`);
    assert.ok(subtitles.includes(scene.narration), `subtitles missing ${scene.id}`);
  }
  assert.match(subtitles, /^WEBVTT\n/);
  assert.match(shotList, /authentic interactions/i);
});
