export function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

export function append(parent, ...children) {
  parent.append(...children.filter(Boolean));
  return parent;
}

export function brandMark() {
  const mark = element('div', 'brand-mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = `
    <svg viewBox="0 0 64 64" role="img">
      <path d="M10 17.5 32 35l22-17.5" />
      <rect x="8" y="14" width="48" height="36" rx="10" />
      <path d="m9.5 47 16-16M54.5 47l-16-16" />
    </svg>`;
  return mark;
}

export function scopeChip(label = 'gmail.modify') {
  return element('span', 'scope-chip', label);
}

export function eyebrow(text) {
  return element('p', 'eyebrow', text);
}

export function caption(text) {
  const node = element('div', 'caption');
  append(
    node,
    element('span', 'caption-dot'),
    element('span', 'caption-text', text),
  );
  return node;
}

export function browserChrome(title) {
  const shell = element('div', 'capture-shell');
  const toolbar = element('div', 'capture-toolbar');
  const dots = element('div', 'window-dots');
  append(
    dots,
    element('span', 'window-dot window-dot--red'),
    element('span', 'window-dot window-dot--yellow'),
    element('span', 'window-dot window-dot--green'),
  );
  append(
    toolbar,
    dots,
    element('div', 'capture-address', title),
    element('div', 'capture-secure', 'AUTHENTIC CAPTURE'),
  );
  const viewport = element('div', 'capture-viewport');
  append(shell, toolbar, viewport);
  return {shell, viewport};
}

export function setTransform(node, {x = 0, y = 0, scale = 1} = {}) {
  node.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
}
