import {compileTimeline, frameToMilliseconds, sceneAt, totalFrames} from './core/timeline.mjs';
import {validateProjectShape} from './core/project.mjs';
import {scenes, videoFormat} from './storyboard.mjs';
import {mountArchitecture} from './scenes/architecture.mjs';
import {mountCapture} from './scenes/capture.mjs';
import {mountClosing} from './scenes/closing.mjs';
import {mountTitle} from './scenes/title.mjs';

const sceneMounts = {
  architecture: mountArchitecture,
  capture: mountCapture,
  closing: mountClosing,
  title: mountTitle,
};

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') === 'final' ? 'final' : 'storyboard';
const projectName = params.get('project') || 'project.example.json';
const requestedFps = Number(params.get('fps') || videoFormat.fps);
const runtimeFps = Number.isFinite(requestedFps) && requestedFps > 0 && requestedFps <= 60
  ? requestedFps
  : videoFormat.fps;
const root = document.querySelector('#video-root');
const timeline = compileTimeline(scenes);

window.__oauthVideo = {
  ready: false,
  fps: runtimeFps,
  durationMs: timeline.durationMs,
  totalFrames: totalFrames(timeline.durationMs, runtimeFps),
  error: null,
  seek: async () => {
    throw new Error('Video runtime is not ready');
  },
};

function safeProjectPath(name) {
  const normalized = name.replace(/^\/+/, '');
  if (normalized.includes('..')) {
    throw new Error('Project path may not traverse outside the tool directory');
  }
  return `/${normalized}`;
}

async function loadProject() {
  const response = await fetch(safeProjectPath(projectName), {cache: 'no-store'});
  if (!response.ok) {
    throw new Error(`Unable to load project manifest ${projectName} (${response.status})`);
  }
  return response.json();
}

function showFatal(error) {
  root.innerHTML = '';
  const panel = document.createElement('section');
  panel.className = 'fatal-panel';
  const title = document.createElement('h1');
  title.textContent = 'Video compositor failed';
  const message = document.createElement('pre');
  message.textContent = error instanceof Error ? error.message : String(error);
  panel.append(title, message);
  root.append(panel);
}

function storyboardWatermark() {
  const watermark = document.createElement('div');
  watermark.className = 'storyboard-watermark';
  watermark.textContent = 'STORYBOARD  ·  NOT FOR GOOGLE SUBMISSION';
  return watermark;
}

try {
  const project = await loadProject();
  const validation = validateProjectShape(project, scenes, mode);
  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join('\n'));
  }

  let mounted = null;
  let mountedSceneId = null;

  async function seek(frame) {
    const safeFrame = Math.max(0, Math.min(Number(frame) || 0, window.__oauthVideo.totalFrames - 1));
    const timeMs = frameToMilliseconds(safeFrame, window.__oauthVideo.fps);
    const scene = sceneAt(timeline, timeMs);
    if (!scene) throw new Error('Storyboard has no scenes');

    if (scene.id !== mountedSceneId) {
      const mount = sceneMounts[scene.type];
      if (!mount) throw new Error(`Unknown scene type: ${scene.type}`);
      mounted = mount(scene, {project, mode, videoFormat});
      mountedSceneId = scene.id;
      root.replaceChildren(mounted.element);
      if (mode === 'storyboard') root.append(storyboardWatermark());
    }

    document.body.dataset.scene = scene.id;
    document.body.dataset.mode = mode;
    await mounted.render({
      localMs: timeMs - scene.startMs,
      durationMs: scene.durationMs,
      absoluteMs: timeMs,
      frame: safeFrame,
    });

    return {
      frame: safeFrame,
      timeMs,
      sceneId: scene.id,
    };
  }

  window.__oauthVideo.seek = seek;
  await seek(0);
  window.__oauthVideo.ready = true;
} catch (error) {
  window.__oauthVideo.error = error instanceof Error ? error.message : String(error);
  showFatal(error);
}
