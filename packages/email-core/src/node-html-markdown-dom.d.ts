// Minimal DOM type shims for node-html-markdown (which references browser DOM types).
// The library uses node-html-parser at runtime, not actual browser DOM, but its .d.ts
// files reference global DOM types. This shim satisfies the type checker.

declare global {
  interface Node {
    childNodes: NodeList;
    parentNode: Node | null;
    textContent: string | null;
  }

  interface NodeList {
    readonly length: number;
    [index: number]: Node;
  }

  interface HTMLElement extends Node {
    tagName: string;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    setAttribute(name: string, value: string): void;
  }
}

export {};
