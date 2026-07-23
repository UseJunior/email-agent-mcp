import {append, element, eyebrow, setTransform} from '../components/dom.mjs';
import {easeInOutCubic, easeOutCubic, windowedProgress} from '../core/math.mjs';

function architectureNode(kind, title, detail) {
  const node = element('div', `architecture-node architecture-node--${kind}`);
  const glyph = element('div', 'architecture-glyph');
  glyph.innerHTML = kind === 'local'
    ? '<span>&gt;_</span>'
    : kind === 'broker'
      ? '<span>↻</span>'
      : '<span>M</span>';
  append(
    node,
    glyph,
    element('h3', 'architecture-node-title', title),
    element('p', 'architecture-node-detail', detail),
  );
  return node;
}

export function mountArchitecture(scene) {
  const root = element('section', 'scene scene--architecture');
  const heading = element('div', 'architecture-heading');
  append(
    heading,
    eyebrow('Data flow'),
    element('h2', 'architecture-title', scene.title),
  );

  const map = element('div', 'architecture-map');
  const local = architectureNode('local', 'Local Email Agent MCP', 'User-controlled process');
  const broker = architectureNode('broker', 'OAuth broker', 'Code exchange + refresh only');
  const gmail = architectureNode('gmail', 'Google Gmail API', 'Messages, threads, send + reply');

  const authPath = element('div', 'architecture-path architecture-path--auth');
  append(
    authPath,
    element('span', 'architecture-path-label', 'OAuth codes & tokens'),
    element('span', 'architecture-path-line'),
    element('span', 'architecture-packet architecture-packet--auth'),
  );

  const dataPath = element('div', 'architecture-path architecture-path--data');
  append(
    dataPath,
    element('span', 'architecture-path-label', 'Direct Gmail API traffic'),
    element('span', 'architecture-path-line'),
    element('span', 'architecture-packet architecture-packet--data'),
  );

  const boundary = element('div', 'broker-boundary');
  append(
    boundary,
    element('span', 'broker-boundary-check', '✓'),
    element('span', 'broker-boundary-copy', 'No email content'),
  );

  append(map, local, broker, gmail, authPath, dataPath, boundary);
  append(root, heading, map);

  return {
    element: root,
    async render({localMs, durationMs}) {
      const headingIn = easeOutCubic(windowedProgress(localMs, 100, 850));
      heading.style.opacity = String(headingIn);
      setTransform(heading, {y: (1 - headingIn) * 35});

      [local, broker, gmail].forEach((node, index) => {
        const amount = easeOutCubic(windowedProgress(localMs, 500 + index * 260, 800));
        node.style.opacity = String(amount);
        setTransform(node, {y: (1 - amount) * 45, scale: 0.97 + amount * 0.03});
      });

      const lines = easeInOutCubic(windowedProgress(localMs, 1_400, 1_000));
      authPath.style.opacity = String(lines);
      dataPath.style.opacity = String(lines);
      boundary.style.opacity = String(easeOutCubic(windowedProgress(localMs, 2_300, 700)));

      const activeWindow = Math.max(1, durationMs - 3_100);
      const packetProgress = ((Math.max(0, localMs - 2_000) % 2_600) / 2_600);
      const authProgress = ((Math.max(0, localMs - 2_450) % 3_100) / 3_100);
      const dataPacket = dataPath.querySelector('.architecture-packet');
      const authPacket = authPath.querySelector('.architecture-packet');
      dataPacket.style.left = `${10 + packetProgress * 80}%`;
      authPacket.style.left = `${10 + authProgress * 34}%`;
      authPacket.style.opacity = String(localMs < 2_450 ? 0 : Math.min(1, activeWindow));
    },
  };
}
