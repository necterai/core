import { afterEach, describe, expect, it } from 'vitest';
import {
  WRAPPED_MARKER,
  getOriginalToString,
  hasWrappedMarker,
  installInstrumentation,
  instrumentedSlots,
  isInstrumented,
  isSdkWrapper,
  onRead,
  onStack,
  quiet,
  registerSensitiveNode,
  setStackSource,
  type ReadEvent,
} from '../src/harvest/instrument.js';

const nativeToString = Function.prototype.toString;
const desc = (o: object, k: string) => Object.getOwnPropertyDescriptor(o, k)!;

const ORIGINALS = {
  rect: desc(Element.prototype, 'getBoundingClientRect').value as Function,
  qsa: desc(Document.prototype, 'querySelectorAll').value as Function,
  elQsa: desc(Element.prototype, 'querySelectorAll').value as Function,
  textContent: desc(Node.prototype, 'textContent').get as Function,
  treeWalker: desc(Document.prototype, 'createTreeWalker').value as Function,
  toString: Function.prototype.toString,
};

let releases: (() => void)[] = [];
function install(): () => void {
  const r = installInstrumentation({ trustedScriptOrigins: [] });
  releases.push(r);
  return r;
}

afterEach(() => {
  for (const r of releases.splice(0)) r();
  setStackSource(undefined);
  document.body.innerHTML = '';
});

