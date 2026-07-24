import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {captureRequirements, validateProjectShape} from '../src/core/project.mjs';
import {scenes} from '../src/storyboard.mjs';

function exampleProject() {
  return JSON.parse(readFileSync(new URL('../project.example.json', import.meta.url), 'utf8'));
}

test('storyboard mode allows missing media only as explicit warnings', () => {
  const result = validateProjectShape(exampleProject(), scenes, 'storyboard');
  assert.deepEqual(result.errors, []);
  assert.equal(result.requirements.length, 8);
  assert.equal(result.warnings.length, 8);
  assert.match(result.warnings[0], /Storyboard placeholder/);
});

test('final mode fails closed on missing evidence and attestations', () => {
  const result = validateProjectShape(exampleProject(), scenes, 'final');
  assert.ok(result.errors.some(error => error.includes('Missing authentic capture')));
  assert.ok(result.errors.some(error => error.includes('dedicatedTestMailbox')));
  assert.ok(result.errors.some(error => error.includes('authenticUneditedInteractions')));
});

test('final mode accepts structurally complete authentic evidence', () => {
  const project = exampleProject();
  for (const capture of Object.values(project.captures)) {
    capture.file = 'captures/authentic.mov';
    capture.kind = 'video';
    capture.frames = '.work/captures/authentic/frame-%06d.jpg';
    capture.frameCount = 3_000;
    capture.fps = 30;
  }
  for (const key of Object.keys(project.attestations)) {
    project.attestations[key] = true;
  }
  project.submission.productionOAuthClients[0].clientId = 'review-client.apps.googleusercontent.com';

  const result = validateProjectShape(project, scenes, 'final');
  assert.deepEqual(result.errors, []);
});

test('final mode rejects an uncovered or non-Web OAuth client inventory', () => {
  const project = exampleProject();
  project.submission.productionOAuthClients.push({
    name: 'Legacy Desktop',
    type: 'Desktop app',
    coveredByCapture: null,
  });
  const result = validateProjectShape(project, scenes, 'final');
  assert.ok(result.errors.some(error => error.includes('exactly one OAuth client')));
});

test('final mode requires an audited inventory and the full Web client ID', () => {
  const project = exampleProject();
  project.attestations.oauthClientInventoryAudited = false;
  const result = validateProjectShape(project, scenes, 'final');
  assert.ok(result.errors.some(error => error.includes('oauthClientInventoryAudited')));
  assert.ok(result.errors.some(error => error.includes('full non-secret client ID')));
});

test('final mode rejects a static path disguised as normalized video', () => {
  const project = exampleProject();
  const capture = project.captures.identity;
  capture.file = 'captures/authentic.mov';
  capture.kind = 'video';
  capture.frames = 'captures/frozen.jpg';
  capture.frameCount = 1;
  capture.fps = 30;
  const result = validateProjectShape(project, scenes, 'final');
  assert.ok(result.errors.some(error => error.includes('normalized to a frame sequence')));
  assert.ok(result.errors.some(error => error.includes('usable after inMs')));
});

test('final mode validates usable duration after a non-negative inMs offset', () => {
  const project = exampleProject();
  for (const capture of Object.values(project.captures)) {
    capture.file = 'captures/authentic.mov';
    capture.kind = 'video';
    capture.frames = '.work/captures/authentic/frame-%06d.jpg';
    capture.frameCount = 3_000;
    capture.fps = 30;
  }
  project.captures.identity.inMs = 90_000;
  project.captures.read.inMs = -1;
  for (const key of Object.keys(project.attestations)) project.attestations[key] = true;
  project.submission.productionOAuthClients[0].clientId = 'review-client.apps.googleusercontent.com';

  const result = validateProjectShape(project, scenes, 'final');
  assert.ok(result.errors.some(error => error.includes('identity: authentic capture needs')));
  assert.ok(result.errors.some(error => error.includes('read: inMs must be a non-negative')));
});

test('capture requirements are unique and interactive', () => {
  const requirements = captureRequirements(scenes);
  assert.equal(new Set(requirements.map(item => item.id)).size, requirements.length);
  assert.ok(requirements.every(item => item.requiredKind === 'video'));
});
