import {append, brandMark, element, eyebrow, scopeChip, setTransform} from '../components/dom.mjs';
import {easeOutCubic, windowedProgress} from '../core/math.mjs';

export function mountTitle(scene) {
  const root = element('section', 'scene scene--title');
  const glow = element('div', 'hero-glow');
  const grid = element('div', 'hero-grid');
  const content = element('div', 'hero-content');
  const brand = element('div', 'hero-brand');
  append(brand, brandMark(), element('span', 'hero-brand-name', 'UseJunior'));

  const tag = eyebrow(scene.eyebrow);
  const title = element('h1', 'hero-title', scene.title);
  const subtitle = element('p', 'hero-subtitle', scene.subtitle);
  const chip = scopeChip();
  append(content, brand, tag, title, subtitle, chip);
  append(root, glow, grid, content);

  return {
    element: root,
    async render({localMs}) {
      const reveal = easeOutCubic(windowedProgress(localMs, 250, 1_100));
      const detail = easeOutCubic(windowedProgress(localMs, 900, 1_050));
      content.style.opacity = String(reveal);
      setTransform(content, {y: (1 - reveal) * 70});
      subtitle.style.opacity = String(detail);
      chip.style.opacity = String(detail);
      chip.style.transform = `translateY(${(1 - detail) * 20}px)`;
      glow.style.transform = `translate3d(${Math.sin(localMs / 1_900) * 20}px, ${Math.cos(localMs / 2_300) * 14}px, 0)`;
    },
  };
}