describe('harvest instrumentation: transparency', () => {
  it('wraps the spec slots and marks them', () => {
    install();
    expect(isInstrumented()).toBe(true);
    const slots = instrumentedSlots();
    expect(slots).toEqual(expect.arrayContaining(['Element.getBoundingClientRect', 'Node.textContent', 'Document.querySelectorAll', 'Document.createTreeWalker']));
    const wrapped = desc(Element.prototype, 'getBoundingClientRect').value;
    expect(wrapped).not.toBe(ORIGINALS.rect);
    expect(isSdkWrapper(wrapped)).toBe(true);
    expect(hasWrappedMarker(wrapped)).toBe(true);
    expect(hasWrappedMarker(ORIGINALS.rect)).toBe(false);
  });

  it('preserves name, length, toString and the native own-key shape', () => {
    install();
    const m = desc(Element.prototype, 'getBoundingClientRect').value as Function;
    expect(m.name).toBe(ORIGINALS.rect.name);
    expect(m.length).toBe(ORIGINALS.rect.length);
    expect(Function.prototype.toString.call(m)).toBe(nativeToString.call(ORIGINALS.rect));
    expect(m.toString()).toBe(nativeToString.call(ORIGINALS.rect));
    expect('prototype' in m).toBe(false);
    // No visible marker property: own keys stay exactly length/name.
    expect(Reflect.ownKeys(m).map(String).sort()).toEqual(['length', 'name']);
    expect((m as unknown as Record<string, unknown>)[WRAPPED_MARKER]).toBeUndefined();

    const g = desc(Node.prototype, 'textContent').get as Function;
    expect(g.name).toBe(ORIGINALS.textContent.name);
    expect(g.length).toBe(ORIGINALS.textContent.length);
    expect(Function.prototype.toString.call(g)).toBe(nativeToString.call(ORIGINALS.textContent));
    expect('prototype' in g).toBe(false);

    const q = desc(Document.prototype, 'querySelectorAll').value as Function;
    expect(q.length).toBe(ORIGINALS.qsa.length);

    // The toString patch answers natively for itself.
    expect(Function.prototype.toString.call(Function.prototype.toString)).toBe(nativeToString.call(ORIGINALS.toString));
    expect(getOriginalToString()).toBe(ORIGINALS.toString);
  });

  it('preserves return values and this', () => {
    document.body.innerHTML = '<p id="a">hello</p><p>world</p>';
    const before = { text: document.body.textContent, count: document.querySelectorAll('p').length };
    install();
    const p = document.getElementById('a')!;
    expect(p.textContent).toBe('hello');
    expect(document.body.textContent).toBe(before.text);
    const list = document.querySelectorAll('p');
    expect(list.length).toBe(before.count);
    expect(list[0]).toBe(p);
    expect(p.querySelectorAll('*').length).toBe(0);
    const r = p.getBoundingClientRect();
    expect(typeof r.width).toBe('number');
    // Setter side of the accessor is untouched.
    p.textContent = 'changed';
    expect(p.textContent).toBe('changed');
  });

  it('preserves exceptions (type and message)', () => {
    const capture = (fn: () => unknown): { name: string; message: string } => {
      try {
        fn();
      } catch (e) {
        return { name: (e as Error).name, message: (e as Error).message };
      }
      return { name: 'none', message: '' };
    };
    const badSelector = capture(() => document.querySelectorAll('!!!'));
    const badThis = capture(() => (ORIGINALS.textContent as () => unknown).call({}));
    install();
    expect(capture(() => document.querySelectorAll('!!!'))).toEqual(badSelector);
    expect(capture(() => (desc(Node.prototype, 'textContent').get as () => unknown).call({}))).toEqual(badThis);
    expect(badSelector.name).not.toBe('none');
  });

  it('notifies read listeners, honours quiet(), and delivers stack verdicts on request', () => {
    install();
    setStackSource(() => 'Error\n    at <anonymous>:1:10', 0);
    const kinds: string[] = [];
    const stacks: string[] = [];
    releases.push(onRead((ev: ReadEvent) => {
      kinds.push(ev.kind);
      return ev.kind === 'rect';
    }));
    releases.push(onStack((_ev, verdict, reason) => stacks.push(`${reason}:${verdict.cls}`)));
    const el = document.createElement('div');
    el.getBoundingClientRect();
    void el.textContent;
    quiet(() => el.getBoundingClientRect());
    expect(kinds).toEqual(['rect', 'textContent']);
    expect(stacks).toEqual(['sample:anonymous']);
  });

  it('reports reads covering a sensitive node with the caller classification', () => {
    install();
    setStackSource(() => 'Error\n    at pptr:evaluate;Page.evaluate:1:10', 0);
    const secret = document.createElement('span');
    secret.textContent = 'canary';
    document.body.appendChild(secret);
    const seen: string[] = [];
    releases.push(registerSensitiveNode(secret, (info) => seen.push(`${info.api}:${info.direct}:${info.stack.cls}`)));
    void document.body.textContent;
    void secret.textContent;
    expect(seen).toEqual(['textContent:false:automation', 'textContent:true:automation']);
  });

  it('is reference counted and stop restores the original prototypes', () => {
    const a = install();
    const b = install();
    expect(desc(Element.prototype, 'getBoundingClientRect').value).not.toBe(ORIGINALS.rect);
    a();
    expect(isInstrumented()).toBe(true);
    b();
    expect(isInstrumented()).toBe(false);
    expect(desc(Element.prototype, 'getBoundingClientRect').value).toBe(ORIGINALS.rect);
    expect(desc(Document.prototype, 'querySelectorAll').value).toBe(ORIGINALS.qsa);
    expect(desc(Element.prototype, 'querySelectorAll').value).toBe(ORIGINALS.elQsa);
    expect(desc(Node.prototype, 'textContent').get).toBe(ORIGINALS.textContent);
    expect(desc(Document.prototype, 'createTreeWalker').value).toBe(ORIGINALS.treeWalker);
    expect(Function.prototype.toString).toBe(ORIGINALS.toString);
  });

  it('does not stack a second wrapper over a slot another SDK copy already wrapped', () => {
    const foreign = function getBoundingClientRect(this: Element) {
      return ORIGINALS.rect.call(this);
    };
    Object.defineProperty(foreign, WRAPPED_MARKER, { value: true });
    const original = desc(Element.prototype, 'getBoundingClientRect');
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', { ...original, value: foreign });
    try {
      install();
      expect(desc(Element.prototype, 'getBoundingClientRect').value).toBe(foreign);
      expect(instrumentedSlots()).not.toContain('Element.getBoundingClientRect');
    } finally {
      for (const r of releases.splice(0)) r();
      Object.defineProperty(Element.prototype, 'getBoundingClientRect', original);
    }
  });

  it('does not restore a slot somebody re-wrapped after us', () => {
    const r = install();
    const ours = desc(Element.prototype, 'getBoundingClientRect');
    const theirs = function getBoundingClientRect(this: Element) {
      return (ours.value as Function).call(this);
    };
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', { ...ours, value: theirs });
    r();
    releases = [];
    expect(desc(Element.prototype, 'getBoundingClientRect').value).toBe(theirs);
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', { ...ours, value: ORIGINALS.rect });
  });
});
