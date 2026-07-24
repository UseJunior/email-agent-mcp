import {
  append,
  browserChrome,
  caption,
  element,
  eyebrow,
  scopeChip,
  setTransform,
} from '../components/dom.mjs';
import {easeInOutCubic, easeOutCubic, windowedProgress} from '../core/math.mjs';
import {projectCapture} from '../core/project.mjs';

function servedAssetUrl(path) {
  if (!path) return null;
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  return `/${path.replace(/^\.?\//, '')}`;
}

function numberedFrame(pattern, frameNumber) {
  const match = pattern.match(/%(0?)(\d*)d/);
  if (!match) return pattern;
  const width = Number(match[2] || 0);
  return pattern.replace(match[0], String(frameNumber).padStart(width, '0'));
}

function captureFrameNumber(capture, localMs) {
  const fps = capture.fps ?? 30;
  const sourceMs = Math.max(0, localMs + (capture.inMs ?? 0));
  const firstFrame = capture.startFrame ?? 0;
  const requested = firstFrame + Math.floor((sourceMs * fps) / 1000);
  const lastFrame = capture.frameCount
    ? firstFrame + capture.frameCount - 1
    : requested;
  return Math.min(requested, lastFrame);
}

function placeholder(scene) {
  const node = element('div', 'capture-placeholder');
  const badge = element('div', 'capture-placeholder-badge', 'STORYBOARD PLACEHOLDER');
  const icon = element('div', 'capture-placeholder-icon');
  icon.innerHTML = '<span></span><span></span><span></span>';
  append(
    node,
    badge,
    icon,
    element('h3', 'capture-placeholder-title', 'Record authentic interaction'),
    element('p', 'capture-placeholder-copy', scene.recordingInstruction),
    element('p', 'capture-placeholder-footnote', 'Generated UI must not replace this evidence in Google’s final review video.'),
  );
  return node;
}

export function mountCapture(scene, context) {
  const capture = projectCapture(context.project, scene.capture);
  const root = element('section', 'scene scene--capture');
  const header = element('header', 'scene-header');
  const chapter = element('div', 'chapter-number', scene.chapter);
  const headerCopy = element('div', 'scene-header-copy');
  append(
    headerCopy,
    eyebrow('Reviewer evidence'),
    element('h2', 'scene-title', scene.title),
  );
  append(header, chapter, headerCopy, scopeChip());

  const {shell, viewport} = browserChrome(scene.capture);
  const image = element('img', 'capture-image');
  image.alt = '';
  image.draggable = false;

  const hasFrames = Boolean(capture.frames);
  const hasStaticImage = capture.kind === 'image' && capture.file;
  const missing = !hasFrames && !hasStaticImage;
  const placeholderNode = missing ? placeholder(scene) : null;

  if (hasFrames || hasStaticImage) {
    viewport.append(image);
  } else {
    viewport.append(placeholderNode);
  }

  const footer = element('div', 'capture-footer');
  const captionNode = caption(scene.caption);
  const progress = element('div', 'capture-progress');
  const progressBar = element('div', 'capture-progress-bar');
  progress.append(progressBar);
  append(footer, captionNode, progress);
  append(root, header, shell, footer);

  let loadedSrc = '';
  async function showSource(localMs) {
    let source = null;
    if (hasFrames) {
      source = numberedFrame(capture.frames, captureFrameNumber(capture, localMs));
    } else if (hasStaticImage) {
      source = capture.file;
    }
    if (!source) return;

    const nextSrc = servedAssetUrl(source);
    if (nextSrc === loadedSrc) return;
    loadedSrc = nextSrc;
    image.src = nextSrc;
    if (typeof image.decode === 'function') {
      try {
        await image.decode();
      } catch {
        throw new Error(`Unable to decode capture frame for ${scene.capture}: ${source}`);
      }
    }
  }

  return {
    element: root,
    async render({localMs, durationMs}) {
      await showSource(localMs);
      const reveal = easeOutCubic(windowedProgress(localMs, 120, 700));
      const shellReveal = easeOutCubic(windowedProgress(localMs, 350, 900));
      const outro = 1 - easeInOutCubic(windowedProgress(localMs, durationMs - 450, 450));
      const opacity = Math.min(reveal, outro);
      header.style.opacity = String(opacity);
      shell.style.opacity = String(Math.min(shellReveal, outro));
      setTransform(shell, {
        y: (1 - shellReveal) * 38,
        scale: 0.975 + shellReveal * 0.025,
      });
      footer.style.opacity = String(Math.min(shellReveal, outro));
      progressBar.style.width = `${Math.min(100, (localMs / durationMs) * 100)}%`;
      if (placeholderNode) {
        const pulse = 0.985 + Math.sin(localMs / 700) * 0.008;
        placeholderNode.style.transform = `scale(${pulse})`;
      }
    },
  };
}
