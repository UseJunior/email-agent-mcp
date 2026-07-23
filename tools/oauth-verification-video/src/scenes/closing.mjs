import {append, brandMark, element, eyebrow, setTransform} from '../components/dom.mjs';
import {easeOutCubic, windowedProgress} from '../core/math.mjs';

export function mountClosing(scene) {
  const root = element('section', 'scene scene--closing');
  const card = element('div', 'closing-card');
  const heading = element('div', 'closing-heading');
  append(
    heading,
    brandMark(),
    eyebrow(scene.eyebrow),
    element('h2', 'closing-title', scene.title),
  );

  const points = element('ul', 'closing-points');
  for (const point of scene.points) {
    const item = element('li', 'closing-point');
    append(item, element('span', 'closing-check', '✓'), element('span', '', point));
    points.append(item);
  }
  append(card, heading, points, element('p', 'closing-url', 'usejunior.com/products/email-agent-mcp'));
  root.append(card);

  return {
    element: root,
    async render({localMs}) {
      const cardIn = easeOutCubic(windowedProgress(localMs, 100, 850));
      card.style.opacity = String(cardIn);
      setTransform(card, {y: (1 - cardIn) * 55, scale: 0.98 + cardIn * 0.02});
      [...points.children].forEach((item, index) => {
        const reveal = easeOutCubic(windowedProgress(localMs, 900 + index * 350, 600));
        item.style.opacity = String(reveal);
        setTransform(item, {x: (1 - reveal) * 30});
      });
    },
  };
}
