'use strict';

// A very small DOM for the portal tab's smoke test (the repository has no browser harness): just what ui/portal.js
// uses — elements with attributes, classes, text, events, form fields — plus a parser for the plain HTML that
// server/ui.js renders (tags, quoted attributes, text, <style> and <script> bodies). Not a browser: no layout, no
// CSS; scripts run in a vm context whose global object is the window.

const vm = require('node:vm');

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENT[e]);

class Node {
  constructor(doc) { this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('not a child');
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new Text(this.ownerDocument, String(v)));
  }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.data = data; this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get nodeValue() { return this.data; }
}

class Element extends Node {
  constructor(doc, tag, ns) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.namespaceURI = ns || null;
    this.attributes = new Map();
    this.listeners = {};
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    this._value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.readOnly = false;
    this.files = null;
    this.scrollTop = 0;
    this.onclick = null;
    this.onchange = null;
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'value') this._value = String(v); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() { return { contains: (c) => this.className.split(/\s+/).includes(c) }; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get type() { return this.getAttribute('type') || (this.localName === 'input' ? 'text' : ''); }
  set type(v) { this.setAttribute('type', v); }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  set placeholder(v) { this.setAttribute('placeholder', v); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  set name(v) { this.setAttribute('name', v); }
  set min(v) { this.setAttribute('min', v); }
  set max(v) { this.setAttribute('max', v); }
  set rows(v) { this.setAttribute('rows', v); }
  get value() {
    if (this.localName === 'select') {
      const opts = this.querySelectorAll('option');
      const sel = opts.find((o) => o.selected) || opts[0];
      return sel ? sel.value : '';
    }
    if (this.localName === 'option') return this.attributes.has('value') ? this.getAttribute('value') : this.textContent;
    return this._value;
  }
  set value(v) {
    if (this.localName === 'select') { for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v); return; }
    if (this.localName === 'option') { this.setAttribute('value', v); return; }
    this._value = String(v);
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    const e = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, ev);
    for (const fn of (this.listeners[e.type] || []).slice()) fn.call(this, e);
    if (e.type === 'click' && typeof this.onclick === 'function') this.onclick(e);
    if (e.type === 'change' && typeof this.onchange === 'function') this.onchange(e);
    this.ownerDocument._bubble(e);
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  setSelectionRange() {}
  /** Every element below, depth first. */
  all() {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c instanceof Element) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  matches(sel) {
    return sel.split(',').map((s) => s.trim()).some((s) => {
      let m;
      if ((m = /^\[([\w-]+)\]$/.exec(s))) return this.hasAttribute(m[1]);
      if ((m = /^\.([\w-]+)$/.exec(s))) return this.className.split(/\s+/).includes(m[1]);
      if ((m = /^#([\w-]+)$/.exec(s))) return this.id === m[1];
      return this.localName === s.toLowerCase();
    });
  }
  querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class Document extends Element {
  constructor() {
    super(null, '#document');
    this.ownerDocument = this;
    this.docListeners = {};
    this.copied = [];
    this.hidden = false;
    this.documentElement = this.createElement('html');
    this.body = this.createElement('body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = null;
  }
  get hidden() { return false; }
  set hidden(v) { /* the document is always visible here */ }
  createElement(tag) { return new Element(this, tag); }
  createElementNS(ns, tag) { return new Element(this, tag, ns); }
  createTextNode(t) { return new Text(this, t); }
  getElementById(id) { return this.all().find((e) => e.id === id) || null; }
  addEventListener(t, fn) { (this.docListeners[t] = this.docListeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.docListeners[t] = (this.docListeners[t] || []).filter((f) => f !== fn); }
  _bubble(e) { for (const fn of (this.docListeners[e.type] || []).slice()) fn(e); }
  /** document.execCommand('copy'): what the selected text area held. */
  execCommand(cmd) {
    if (cmd !== 'copy') return false;
    const ta = this.activeTextArea || this.body.all().filter((x) => x.localName === 'textarea').pop();
    if (!ta) return false;
    this.copied.push(ta.value);
    return true;
  }
}

/** The fragment server/ui.js renders → elements under `parent`; returns the script bodies in order. */
function parseInto(doc, parent, html) {
  const scripts = [];
  const stack = [parent];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  let i = 0;
  while (i < html.length) {
    re.lastIndex = i;
    m = re.exec(html);
    if (!m || m.index !== i) throw new Error('cannot parse at ' + html.slice(i, i + 40));
    i = re.lastIndex;
    if (m[5] !== undefined) { stack[stack.length - 1].appendChild(doc.createTextNode(decode(m[5]))); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) { stack.pop(); continue; }
    if (tag === 'script' || tag === 'style') {
      const end = html.indexOf('</' + tag + '>', i);
      if (tag === 'script') scripts.push(html.slice(i, end));
      i = end + tag.length + 3;
      continue;
    }
    const el = doc.createElement(tag);
    for (const a of m[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], a[2] === undefined ? '' : decode(a[2]));
    stack[stack.length - 1].appendChild(el);
    if (!VOID.has(tag) && !m[4]) stack.push(el);
  }
  return scripts;
}

/**
 * A window with the rendered page: { window, document, run() } — run() executes the page's scripts in order.
 * `gc` becomes window.GC (call, saveFile, …).
 */
function createWindow(html, gc) {
  const document = new Document();
  const scripts = parseInto(document, document.body, html);
  const timers = [];
  const keep = (t) => { if (t && t.unref) t.unref(); timers.push(t); return t; };
  const winListeners = {};
  const win = {
    document,
    GC: gc,
    navigator: { clipboard: null },
    screen: { availHeight: 900 },
    console,
    Blob,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    Date, // this realm's (the mock host's clock)
    setTimeout: (fn, ms) => keep(setTimeout(fn, ms)),
    clearTimeout,
    setInterval: (fn, ms) => keep(setInterval(fn, ms)),
    clearInterval,
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch: (t) => { for (const fn of winListeners[t] || []) fn({ type: t }); },
  };
  win.window = win;
  win.globalThis = win;
  vm.createContext(win);
  return {
    window: win,
    document,
    /** after(index, window) runs after each script (e.g. to swap a slow primitive in tests). */
    run(after) {
      scripts.forEach((s, i) => {
        vm.runInContext(s, win);
        if (after) after(i, win);
      });
    },
    stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } },
  };
}

module.exports = { createWindow, Element, Document };
