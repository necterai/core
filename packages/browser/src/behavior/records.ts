/**
 * Plain records produced by the capture layer and consumed by the pure
 * feature extraction. No DOM references are kept here (only numbers and
 * short strings), so snapshots can be built by hand in tests and replayed
 * from datasets.
 *
 * All times are `Event.timeStamp` values (same origin as `performance.now()`).
 */

export type PointerKind = 'mouse' | 'pen' | 'touch' | '' | 'unknown';

export interface MoveSample {
  t: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  pointerType: PointerKind;
  /** movementX/Y as reported (0 when unsupported). */
  mx: number;
  my: number;
  /** getCoalescedEvents().length, or -1 when the API is unavailable. */
  coalesced: number;
  buttons: number;
  trusted: boolean;
  hidden: boolean;
}

export type SourceCaps = 'present' | 'null' | 'unsupported';

/** What kind of activation produced a click. */
export type ClickKind =
  /** pointerdown/mousedown + up + click from a pointing device. */
  | 'pointer'
  /** Keyboard activation (Enter/Space on a control): no down/up, keydown just before. */
  | 'keyboard'
  /** Trusted click with no down/up and no key: screen-reader activation (Firefox/VoiceOver). */
  | 'sr'
  /** isTrusted === false. */
  | 'untrusted'
  /** Trusted click derived from another one (label activation forwarding the click to its control). */
  | 'derived';

export interface TargetGeometry {
  /** Width/height of the candidate element (CSS px). */
  w: number;
  h: number;
  /** Offset of the press point from the candidate's centre (CSS px). */
  dx: number;
  dy: number;
}

export interface ClickRecord {
  /** Time of the click event. */
  t: number;
  kind: ClickKind;
  trusted: boolean;
  pointerType: PointerKind;
  /** Press point (pointerdown coordinates when available, else click). */
  x: number;
  y: number;
  sx: number;
  sy: number;
  downT: number | null;
  upT: number | null;
  /** Latest pointerover before the press. */
  overT: number | null;
  pressure: number | null;
  buttons: number | null;
  /** click.detail */
  detail: number;
  /** mousedown.detail (null when no mousedown was seen). */
  mdDetail: number | null;
  sourceCaps: SourceCaps;
  /** A trusted focusin landed on the target 0-50 ms before the press (UIA Invoke shape). */
  focusBeforeDown: boolean;
  /** Enter/Space keydown within 100 ms before the click. */
  keyBefore: boolean;
  /** The click target is an editable field. */
  onField: boolean;
  hidden: boolean;
  /** Best-matching centre geometry (target or its interactive ancestor); null when unknown. */
  geometry: TargetGeometry | null;
  /** For untrusted clicks: where the dispatching code came from. */
  origin?: DispatchOrigin;
}

export type DispatchOrigin = 'site' | 'foreign' | 'unknown';

export type KeyClass =
  | 'char'
  | 'space'
  | 'punct'
  | 'enter'
  | 'tab'
  | 'nav'
  | 'backspace'
  | 'modifier'
  | 'other'
  /** keydown that is not a KeyboardEvent or carries no `key` (Chrome autofill, Bitwarden). */
  | 'generic';

export interface KeyRecord {
  t: number;
  /** keyup time once matched, else null. */
  up: number | null;
  code: string;
  cls: KeyClass;
  trusted: boolean;
  repeat: boolean;
  /** Field id (0 = not an editable field). */
  field: number;
  hidden: boolean;
  origin?: DispatchOrigin;
}

export interface InputRecord {
  t: number;
  kind: 'beforeinput' | 'input' | 'change';
  trusted: boolean;
  isInputEvent: boolean;
  inputType: string;
  /** Value length after the event minus before (input/change only). */
  delta: number;
  field: number;
  fieldType: string;
  autocomplete: string;
  /** Field matches :autofill / :-webkit-autofill. */
  autofill: boolean;
  /** Password-manager marker on the field or its form. */
  pmMarker: boolean;
}

export interface WheelRecord {
  t: number;
  dx: number;
  dy: number;
  mode: number;
  /** Legacy wheelDeltaY (null when unavailable). */
  wdy: number | null;
  trusted: boolean;
}

export interface ScrollRecord {
  t: number;
  /** Document or element scroll offset after the event (0 when unknown). */
  pos: number;
}

/** Input that can legitimately cause a scroll (provenance is decided lazily from these). */
export type ScrollCauseKind = 'wheel' | 'key' | 'touch' | 'pointer' | 'focus' | 'nav' | 'resize';

export interface CauseRecord {
  t: number;
  kind: ScrollCauseKind;
}

export interface FocusRecord {
  t: number;
  /** A trusted Tab keydown preceded this focusin within 150 ms. */
  viaTab: boolean;
  field: number;
  trusted: boolean;
}

export interface EnvInfo {
  /** Chromium-only APIs available (pointerrawupdate). */
  chromium: boolean;
  dpr: number;
  /** matchMedia('(pointer: fine)') */
  finePointer: boolean;
  /** UIEvent.sourceCapabilities is implemented. */
  sourceCapsSupported: boolean;
  /** Windowed desktop browser with non-zero window offset or toolbar height. */
  windowed: boolean;
}

export interface Snapshot {
  now: number;
  moves: MoveSample[];
  clicks: ClickRecord[];
  keys: KeyRecord[];
  inputs: InputRecord[];
  wheels: WheelRecord[];
  scrolls: ScrollRecord[];
  causes: CauseRecord[];
  focuses: FocusRecord[];
  /** Times of trusted Ctrl/Cmd+V or paste events. */
  pastes: number[];
  /** Times of compositionstart/compositionend. */
  compositions: number[];
  /** Times of `select` events on fields, with field id. */
  selects: { t: number; field: number }[];
  /** Closed hidden/prerender spans [start, end). */
  hiddenSpans: [number, number][];
  /** Start of the currently open hidden span, if hidden now. */
  hiddenSince: number | null;
  /** Behaviour clocks restart here (start, bfcache restore). */
  segmentStart: number;
  /** Load time (scroll provenance ignores the first second after it). */
  loadT: number;
  /** Trusted pointer/keyboard events observed while the document was hidden. */
  hiddenTrustedInputs: number;
  /** Password-manager markers anywhere in the document. */
  pmMarkersPresent: boolean;
  env: EnvInfo;
}

export const BUFFER_SIZE = 2000;
