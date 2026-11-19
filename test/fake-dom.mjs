// A deliberately small DOM stand-in: just enough of Element/Document semantics
// for captureForContextMenu() (attribute selectors, cloning, serialization).
const VOID = new Set(['link', 'meta', 'img', 'br', 'hr', 'input', 'source', 'track', 'embed', 'area', 'base', 'wbr', 'col']);
const RAW_TEXT = new Set(['style', 'script']);

const escapeAttribute = value => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const escapeText = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function attach(node, children) {
  for (const child of children) if (child && typeof child === 'object') child.parent = node;
}

export function element(tag, attributes = {}, children = [], options = {}) {
  const attrs = new Map(Object.entries(attributes).map(([name, value]) => [name, String(value)]));
  const node = {
    parent: null,
    localName: tag,
    namespaceURI: options.namespace || 'http://www.w3.org/1999/xhtml',
    children,
    textContent: options.text ?? '',
    hasAttribute: name => attrs.has(name),
    getAttribute: name => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    remove() {
      if (!node.parent) return;
      node.parent.children = node.parent.children.filter(child => child !== node);
      node.parent = null;
    },
    get attributes() { return Object.fromEntries(attrs); },
    cloneNode(deep = false) {
      const copy = element(tag, Object.fromEntries(attrs), deep ? children.map(child => (child.cloneNode ? child.cloneNode(true) : child)) : [], options);
      copy.textContent = this.textContent;
      return copy;
    },
    querySelectorAll(selector) {
      return query([node], selector);
    },
    get outerHTML() {
      return serialize(node);
    },
  };
  attach(node, children);
  return node;
}

function* descendants(nodes) {
  for (const node of nodes) {
    if (!node || typeof node === 'string') continue;
    yield node;
    yield* descendants(node.children);
  }
}

function matches(node, selector) {
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const prefixed = /^\[([\w-]+)\^=["']?([^"'\]]*)["']?\]$/.exec(selector);
    if (prefixed) {
      const value = node.getAttribute(prefixed[1]);
      return value != null && value.startsWith(prefixed[2]);
    }
    return node.hasAttribute(selector.slice(1, -1));
  }
  return node.localName === selector.toLowerCase();
}

export function query(roots, selector) {
  const selectors = selector.split(',').map(part => part.trim()).filter(Boolean);
  const found = [];
  for (const node of descendants(roots)) {
    if (selectors.some(candidate => matches(node, candidate)) && !found.includes(node)) found.push(node);
  }
  return found;
}

function serialize(node) {
  if (typeof node === 'string') return escapeText(node);
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  if (VOID.has(node.localName)) return `<${node.localName}${attributes}>`;
  const inner = RAW_TEXT.has(node.localName)
    ? (node.textContent || '')
    : (node.textContent || '') + node.children.map(serialize).join('');
  return `<${node.localName}${attributes}>${inner}</${node.localName}>`;
}

export function document({ title, url, root }) {
  return {
    baseURI: url,
    title,
    documentElement: root,
    querySelectorAll: selector => query([root], selector),
  };
}
