// Miro fill engine (runs inside the page).
async function fillPage({ people, contact = {}, previous = null, focusCaptcha = true, contactFirst = false, groupCard = false, lockPool = [], budgetMs = 15000 }) {
  const t0 = performance.now();
  // The whole fill gets a time budget (shared.js FILL_BUDGET_MS; the default here matches it). A page that takes nothing
  // would otherwise be tried box by box for half a minute, with the on-page button and the popup saying "Filling…" all
  // along. Once the budget is spent no box is started, no wait runs past it, and the report says it stopped early.
  const deadline = t0 + Math.max(1000, +budgetMs || 15000);
  const left = () => Math.max(0, deadline - performance.now());
  const overdue = () => performance.now() >= deadline;
  let timedOut = false;
  // One fill at a time on a page. Two fills running together (Alt+A pressed twice, the popup's Fill and then the
  // on-page button, two installed copies of the extension each answering their own button) write through the one
  // focused box and leave a row holding two people's details, each fill counting its own writes as complete. So a
  // fill leaves a marker in the page's main world, refreshed on every wait (tick), and a fill that finds a live
  // marker stands down with busy:true. A marker a crashed fill left behind stops being refreshed and goes stale.
  const LOCK = '__miroFill';
  const STALE_MS = 5000;
  const other = window[LOCK];
  if (other && typeof other.at === 'number' && Date.now() - other.at < STALE_MS) return { busy: true, ms: 0 };
  const lock = { at: Date.now() };
  window[LOCK] = lock;
  // Waiting in a hidden tab. Desktop browsers throttle a hidden page's timers to once a second, so a tiny worker keeps
  // the time (its timers aren't throttled), raced with a plain timeout so the wait can never hang. Firefox for
  // Android freezes both timers and workers of a hidden page (the page behind its popup overlay), and only task
  // messages still run: there a MessageChannel task loop waits (it keeps the CPU busy, but only for these short waits).
  let sleeper = null;
  let sleepId = 0;
  try {
  const frozenWhenHidden = /Android/i.test(navigator.userAgent);
  const yieldTask = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  // Raced with a plain timer: a MessageChannel whose ports never deliver (a polyfill from the page or another extension)
  // would hold the task loop forever. On a hidden Android page that timer is frozen, so the loop still does the waiting
  // there; anywhere else the timer ends the wait by itself.
  const spin = (ms) => {
    const end = performance.now() + ms;
    const loop = (async () => { do await yieldTask(); while (performance.now() < end); })();
    return Promise.race([loop, new Promise((r) => setTimeout(r, ms))]);
  };
  const tick = (ms = 0) => {
    lock.at = Date.now(); // still alive: a fill started meanwhile checks this before standing down
    ms = Math.min(ms, left()); // no wait runs past the fill's time budget
    if (!document.hidden) return new Promise((r) => setTimeout(r, ms));
    if (frozenWhenHidden) return spin(ms);
    try {
      if (!sleeper) sleeper = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' })));
      const viaWorker = new Promise((r) => {
        const id = ++sleepId;
        const on = (e) => { if (e.data === id) { sleeper.removeEventListener('message', on); r(); } };
        sleeper.addEventListener('message', on);
        sleeper.postMessage({ id, ms });
      });
      return Promise.race([viaWorker, new Promise((r) => setTimeout(r, ms))]);
    } catch {
      return spin(ms);
    }
  };
  const done = (report) => {
    try { sleeper?.terminate(); } catch { /* already gone */ }
    if (window[LOCK] === lock) window[LOCK] = null; // the page is free for the next fill
    return report;
  };
  const waitFor = async (fn, ms) => {
    await null; // React 18 renders in a microtask queued by the triggering event
    const end = Math.min(performance.now() + ms, deadline);
    let r = fn();
    while (!r && performance.now() < end) {
      await tick(16);
      r = fn();
    }
    return r;
  };

  // "memberAge" / "id_proof-no" / "ref1Name" / "Visa/OCS" -> "member age" / "id proof no" / "ref 1 name" / "visa ocs"
  const norm = (s) =>
    (s || '')
      .toString()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-zA-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[_\-.:*/|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const canon = (s) => norm(s).replace(/\ba{1,2}dh?a{1,2}r/g, 'aadhaar').replace(/licen[cs]e/g, 'licence');
  // Option text only: "O+ve" / "O Positive" -> "o positive"
  const canonOpt = (s) =>
    canon(
      (s || '').toString()
        .replace(/\b(ab|a|b|o)\s*(\+\s*ve|\+|positive|pos)(?![a-z])/gi, '$1 positive')
        .replace(/\b(ab|a|b|o)\s*(-\s*ve|-|negative|neg)(?![a-z])/gi, '$1 negative'),
    );
  const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  const squash = (s) => String(s ?? '').replace(/\s/g, '').toUpperCase();

  const CONTROLS = 'input, select, textarea, mat-select, [role="combobox"]';
  const TEXT_TYPES = ['', 'text', 'number', 'tel', 'search', 'email'];
  const OPTION_SEL = '[role="option"], mat-option, .ng-option, .select2-results__option';
  const DIALOG_SEL = '[role="dialog"], dialog, [aria-modal="true"]';

  const isVisible = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  // Whether a member can see a box: the test the browser's own autofill applies before it writes one. isVisible is
  // the cheap display/visibility test (enough for options and error text); a control must also pass this one, so a
  // box the page keeps for itself (a screen-reader-only duplicate, a transparent, zero-sized, clipped or off-page box,
  // one inside an aria-hidden or inert wrapper) is never written and never anchors a member row. A box merely below
  // the fold, or scrolled out of a scrolling panel, still counts: the member can scroll to it.
  //   opacity: false  keeps a transparent box (a native date box drawn under a styled one)
  //   aria: false     ignores aria-hidden wrappers (while a popup is open the page marks everything behind it so)
  const len = (v, ref) => (/%$/.test(v) ? (parseFloat(v) / 100) * ref : parseFloat(v)) || 0;
  const clipsAll = (cs, r) => {
    // clip: rect(top, right, bottom, left) on a positioned element: the screen-reader-only recipe is rect(0,0,0,0)
    const m = /^rect\(([^)]*)\)/.exec(cs.clip || '');
    if (m && /^(absolute|fixed)$/.test(cs.position)) {
      const [t, ri, b, l] = m[1].split(/[\s,]+/).map(parseFloat);
      if (ri - l <= 0 || b - t <= 0) return true;
    }
    const cp = cs.clipPath || '';
    if (/^(circle|ellipse)\(0(px|%)?(?![\d.])/.test(cp)) return true;
    const ins = /^inset\(([^)]*)\)/.exec(cp); // inset(50%) / inset(100%) hide the whole box
    if (ins) {
      const v = ins[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      const [t, ri, b, l] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
      if (len(t, r.height) + len(b, r.height) >= r.height - 0.5 || len(l, r.width) + len(ri, r.width) >= r.width - 0.5) return true;
    }
    return false;
  };
  const clipped = (o) => o === 'hidden' || o === 'clip';
  const scrolls = (o) => o === 'auto' || o === 'scroll';
  const isShown = (el, { opacity = true, aria = true } = {}) => {
    if (!isVisible(el)) return false;
    if (opacity) {
      try { // both spellings of the option names: Chrome before 121 and Firefox before 122 know only the old ones
        if (typeof el.checkVisibility === 'function'
          && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch { /* the walk below reads opacity itself */ }
    }
    let cur = el.getBoundingClientRect();
    if (cur.width < 2 || cur.height < 2) return false;
    // Up through the wrappers (and out of a shadow root): a hiding one hides the box. An ancestor that clips its
    // overflow (hidden / clip) must still show at least 2px of the box; one that scrolls (auto / scroll) can bring it
    // into view unless the box sits before the start of its content (left:-9999px inside a panel), and from there on
    // it is the panel that has to be on the page.
    const reach = (ov, a0, a1, b0, b1, scrolled) => {
      if (clipped(ov)) return Math.min(a1, b1) - Math.max(a0, b0) >= 2;
      if (scrolls(ov)) return a1 - b0 + scrolled > 0;
      return true;
    };
    for (let p = el; p && p !== document.documentElement; p = p.parentElement || (p.parentNode && p.parentNode.host) || null) {
      if (p.hasAttribute('inert') || (aria && p !== el && p.getAttribute('aria-hidden') === 'true')) return false;
      const cs = getComputedStyle(p);
      if (opacity && cs.opacity === '0') return false;
      const pr = p === el ? cur : p.getBoundingClientRect();
      if (clipsAll(cs, pr)) return false;
      if (p === el) continue;
      if (!reach(cs.overflowX, cur.left, cur.right, pr.left, pr.right, p.scrollLeft)
        || !reach(cs.overflowY, cur.top, cur.bottom, pr.top, pr.bottom, p.scrollTop)) return false;
      if (scrolls(cs.overflowX) || scrolls(cs.overflowY)) cur = pr;
    }
    // Before the document's own start (left:-9999px / top:-9999px): no scrolling reaches it.
    return cur.right + window.scrollX > 0 && cur.bottom + window.scrollY > 0;
  };
  // Helper boxes a widget keeps beside its visible control, never fields of their own: a hidden input mirroring the
  // chosen id (react-hook-form, Headless UI), MUI Select's invisible aria-hidden native input, a search box inside
  // an open list. The scan skips them and they don't count where a wrapper is checked for holding one control, so
  // the dropdown trigger beside them keeps its label, its options and its "dropdown" kind.
  // A checkbox beside a dropdown box is an open multi-select list's item, never a field the scan fills either.
  const isHelper = (el) => el.type === 'hidden' || el.type === 'checkbox' || el.getAttribute('aria-hidden') === 'true'
    || !!(el.parentElement && el.parentElement.closest('[role="listbox"], [role="menu"]'));
  const fieldControls = (root) => [...root.querySelectorAll(CONTROLS)].filter((c) => !isHelper(c));
  // The element that really holds the focus, followed down through open shadow roots (document.activeElement
  // stops at the shadow host). The browser's editing command types into this element, whichever box was asked for.
  const focusedEl = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };

  // The React component that owns a box: its props are what the page's own code passed down (the box's name, its
  // value, the handler that writes the page's state, a dropdown's options), found by walking the fiber tree up from
  // the DOM node. Both fibers of a pair are checked, since the node may point at the one that is not current. Null
  // off React. This needs the page's main world (runFill injects there); in the isolated world no fiber is visible.
  // React keeps two fibers per node and swaps them on every render, while the node keeps pointing at the one it was
  // created with, so that one is current only every other render. The current one is the one whose props React last
  // committed to the node (its __reactProps$), and the walk starts there: the stale one leads to the owner's previous
  // render, whose handlers work from a copy of the page's state as it was then (the portal's do), so calling one of them now
  // would put that old state back and wipe a value set since (the gender picked a moment ago). Both fibers of each
  // ancestor pair are still checked, current first, since a node rendered once has no alternate.
  const liveFiber = (el) => {
    const keys = Object.keys(el);
    const f = el[keys.find((k) => k.startsWith('__reactFiber$'))] || null;
    const committed = el[keys.find((k) => k.startsWith('__reactProps$'))];
    return f && f.alternate && committed && f.memoizedProps !== committed && f.alternate.memoizedProps === committed ? f.alternate : f;
  };
  const reactOwner = (el, pred, depth = 8) => {
    const start = liveFiber(el);
    if (!start) return null;
    for (let f = start.return, i = 0; f && i < depth; f = f.return, i++) {
      for (const p of [f.memoizedProps, f.alternate && f.alternate.memoizedProps]) {
        if (p && typeof p === 'object' && pred(p)) return p;
      }
    }
    return null;
  };
  // The props of every React component between a box and its row, nearest first. The walk up the fiber tree (from
  // the current fiber, see liveFiber) stops at the first host element that holds another control (the row, the
  // form), so however many wrapper components a page puts around a box, only that box's own components are read and
  // a row's or form's handler is never called. Both fibers of a pair are read, current first.
  const ownProps = (el) => {
    const out = [];
    const start = liveFiber(el);
    if (!start) return out;
    for (let f = start.return, i = 0; f && i < 40; f = f.return, i++) {
      const n = f.stateNode;
      if (n && n.nodeType === 1 && fieldControls(n).some((c) => c !== el)) break;
      for (const p of [f.memoizedProps, f.alternate && f.alternate.memoizedProps]) {
        if (p && typeof p === 'object' && !out.includes(p)) out.push(p);
      }
    }
    return out;
  };
  // An options list under any prop name: an array of strings/numbers, or of objects carrying a title/label/name/
  // text/value/id (the portal today: { id, title } under "list"). React elements (a children array) are never options.
  const OPTION_KEYS = ['title', 'label', 'name', 'text', 'value', 'id'];
  const scalar = (x) => typeof x === 'string' || typeof x === 'number';
  const isOption = (o) => scalar(o) || (!!o && typeof o === 'object' && !Array.isArray(o) && !o.$$typeof && OPTION_KEYS.some((k) => scalar(o[k])));
  const isOptionList = (a) => Array.isArray(a) && a.length > 0 && a.slice(0, 50).every(isOption);
  // [holder, key] of every prop, and of every entry one level down inside a plain-object prop ({ config: { list } }).
  const plainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !v.$$typeof && !v.nodeType
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const entriesOf = (p) => {
    const out = [];
    for (const k of Object.keys(p)) {
      out.push([p, k]);
      if (plainObj(p[k])) for (const j of Object.keys(p[k])) out.push([p[k], j]);
    }
    return out;
  };
  const optionLists = (el) => ownProps(el).flatMap((p) => entriesOf(p).filter(([h, k]) => isOptionList(h[k])).map(([h, k]) => h[k]));
  const holdsList = (el) => optionLists(el).length > 0;

  // the portal's dropdown (webpack module 20238): wrapper > readOnly input + <div><label/><img alt="dropdown icon"></div> + list card.
  // A read-only box whose component holds an options list is a dropdown too, whatever icon sits beside it.
  const ddBox = (el) => {
    const p = el.parentElement;
    if (!p || fieldControls(p).length !== 1) return null;
    if (p.querySelector('img[alt*="dropdown" i], img[src*="dropdown" i]')) return p;
    return holdsList(el) ? p : null;
  };

  // Every control on the page, including those inside open shadow roots (a page may wrap its form in a web
  // component). Document order is kept, which the row builder relies on.
  const allControls = () => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.matches(CONTROLS)) out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  };

  const kindOf = (el) => {
    const tag = el.tagName;
    if (tag === 'SELECT') return el.multiple ? 'multi' : 'select';
    if (tag === 'MAT-SELECT') return 'custom';
    if (tag === 'TEXTAREA') return el.readOnly ? null : 'text';
    if (tag === 'INPUT') {
      const type = el.type; // as the browser resolved it: the portal's made-up types (e.g. "textWithSpace") are plain text
      if (type === 'radio') return 'radio';
      if (type === 'date') return 'date';
      if (type === 'file') return 'file';
      if (!TEXT_TYPES.includes(type)) return null;
      if (el.readOnly) {
        const pop = el.getAttribute('role') === 'combobox' || /listbox|menu|true/.test(el.getAttribute('aria-haspopup') || '');
        return pop || ddBox(el) ? 'custom' : 'locked'; // locked: a plain box the site made read-only
      }
      return 'text';
    }
    return el.getAttribute('role') === 'combobox' ? 'custom' : null;
  };

  const shortText = (node) => {
    const t = ((node && node.textContent) || '').trim();
    return t.length > 0 && t.length <= 60 ? t : '';
  };

  // Visible text of a container, ignoring text inside dropdown options / other widgets.
  const ownText = (node) => {
    if (!node) return '';
    let out = '';
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.parentElement.closest('select, option, mat-select, [role="listbox"], ul, button, script, style')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    while (walker.nextNode()) out += ' ' + walker.currentNode.textContent;
    out = out.trim();
    return out.length <= 60 ? out : '';
  };

  // Returns [attribute text, label text]; attributes are the more reliable signal.
  const describe = (el) => {
    const attrs = [
      el.name, el.id, el.placeholder,
      el.getAttribute('aria-label'), el.getAttribute('formcontrolname'),
      el.getAttribute('ng-model'), el.getAttribute('data-placeholder'),
      el.getAttribute('label'), // the portal puts the field's label text in a non-standard attribute
    ];
    const labels = [];
    if (el.id && !/^\d+$/.test(el.id)) labels.push(shortText(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)));
    labels.push(ownText(el.closest('label')));
    (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .forEach((id) => labels.push(shortText(document.getElementById(id))));
    // Walk up while the ancestor still wraps only this one control, looking for its label.
    for (let i = 0, p = el.parentElement; i < 4 && p; i++, p = p.parentElement) {
      if (fieldControls(p).length > 1) break;
      const t = ownText(p);
      if (t) { labels.push(t); break; }
      const prev = p.previousElementSibling;
      if (prev && !fieldControls(prev).length && shortText(prev)) { labels.push(shortText(prev)); break; }
    }
    return [norm(attrs.filter(Boolean).join(' | ')), norm(labels.filter(Boolean).join(' | '))];
  };

  const radioGroup = (el) =>
    [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];

  const describeRadio = (el) => {
    const group = radioGroup(el);
    const labels = [];
    let p = el.parentElement;
    while (p && !group.every((r) => p.contains(r))) p = p.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const lbl = p.querySelector('legend, mat-label, :scope > label');
      if (lbl) { labels.push(shortText(lbl)); break; }
      const prev = shortText(p.previousElementSibling);
      if (prev) { labels.push(prev); break; }
    }
    return [norm(el.name), norm(labels.join(' | '))];
  };

  // ---------- classification ----------
  const CHOICE = ['select', 'custom', 'radio', 'multi'];
  const ALLOWED = {
    text: (k) => k === 'text',
    choice: (k) => CHOICE.includes(k),
    any: (k) => k !== 'file' && k !== 'date',
    dateish: (k) => k === 'text' || k === 'date',
  };
  const RULES = [
    ['email', /e ?mail/, 'text'],
    ['visaNumber', /visa (no|num)|oc[is] (no|num|card)|\boc[is]\b/, 'text'],
    ['visaType', /visa (type|category)|type of visa/, 'any'],
    ['visaValidity', /visa.*(valid|expir)|(valid|expir).*visa|validity|date of expiry|expiry date/, 'dateish'],
    ['idNumber', /aadhaar|passport (no|num)|id proof (no|num)|proof (no|num)|\bid (no|num)|photo id (no|num)|\bidno\b|id card (no|num)|document (no|num)|card (no|num)/, 'text'],
    ['idType', /proof type|\bid type\b|id proof|photo id|document type|\bproof\b|aadhaar/, 'choice'],
    ['dob', /date of birth|\bdob\b|birth ?date|\bd o b\b|\bborn\b/, 'dateish'],
    // "Age Group" / "Age Category": a list of bands of years, chosen from the age; an "Age Proof" / "Age Limit" box
    // is neither that nor the age.
    ['ageGroup', /(^|[^a-z])age ?(group|category|band|range|slab|bracket)([^a-z]|$)/, 'choice'],
    ['age', /(^|[^a-z])age(?! ?(group|category|band|range|slab|bracket|limit|proof|certificate|criteria))([^a-z]|$)/, 'any'],
    ['gender', /gender|(^|[^a-z])sex([^a-z]|$)/, 'any'],
    ['bloodGroup', /blood/, 'any'],
    ['mobile', /mobile|phone|\bcell\b|whats ?app|contact (no|num)/, 'text'],
    ['pincode', /pin ?code|postal|\bzip\b|\bpin\b/, 'text'],
    ['doorNo', /\bdoor\b|house (no|num)|\bflat\b|\bh no\b|\bplot\b/, 'text'],
    ['gothram', /goth?ra/, 'any'],
    ['district', /district/, 'any'],
    ['city', /\bcity\b|\btown\b/, 'any'], // not "Mandal (Optional)", which Volunteer Service shows right before City
    ['state', /\bstate\b|province/, 'any'],
    ['nationality', /nationality|citizenship/, 'any'],
    ['country', /country/, 'any'],
    ['qualification', /qualification|education/, 'any'],
    ['employment', /employment|occupation|working status/, 'any'], // not "Profession": free text on Volunteer Service
    ['designation', /designation|\bposition\b/, 'any'],
    ['specialization', /speciali[sz]|specialty/, 'any'],
    ['languages', /language/, 'any'],
    ['street', /street|address|\badrs\b|locality|\barea\b(?! of inte?rest)|village|landmark|line ?1/, 'text'],
    ['name', /name/, 'text'],
  ];
  const NOT_MEMBER_NAME = /user ?name|login|father|mother|guardian|spouse|husband|relative|card holder|nominee|file|\buni\b|university|college|school|institut|organi[sz]ation|company|employer/;
  // "ref1Name" / "Reference Person 2" and also "firstRefName" / "secRefMobileNo" / "1. Reference Person Name"
  const REF = /(?:(?<!p)ref(?:erence|eree)?s?(?: person| contact)? ?(1|2|one|two|i{1,2})|\b(1|2|first|sec(?:ond)?|1 st|2 nd) ref(?:erence|eree)?)\b/;

  const classify = (desc, kind) => {
    const d = canon(desc);
    if (!d) return null;
    if (/captcha|security code|verification code|enter (the )?code/.test(d)) return 'captcha';
    if (kind === 'file') {
      if (/photo|image|picture/.test(d)) return 'photo';
      // The saved document is an education certificate: it belongs only in an educational-certificate box,
      // never in "Upload ID Proof", the volunteer card's Employee-ID box (labelled just "Upload Document"), etc.
      if (/certificate|educat|qualification|degree/.test(d)) return 'document';
      return null;
    }
    const ref = d.match(REF);
    if (ref && kind === 'text') {
      const n = /^(1|one|i|first|1 st)$/.test(ref[1] || ref[2]) ? 1 : 2;
      const phone = /mobile|phone|cell|contact (no|num)|number/.test(d) && !/\bname\b/.test(d);
      if (!phone && /detail|address|relation/.test(d)) return null; // "Reference Details": nothing saved for it
      return `ref${n}${phone ? 'Phone' : 'Name'}`;
    }
    for (const [type, re, allowed] of RULES) {
      if (!ALLOWED[allowed](kind) || !re.test(d)) continue;
      if (type === 'idNumber' && /\bname\b/.test(d)) continue; // Volunteer "Full Name (As per Aadhaar)"
      if (type === 'name' && NOT_MEMBER_NAME.test(d)) return null;
      return type;
    }
    return null;
  };

  // Volunteer supervisor/trainer photo: no label of its own (its hint is too long), just the portal's camera icon beside it.
  const cameraPhoto = (el) => !/pdf/i.test(el.accept || '') && !!el.parentElement
    && !!el.parentElement.querySelector('img[src*="camera" i], img[alt*="camera" i]');

  const ANCHOR_TYPES = ['age', 'dob', 'idNumber', 'gender', 'name'];
  const LOCKED_ANCHORS = ['age', 'idNumber', 'gender', 'name']; // not dob: read-only date pickers are normal
  // A date box the site made read-only is a calendar picker (infant DOB, the passport popup's visa validity). It is
  // never written, but it stays in its row as a manual box, so an empty one is reported instead of being dropped
  // and the row counted as complete.
  const DATE_TYPES = ['dob', 'visaValidity'];

  const scan = () => {
    const all = [];
    let captcha = null;
    const seenRadio = new Set();
    // With a popup open, the page marks everything behind it aria-hidden for screen readers: not a hidden box.
    const popup = [...document.querySelectorAll(DIALOG_SEL)].some(isVisible);
    // A native <select> under a styled widget is often hidden by its library and still the thing to set, so it keeps the
    // cheap test; a native date box drawn transparent under a styled one keeps its opacity. Every other box must be one
    // the member can see.
    const shown = (el, kind) => (kind === 'select' || kind === 'multi' ? isVisible(el) : isShown(el, { opacity: kind !== 'date', aria: !popup }));
    for (const el of allControls()) {
      if (el.closest('#member-autofill-toast') || isHelper(el)) continue;
      let kind = kindOf(el);
      if (!kind) continue;
      const locked = kind === 'locked';
      if (locked) kind = 'text';
      if (kind === 'radio') {
        if (!el.name || seenRadio.has(el.name)) continue;
        seenRadio.add(el.name);
      } else if (kind !== 'file' && !shown(el, kind)) continue;
      const [attrs, labels] = kind === 'radio' ? describeRadio(el) : describe(el);
      const type = classify(attrs, kind) || classify(labels, kind) || (kind === 'file' && cameraPhoto(el) ? 'photo' : null);
      // A read-only box is never written. It is kept only when it can anchor a person row (the portal locks a pre-filled
      // age with readOnly in the senior-citizen and infant flows); otherwise the other people would shift a row.
      const manual = locked && DATE_TYPES.includes(type);
      if (locked && !manual && !LOCKED_ANCHORS.includes(type)) continue;
      if (type === 'captcha') { if (!captcha && !el.disabled) captcha = el; continue; }
      if (!type) continue;
      const off = locked || el.disabled || el.getAttribute('aria-disabled') === 'true';
      all.push({ el, kind, type, off, locked, manual, dialog: !!el.closest(DIALOG_SEL) });
    }
    // A Country box right before "Visa/OCS Number" is the passport's country, not the address country.
    for (let i = 0; i + 1 < all.length; i++) {
      if (all[i].type === 'country' && all[i + 1].type === 'visaNumber') all[i].type = 'passportCountry';
    }
    // Pop-up dialogs (the portal's passport popup) are handled separately, unless the whole form lives in one.
    const outside = all.filter((i) => !i.dialog);
    const useDialogSplit = outside.some((i) => ANCHOR_TYPES.includes(i.type) && !i.manual);
    const items = (useDialogSplit ? outside : all).map((it, idx) => ({ ...it, idx }));
    const dialogItems = useDialogSplit ? all.filter((i) => i.dialog && isVisible(i.el)) : [];
    return { items, dialogItems, captcha };
  };

  // One row per person: anchor on the most person-specific field, grow each row as far
  // as it can without swallowing another anchor, then take the nearest field of each type.
  // Disabled or read-only anchors still count, so a locked (pre-filled) row never shifts the others.
  // An anchor type with two boxes in one member's container (the nearest one holding a single name box) would cut
  // that member into one-box rows: a box whose label merely contains the anchor word, like an "Age Type" list beside
  // Age, is such a twin. The next type anchors instead; when no type is free of twins the first still does.
  const buildRows = (items) => {
    const names = items.filter((i) => i.type === 'name').map((i) => i.el);
    const twinned = (anchors) => anchors.some((a) => {
      let c = a.el.parentElement;
      while (c && !names.some((nm) => c.contains(nm))) c = c.parentElement;
      return !!c && names.filter((nm) => c.contains(nm)).length === 1 && anchors.filter((o) => c.contains(o.el)).length > 1;
    });
    // A manual date box (a read-only picker) only joins a row, it never anchors one.
    const present = ANCHOR_TYPES.filter((t) => items.some((i) => i.type === t && !i.manual));
    const anchorType = present.find((t) => !twinned(items.filter((i) => i.type === t && !i.manual))) || present[0];
    if (!anchorType) return [];
    const anchors = items.filter((i) => i.type === anchorType && !i.manual);
    return anchors.map((a) => {
      let row = a.el;
      while (row.parentElement && !anchors.some((o) => o !== a && row.parentElement.contains(o.el))) {
        row = row.parentElement;
      }
      const fields = {};
      for (const it of items) {
        if (!row.contains(it.el)) continue;
        const cur = fields[it.type];
        if (!cur || Math.abs(it.idx - a.idx) < Math.abs(cur.idx - a.idx)) fields[it.type] = it;
      }
      return { el: row, fields };
    });
  };

  // ---------- matching option text ----------
  const ALIASES = {
    transgender: ['third gender', 'other', 'others', 'tg'],
    aadhaar: ['aadhaar card', 'uid'],
    passport: ['passport'],
    india: ['indian', 'bharat'],
  };
  const scoreOne = (t, w) => {
    if (!t || !w || /^(select|choose|--)/.test(t)) return 0;
    if (t === w) return 4;
    if (w === 'male' && t.includes('female')) return 0;
    if (t.length <= 2 && w.startsWith(t)) return 2; // "M" / "F" / "T"
    if (t.startsWith(w)) return 3;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc}\\b`).test(t)) return 2;
    return 0;
  };
  const score = (text, wanted) => {
    const t = canonOpt(text);
    const w = canonOpt(wanted);
    let s = scoreOne(t, w);
    for (const a of ALIASES[w] || []) s = Math.max(s, Math.min(3, scoreOne(t, a)));
    return s;
  };
  // An "Age Group" list names bands of years: "12 - 59", "Below 12", "60 & Above", "60+", "Up to 11 yrs". The band
  // that holds the age counts as an exact match; an option without a number is never chosen.
  const ageBandScore = (text, wanted) => {
    const age = +wanted;
    const t = canon(text);
    const nums = (t.match(/\d+/g) || []).map(Number);
    if (!Number.isInteger(age) || !nums.length) return 0;
    if (nums.length > 1) return age >= Math.min(nums[0], nums[1]) && age <= Math.max(nums[0], nums[1]) ? 4 : 0;
    if (/below|under|less|younger|<\s*\d/.test(t)) return age < nums[0] ? 4 : 0;
    if (/up ?to|till|max|not more|at most/.test(t)) return age <= nums[0] ? 4 : 0;
    return age >= nums[0] ? 4 : 0; // "60 & above", "60+", "above 60", "senior citizen (60)"
  };
  const matcherFor = (type) => (type === 'ageGroup' ? ageBandScore : score);
  const best = (candidates, wanted, textOf, match = score) => {
    let top = null;
    let topScore = 0;
    for (const c of candidates) {
      const s = Math.max(0, ...textOf(c).map((t) => match(t, wanted)));
      if (s > topScore) { top = c; topScore = s; }
    }
    return top;
  };

  // ---------- setting values ----------
  const fire = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // the portal refuses anything outside [A-Za-z ] in these boxes, and React silently restores the old value.
  const LETTERS_ONLY = ['name', 'ref1Name', 'ref2Name', 'city', 'state', 'country', 'passportCountry', 'nationality', 'district'];
  const lettersOnly = (v) => v.replace(/&/g, ' and ').replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // The handler on the owning component that writes a typed value into the page's state, under whatever name the
  // page gives it. It is only tried with the box's own name or value in the same props, so a parent's unrelated
  // handler is never called.
  const HANDLER_PROPS = ['onChange', 'onInput', 'onValueChange', 'onTextChange', 'onChangeText', 'handleChange', 'setValue'];
  const ownsText = (el) => (p) => (p.name === el.name || 'value' in p) && HANDLER_PROPS.some((k) => typeof p[k] === 'function');
  const handlerOf = (p) => p[HANDLER_PROPS.find((k) => typeof p[k] === 'function')];

  // A value longer than a box takes is never typed truncated nor forced in whole: the portal's own box could not hold it, a
  // value pushed past the cap through the setter lands in the page's state as one its checks never saw, and a
  // truncated ID or name is simply the wrong one. The box is left as it was and the card names it with the limit.
  const tooLongBoxes = new Map(); // element -> { why: 'tooLong', len, max }, carried into the result's failed entries

  // Three ways to get text into a box, tried in order until the page keeps the value. Each later one survives a
  // check that defeats the one before it, so a change on the portal's side degrades one layer instead of breaking the fill:
  //  1. The browser's editing command: a trusted input event, which React's onChange sees exactly like typing
  //     (since October 2026 the portal ignores every other kind of input event and clears the box). First the whole
  //     value in one go, then letter by letter for a page that accepts single keystrokes only.
  //  2. The page's own change handler, taken from the owning component's props and called with the box as the
  //     event target (or with the bare value): writes the page's state the way typing would, without any DOM
  //     event for the box to inspect.
  //  3. The value setter plus a synthetic input event: what plain pages and older React forms need.
  // A value the page refuses is reverted by React's controlled-input restore, which the checks after each step see.
  // What each text box was last given (its value right after a write the page kept): a later round and the report
  // tell a box that still holds it from one overwritten since (a focus trap, a page check, another extension).
  const written = new Map();
  let focusPulled = 0; // boxes that lost the focus to another element while being filled (nothing was typed there)
  const setText = async (el, v, type) => {
    if (squash(el.value) === squash(v)) { written.set(el, el.value); return true; } // already right: don't touch it
    if (!el.isConnected) return false; // replaced by a re-render: its focus() is a no-op, so typing would land elsewhere
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    const same = (x) => squash(el.value) === squash(x);
    const before = el.value;
    tooLongBoxes.delete(el);
    // The editing command types into whatever holds the focus, not into el. A popup that traps the focus (the portal's
    // passport popup), a check that moves it to another box, or another extension can take it away between
    // el.focus() and the command, so every command first confirms this box still has it; otherwise nothing is
    // typed anywhere and the value goes in through the page's own handler (layer 2) instead.
    let pulled = false;
    const held = () => {
      const a = focusedEl();
      if (a === el) return true;
      if (a && a !== document.body && a !== document.documentElement) pulled = true; // another element took it
      return false;
    };
    const insert = (x) => {
      if (!held()) return false;
      if (el.value) document.execCommand('selectAll'); // the insert replaces the selection; an empty box has nothing to select
      let ok = document.execCommand('insertText', false, x);
      if (ok && el.value && !same(x) && el.value.length > x.length) { // the old text was not selected (appended): select and try once more
        if (typeof el.select === 'function') el.select();
        ok = held() && document.execCommand('insertText', false, x);
      }
      return ok;
    };
    const insertByChar = (x) => {
      if (!held()) return false;
      if (el.value) { document.execCommand('selectAll'); document.execCommand('delete'); }
      if (el.value) return false;
      for (const ch of x) if (!held() || !document.execCommand('insertText', false, ch)) return false;
      return true;
    };
    const stateHolds = (p, x) => ownsText(el)(p) && 'value' in p && squash(p.value) === squash(x);
    const put = async (x) => {
      // None of the three layers runs for a value longer than the box takes (maxLength, or a cap the page's own
      // handler enforces): layer 1 would type it truncated and layers 2 and 3 would push it past the cap. The browser
      // caps typing at maxLength on text-like boxes only (on number and date boxes it ignores the attribute).
      const cap = el.tagName === 'TEXTAREA' || !/^(number|date)$/.test(el.type) ? el.maxLength : -1;
      if (cap > 0 && x.length > cap) { tooLongBoxes.set(el, { why: 'tooLong', len: x.length, max: cap }); return false; }
      let ok = false;
      try {
        ok = x ? insert(x) : insertByChar(x); // an empty value: select the text and delete it (insertText of "" does nothing)
        if (ok && !same(x)) ok = insertByChar(x);
      } catch { ok = false; }
      if (ok && same(x)) return true;
      // The page kept the start of the value and dropped the rest: a cap its own code enforces (its handler drops a
      // longer value, so React puts the shorter one back). The shortened copy is taken out again, not forced past.
      const kept = el.value;
      const k = squash(kept);
      if (k && kept !== before && k.length < squash(x).length && squash(x).startsWith(k)) {
        try { if (held()) { document.execCommand('selectAll'); document.execCommand(before ? 'insertText' : 'delete', false, before); } } catch { /* left as typed */ }
        tooLongBoxes.set(el, { why: 'tooLong', len: x.length, max: kept.length });
        return false;
      }
      const owner = reactOwner(el, ownsText(el));
      if (owner) {
        const fn = handlerOf(owner);
        for (const arg of [{ target: el, currentTarget: el, type: 'change', preventDefault() {}, stopPropagation() {} }, x]) {
          setter.call(el, x);
          try { fn(arg); } catch { /* not a handler of this shape */ }
          await tick(16); // let React commit the state; a refused value shows up as the old one in the owner's props
          if (same(x) && reactOwner(el, (p) => stateHolds(p, x))) return true;
        }
      }
      setter.call(el, x); // bypasses React's value tracking so the synthetic event reaches onChange
      fire(el);
      return same(x);
    };
    // With the extension popup open the page isn't focused and Chrome skips focus/blur events,
    // so send them ourselves: the portal runs its per-box checks (duplicate ID, age range) on blur.
    const synth = !document.hasFocus();
    el.focus({ preventScroll: true });
    if (synth) {
      el.dispatchEvent(new FocusEvent('focus'));
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    }
    let ok = await put(v);
    if (!ok && LETTERS_ONLY.includes(type)) {
      const alt = lettersOnly(v);
      if (alt && alt !== v) ok = await put(alt);
    }
    // the portal's Gothram box takes one word of letters: "Kashyapa Gotra" -> "Kashyapa", "Sri Vatsa" -> "SriVatsa".
    if (!ok && type === 'gothram') {
      const alt = v.replace(/\s+go(?:th|t)h?ra?m?$/i, '').replace(/[^A-Za-z]/g, '');
      if (alt && alt !== v) ok = await put(alt);
    }
    if (ok) written.set(el, el.value);
    if (pulled) focusPulled++;
    el.blur();
    // A box that lost the focus gets no real blur either, so the page's per-box checks are sent one, as with the popup open.
    if (synth || pulled) {
      el.dispatchEvent(new FocusEvent('blur'));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
    return ok;
  };

  const setSelect = (el, v, type) => {
    const opt = best([...el.options], v, (o) => [o.text, o.value], matcherFor(type));
    if (!opt) return false;
    if (el.value === opt.value) return true;
    el.value = opt.value;
    fire(el);
    return el.value === opt.value;
  };

  const setMulti = (el, list) => {
    let any = false;
    for (const o of el.options) {
      const want = list.some((v) => score(o.text, v) >= 3 || score(o.value, v) >= 3);
      if (want) { o.selected = true; any = true; }
    }
    if (any) fire(el);
    return any;
  };

  const radioLabel = (r) => [
    r.value,
    r.id ? shortText(document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) : '',
    shortText(r.closest('label')),
    shortText(r.nextElementSibling),
  ];
  const setRadio = (el, v, type) => {
    const r = best(radioGroup(el), v, radioLabel, matcherFor(type));
    if (!r || submits(r)) return false;
    if (!r.checked) r.click();
    return r.checked;
  };

  // Never click anything that could submit a form or leave the page (a link, a submit/image/reset input). A click
  // bubbles, so the whole ancestor chain is checked: an option nested in a link or a submit button counts too.
  const submitsOne = (n) => (n.tagName === 'BUTTON' && (n.type === 'submit' || n.type === 'reset'))
    || (n.tagName === 'INPUT' && /^(submit|image|reset)$/i.test(n.type))
    || (n.tagName === 'A' && n.hasAttribute('href') && !/^(#|javascript:)/i.test(n.getAttribute('href').trim()));
  const submits = (n) => {
    for (let x = n; x && x !== document.documentElement; x = x.parentElement) if (submitsOne(x)) return true;
    return false;
  };
  // A click that reaches the page's own handlers (React's onClick) but never the browser's default action: an option
  // sitting in a hash link (Bootstrap-style menus) is chosen without the link changing the page's address.
  const clickOnly = (n) => {
    const stop = (e) => { if (e.target === n || n.contains(e.target)) e.preventDefault(); };
    document.addEventListener('click', stop, true);
    try { n.click(); } finally { document.removeEventListener('click', stop, true); }
  };

  const optionsFor = (el, before = null) => {
    const vis = (root, sel) => [...root.querySelectorAll(sel)].filter(isVisible);
    for (const id of `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean)) {
      const lb = document.getElementById(id);
      const o = lb ? vis(lb, `${OPTION_SEL}, li`) : [];
      if (o.length) return o;
    }
    // List drawn beside the control (the portal: input.parentElement > div > .dropdown_scroll > ul > li).
    for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
      if (fieldControls(p).length > 1) break;
      const o = vis(p, `${OPTION_SEL}, li`);
      if (o.length) return o;
    }
    // Overlay widgets appended to <body>: only options that appeared after this control was opened, so another
    // menu already on the page (a language picker, a list left open) is never clicked instead.
    const o = vis(document, OPTION_SEL).filter((x) => !before || !before.has(x));
    return o.length ? o : null;
  };

  // Close only this list: the portal closes it on a mousedown outside the list, sent here next to the control (so a popup
  // the control sits in stays open); ARIA widgets also get an Escape that doesn't bubble up to the page.
  const closeList = (el) => {
    const near = (el.parentElement && el.parentElement.parentElement) || document.body;
    near.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    if (el.hasAttribute('aria-expanded')) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: false }));
  };

  const currentChoice = (el) => el.value ?? el.textContent ?? '';
  // What a box shows now, as separate choices: a multi-select shows the chosen titles joined ("Telugu,English"). The
  // whole text comes first, for a single choice that itself holds a comma.
  const shownChoices = (el) => {
    const whole = String(currentChoice(el)).trim();
    return whole ? [whole, ...whole.split(/\s*[,;|]\s*/)].filter(Boolean) : [];
  };
  const showsChoice = (texts, v, match = score) => texts.some((t) => match(t, v) >= 3);

  // the portal's dropdown opens only on a trusted click, which no script can send. Its component keeps the options
  // (today { id, title } under "list") and the choice callback (today "selectedItem") in React props on a parent
  // of the box, reachable from the page's main world: choosing through that callback is exactly what a click on
  // the list item does. The prop names are matched loosely so a renamed prop keeps working; where no such
  // component exists (other sites, the practice form) this returns null and the click path runs instead.
  // A multi-select (the portal's Volunteer "Language (Known)": isMultiSelect, a list of checkboxes) takes each choice through
  // its toggle callback (today "onCheckboxChange"), which adds or removes that one title in the comma-joined value;
  // its selectedItem is the single-choice handler, which would replace the whole value with the last language.
  // No prop name is relied on otherwise: the options are whichever array among the box's own components (ownProps)
  // holds the wanted value, at the top level or inside a config object, and the callback is each choice-named
  // function there, tried from the likeliest down with the argument shapes such callbacks take, until the box shows
  // the choice (so a decoy, like a search box's onChange, costs one short wait and is passed over).
  const PICK_PROPS = ['selectedItem', 'onSelect', 'onSelectItem', 'onItemSelect', 'onItemClick', 'onPick']; // tried first
  const TOGGLE_PROPS = ['onCheckboxChange', 'onCheckChange', 'onItemToggle', 'onToggleItem', 'toggleItem', 'onMultiSelect', 'onMultiChange'];
  const MULTI_FLAGS = ['isMultiSelect', 'multiSelect', 'isMulti', 'multiple', 'multi'];
  const PICK_RE = /select|pick|chos|option|item|change|value|set/i;
  const NOT_PICK_RE = /^(get|is|has|render|format|validat)|blur|focus|key|open|close|toggle|search|filter|input|scroll|mouse|hover|clear|remove|delete|disabled|label|cancel|reset|submit|load|fetch/i;
  const pickRank = (k) => (PICK_PROPS.includes(k) ? 0 : /^(onChange|setValue)$/.test(k) ? 3 : /select|pick|chos|option|item/i.test(k) ? 1 : 2);
  const optionText = (o) => (o && typeof o === 'object'
    ? OPTION_KEYS.map((k) => o[k]).filter((x) => x !== undefined && x !== null).map(String)
    : [String(o)]);
  // The box's option for one wanted value, and the callbacks to try in order: those on the object holding the list
  // (the portal's component) first, then choice-named ones (never a bare onChange/setValue) on the box's other components,
  // for a page that keeps the list on one component and the callback on another. Toggle callbacks are kept apart.
  const pickPlan = (el, wanted, match = score) => {
    let item = null;
    let top = 0;
    let holder = null;
    const fns = [];
    const toggles = [];
    let multiFlag = false;
    ownProps(el).forEach((p, dist) => {
      for (const [h, k] of entriesOf(p)) {
        const v = h[k];
        if (MULTI_FLAGS.includes(k) && v) multiFlag = true;
        if (typeof v === 'function') {
          if (TOGGLE_PROPS.includes(k)) toggles.push({ h, k, dist });
          else if (PICK_RE.test(k) && !NOT_PICK_RE.test(k)) fns.push({ h, k, dist, rank: pickRank(k) });
        } else if (isOptionList(v)) {
          for (const o of v) {
            const sc = Math.max(0, ...optionText(o).map((t) => match(t, wanted)));
            if (sc > top) { top = sc; item = o; holder = h; }
          }
        }
      }
    });
    if (!item) return null;
    const order = (a, b) => a.rank - b.rank || a.dist - b.dist;
    return {
      item,
      multi: multiFlag,
      toggles: [...toggles.filter((f) => f.h === holder), ...toggles.filter((f) => f.h !== holder)],
      fns: [...fns.filter((f) => f.h === holder).sort(order), ...fns.filter((f) => f.h !== holder && f.rank <= 1).sort(order)],
    };
  };
  // The argument shapes a choice callback takes: the item itself (the portal, react-select), its id with the item (antd),
  // and, for a change/value-named callback only, its text or a change event carrying the id (MUI-style). Each is
  // tried only until the box shows the choice.
  const idOf = (o) => (o && typeof o === 'object' ? o.value ?? o.id ?? o.key : o);
  const textOf = (o) => (o && typeof o === 'object' ? o.title ?? o.label ?? o.name ?? o.text ?? idOf(o) : o);
  const pickArgs = (el, o) => {
    const id = idOf(o);
    const text = textOf(o);
    const out = [{ args: [o], rank: 0 }];
    if (id !== o) out.push({ args: [id, o], rank: 0 });
    if (text !== o && text !== id) out.push({ args: [text, o], rank: 2 });
    out.push({ args: [{ target: { value: id, name: el.name, id: el.id }, currentTarget: el, type: 'change', preventDefault() {}, stopPropagation() {} }, o], rank: 2 });
    return out;
  };
  const reactPick = async (el, list, type) => {
    const match = matcherFor(type);
    const first = pickPlan(el, list[0], match);
    if (!first || (!first.fns.length && !first.toggles.length)) return null;
    const multi = list.length > 1 || (first.multi && first.toggles.length > 0);
    if (multi) {
      // Choices the box holds already (the portal fills a saved language in; the user may have picked one by hand) are never
      // chosen again, which on a multi-select would take them off, and they must still be there after every choice.
      const present = list.filter((v) => showsChoice(shownChoices(el), v, match));
      let picked = 0;
      let blind = false;
      for (const v of list) {
        if (present.includes(v)) continue;
        // The owner's props are read again for every choice: the page re-renders after each one, and its handlers
        // work from the state of the render they came from.
        const p = pickPlan(el, v, match);
        if (!p) continue;
        const fn = p.toggles[0] || p.fns[0];
        if (!fn) break;
        try { fn.h[fn.k](p.item); } catch { continue; }
        picked++;
        if (blind) { await tick(0); continue; }
        // Each choice must show up, with the earlier ones still there, before the next goes in. A box whose text
        // names none of the choices cannot be read back (one that says "2 selected"): the rest go in unchecked.
        // One that shows the choices but not all of them is left alone: its callback replaced the value or refused it.
        const ok = await waitFor(() => { const sh = shownChoices(el); return showsChoice(sh, v, match) && present.every((x) => showsChoice(sh, x, match)); }, 400);
        if (ok) present.push(v);
        else if (list.some((x) => showsChoice(shownChoices(el), x, match))) return false;
        else blind = true;
      }
      return picked > 0 || present.length === list.length;
    }
    const shows = () => match(currentChoice(el), list[0]) >= 3;
    let tries = 0;
    for (const shape of pickArgs(el, first.item)) { // the commonest shape on every callback before a rarer one on any
      for (const { k, rank } of first.fns) {
        if (rank < shape.rank) continue;
        if (tries++ >= 6) return false; // a page full of decoys: the click path gets its turn
        // Handlers belong to a render: after a miss the page may have re-rendered, so the callback is looked up again.
        const now = pickPlan(el, list[0], match);
        const fn = now && now.fns.find((f) => f.k === k);
        if (!fn) continue;
        try { fn.h[fn.k](...shape.args); } catch { continue; }
        if (await waitFor(shows, 150)) return true;
      }
    }
    return false;
  };

  let mousedownWait = 600;
  const setCustom = async (el, list, type) => {
    const match = matcherFor(type);
    if (submits(el)) return false;
    if (list.every((v) => showsChoice(shownChoices(el), v, match))) return true; // already chosen (every one of them, on a multi-select)
    if (await reactPick(el, list, type)) return true;
    const before = new Set([...document.querySelectorAll(OPTION_SEL)].filter(isVisible));
    clickOnly(el);
    let opts = await waitFor(() => optionsFor(el, before), 150);
    if (!opts) {
      // Some widgets (e.g. MUI Select) open on mousedown rather than click.
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      // The generous wait is paid once: on a page where mousedown opened nothing, the other boxes get a short one.
      opts = await waitFor(() => optionsFor(el, before), mousedownWait);
      if (!opts) mousedownWait = 150;
    }
    if (!opts) { closeList(el); return false; }
    let any = false;
    for (const v of list) {
      if (showsChoice(shownChoices(el), v, match)) continue; // a chosen option clicked again comes off a multi-select
      const opt = best(optionsFor(el, before) || [], v, (o) => [o.textContent], match);
      if (!opt || submits(opt)) continue;
      clickOnly(opt);
      any = true;
      if (list.length > 1) await tick(0);
    }
    if (!any || list.length > 1) closeList(el);
    if (!any) return false;
    if (list.length > 1) return true;
    // A read-only input (the portal) shows the chosen text once React has re-rendered; other widgets show it as text.
    if (el.tagName !== 'INPUT') return !!(await waitFor(() => match(el.textContent || '', list[0]) >= 3, 150));
    return !!(await waitFor(() => match(currentChoice(el), list[0]) >= 3, 120));
  };

  // A file the box's accept list excludes (e.g. a PDF where the portal takes only .jpeg/.png/.jpg) is reported, not forced in.
  const accepts = (el, f) => {
    const acc = (el.getAttribute('accept') || '').toLowerCase().split(',').map((a) => a.trim()).filter(Boolean);
    const ext = '.' + (f.name || '').split('.').pop().toLowerCase();
    const mime = (f.type || '').toLowerCase();
    return !acc.length || acc.some((a) => a === ext || a === mime || (a.endsWith('/*') && mime.startsWith(a.slice(0, -1))));
  };

  const setFile = (el, f) => {
    if (!f || !f.dataUrl || !accepts(el, f)) return false;
    if (el.files && el.files[0] && el.files[0].name === f.name) return true;
    const [meta, b64] = f.dataUrl.split(',');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], f.name, { type: f.type || meta.slice(5).split(';')[0] }));
    el.files = dt.files;
    fire(el);
    return true;
  };

  const fmtDate = (iso, el) => {
    if (el.type === 'date') return iso;
    const [y, m, d] = iso.split('-');
    const ph = (el.placeholder || el.getAttribute('data-date-format') || '').toLowerCase().trim();
    const sep = (ph.match(/[-/.]/) || ['/'])[0];
    if (/^y/.test(ph)) return [y, m, d].join(sep);
    if (/^m/.test(ph)) return [m, d, y].join(sep);
    return [d, m, y].join(sep); // Indian default: DD/MM/YYYY
  };
  // Whether a date box shows the saved YYYY-MM-DD date, however the page draws it: "14/05/1991", "1991-05-14",
  // "14 May 1991", "05/14/91". Dates are compared by their parts, since the ISO text never matches the box's.
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const sameDate = (shown, iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    const s = String(shown).toLowerCase();
    const nums = (s.match(/\d+/g) || []).map(Number);
    const monthShown = nums.includes(m) || (m >= 1 && m <= 12 && s.includes(MONTHS[m - 1]));
    return nums.includes(d) && monthShown && (nums.includes(y) || nums.includes(y % 100));
  };

  const setField = (f, v) => {
    const { el, kind, type } = f;
    if (kind === 'file') return setFile(el, v);
    if (typeof v === 'object' && !Array.isArray(v)) return false;
    if (DATE_TYPES.includes(type)) return kind === 'text' || kind === 'date' ? setText(el, fmtDate(String(v), el), type) : false;
    const list = Array.isArray(v) ? v.map(String) : [String(v)];
    if (kind === 'text' || kind === 'date') return setText(el, list.join(', '), type);
    if (kind === 'multi') return setMulti(el, list);
    if (kind === 'select') return setSelect(el, list[0], type);
    if (kind === 'radio') return setRadio(el, list[0], type);
    return setCustom(el, list, type);
  };

  // ---------- run ----------
  // ID number and passport boxes are filled only after the ID type has been picked: typing the number
  // first gets it truncated (the portal), and the boxes are disabled until then anyway.
  const DEFERRED = ['idNumber', 'passportCountry', 'nationality', 'visaType', 'visaNumber', 'visaValidity'];
  const CONTACT_TYPES = ['mobile', 'email', 'city', 'state', 'country', 'pincode', 'gothram', 'street', 'district', 'doorNo'];
  const valueFor = (p, type) => {
    if (type === 'passportCountry') return isEmpty(p.nationality) ? null : p.nationality;
    if (type === 'ageGroup') return isEmpty(p.age) ? null : p.age; // the band is worked out from the age
    // Entry pages keep email and address only in General Details. With one ticket those boxes join the row, and
    // they still take the booking contact first, as with more tickets. Volunteer Service cards keep each volunteer's own.
    if (contactFirst && CONTACT_TYPES.includes(type) && !isEmpty(contact[type])) return contact[type];
    return isEmpty(p[type]) ? contact[type] : p[type];
  };

  // Wait briefly for the member rows if the page is still rendering them (e.g. Alt+A right after navigating).
  let snap = scan();
  let rows = buildRows(snap.items);
  if (!rows.length) {
    await waitFor(() => { snap = scan(); rows = buildRows(snap.items); return rows.length; }, 2500);
  }
  if (!rows.length) return done({ rowsFound: 0, filled: 0, complete: 0, stats: {}, failed: [], noValue: [], manual: [], ms: Math.round(performance.now() - t0) });

  // Group Volunteer Service: pressing fill again on the same member's form refills that member instead of the next one.
  let list = people.slice();
  let repeated = false;
  if (previous && rows[0].fields.name) {
    const shown = squash(rows[0].fields.name.el.value);
    if (shown && shown === squash(previous.name)) { list = [previous, ...people]; repeated = true; }
  }
  const n = Math.min(rows.length, list.length);

  // A box the site locked with its own value belongs to one particular person: infant standard's read-only Gender
  // (rows are always Mother, then Father), PLD's Self age from the slot page, a registered volunteer's card.
  // "K.Padmavathi" = "Padmavathi K": a name's letters in a fixed order, to compare a name shown on the page with a saved one.
  const words = (x) => String(x ?? '').toUpperCase().split(/[^A-Z]+/).filter(Boolean).sort().join(' ');
  const fits = (f, type, v) => {
    if (!f || !f.off || isEmpty(v)) return true;
    const want = String(v);
    if (f.kind === 'radio') {
      const r = radioGroup(f.el).find((x) => x.checked);
      return !r || radioLabel(r).some((t) => score(t, want) >= 2);
    }
    const cur = f.el.value;
    if (!cur) return true;
    if (type === 'age') return +cur === +v;
    if (DATE_TYPES.includes(type)) return sameDate(cur, want); // a picker already showing the saved date
    if (type === 'ageGroup') return ageBandScore(cur, want) > 0;
    if (type === 'name') return words(cur) === words(want); // "K.Padmavathi" = "Padmavathi K"
    if (type === 'idNumber') return squash(cur) === squash(want);
    return score(cur, want) >= 2; // gender: "Female" / "F"
  };
  const fitsRow = (row, p) => LOCKED_ANCHORS.every((t) => fits(row.fields[t], t, valueFor(p, t)));
  // Group Volunteer Service shows one volunteer card at a time. If the portal locked it to a registered volunteer, it is filled only for that
  // member, wherever they are in the list; if none of the ticked members is that volunteer, the card is left alone.
  if (groupCard && rows.length === 1 && !fitsRow(rows[0], list[0])) {
    const j = list.findIndex((p) => fitsRow(rows[0], p));
    if (j >= 0) [list[0], list[j]] = [list[j], list[0]];
    else {
      // A member already filled in this run (the user went back to their card): refill them, counted once.
      const k = lockPool.findIndex((p) => fitsRow(rows[0], p));
      if (k < 0) return done({ rowsFound: 1, filled: 0, complete: 0, lockedOther: true, stats: {}, failed: [], noValue: [], manual: [], ms: Math.round(performance.now() - t0) });
      list = [lockPool[k], ...list];
      repeated = true;
    }
  }
  // Keep the ticked order, except swap a person onto the row whose locked boxes are theirs.
  for (let i = 0; i < n; i++) {
    if (fitsRow(rows[i], list[i])) continue;
    const j = list.findIndex((p, k) => k > i && k < n && fitsRow(rows[i], p) && fitsRow(rows[k], list[i]));
    if (j > 0) [list[i], list[j]] = [list[j], list[i]];
  }

  // ---------- the page's own complaints ----------
  // Messages the page shows beside the boxes once they are filled (the portal: an age outside the booking's range, the same
  // ID in two rows, a name it will not take): red text, or text in an element styled as an error, near a filled
  // row's boxes. Reported on the card so the user sees them before pressing Continue. Only text that was not showing
  // before the fill counts: a standing notice ("Please carry the original ID proof"), a hint beside a box ("Only
  // JPEG/PNG up to 1 MB") or an empty row's own "cannot be empty" is not a complaint about what went in. Rows left
  // for other people are not read either.
  const ERROR_RE = /cannot|valid|must|should|already|duplicate|allowed|mismatch|exceed|minimum|maximum|between|only|enter|please|required|wrong|incorrect|at least|at most|digits|characters/i;
  const looksLikeError = (node) => {
    if (/\b(error|err|invalid|danger|warning)\b/i.test(node.className || '') || /\b(error|err|invalid)\b/i.test(node.parentElement?.className || '')) return true;
    const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(getComputedStyle(node).color || '');
    return !!m && +m[1] >= 150 && +m[2] < 110 && +m[3] < 110;
  };
  // Where the page writes its complaints about one person's boxes. A row of its own (several members) is read whole.
  // With one member the row builder's "row" is the whole page, so the tightest element holding all of the row's
  // boxes is read instead (the member's card, or the form), and failing that the wrapper around each box, as far up
  // as it still holds only that box. Never the whole page: its notices, footer and other extensions' panels are not
  // about the fill.
  const PAGE_ROOTS = [document.documentElement, document.body];
  const errorZones = (row) => {
    if (!PAGE_ROOTS.includes(row.el)) return [row.el];
    const boxes = Object.values(row.fields).map((f) => f.el);
    let lca = boxes.length ? boxes[0].parentElement : null;
    while (lca && !boxes.every((b) => lca.contains(b))) lca = lca.parentElement;
    if (lca && !PAGE_ROOTS.includes(lca)) return [lca];
    return boxes.map((b) => {
      let zone = b;
      for (let i = 0, q = b.parentElement; i < 3 && q && !PAGE_ROOTS.includes(q) && q.querySelectorAll(CONTROLS).length <= 1; i++, q = q.parentElement) zone = q;
      return zone;
    });
  };
  // The complaints showing now in the filled rows, except those in `skip` (what showed before the fill); at most
  // `limit` of them. The cheap text checks run first: the layout and style reads are the slow part on a big page.
  const pageErrors = (skip = new Set(), limit = Infinity) => {
    const seen = new Set();
    for (let i = 0; i < n && seen.size < limit; i++) {
      if (!rows[i]) continue;
      for (const zone of errorZones(rows[i])) {
        if (!zone.isConnected) continue;
        for (const node of zone.querySelectorAll('*')) {
          if (seen.size >= limit) break;
          if (node.children.length || node.closest('input, select, textarea, button, label, ul, option')) continue;
          const text = (node.textContent || '').trim();
          if (text.length < 6 || text.length > 120 || skip.has(text) || seen.has(text) || !ERROR_RE.test(text)) continue;
          if (isVisible(node) && looksLikeError(node)) seen.add(text);
        }
      }
    }
    return [...seen];
  };

  const attempts = new Map(); // element -> tries, so a hopeless field is not retried forever
  // A dropdown that refused every path (no owner callback took the choice, no list opened) is tried again only once
  // something about it changed: its options (a list filled in after another box) or its value (a re-render). The same
  // box in the same state would only cost the same second of waiting again, twelve times over on a six-row page.
  const refused = new Map(); // dropdown element -> how it looked when every path failed
  const ddState = (el) => {
    return `${currentChoice(el)}|${optionLists(el).map((a) => a.length).join(',') || '-'}`;
  };
  // A box that already shows a different value gets the saved one (the saved member stays the source of truth: the row
  // may now be someone else's), but never in silence: what it showed is reported, so a correction the user typed on the
  // page after an earlier fill (an age gone up, a spelling) can be typed again or fixed in the saved member. Only a
  // box's first write of this run counts; a retry replaces this run's own text.
  const replaced = [];
  const showing = (f) => {
    const { el, kind } = f;
    try {
      if (kind === 'file') return (el.files && el.files[0] && el.files[0].name) || '';
      if (kind === 'multi') return ''; // choices are added, nothing is replaced
      if (kind === 'radio') { const r = radioGroup(el).find((x) => x.checked); return (r && radioLabel(r).find(Boolean)) || ''; }
      if (kind === 'select') { const o = el.options[el.selectedIndex]; return o && o.value ? o.text.trim() : ''; }
      const v = String(currentChoice(el)).trim();
      return /^(select|choose|--)/i.test(v) ? '' : v; // a placeholder is not a value
    } catch { return ''; }
  };
  const tryFill = async (f, v, row = 0) => {
    const k = attempts.get(f.el) || 0;
    if (k >= 2) return false;
    if (f.kind === 'custom' && refused.has(f.el) && refused.get(f.el) === ddState(f.el)) return false;
    if (overdue()) { timedOut = true; return false; } // left out for want of time, not because the box refused
    attempts.set(f.el, k + 1);
    const was = k ? '' : showing(f);
    let ok = false;
    try { ok = await setField(f, v); } catch { ok = false; }
    if (!ok && f.kind === 'custom') refused.set(f.el, ddState(f.el));
    if (ok && was) {
      const now = showing(f);
      // A multi-select that kept every earlier choice and gained one has had nothing replaced, only added.
      const parts = (x) => String(x).split(/\s*[,;|]\s*/).map(squash).filter(Boolean);
      const added = parts(was).every((w) => parts(now).includes(w));
      if (now && squash(now) !== squash(was) && !added) replaced.push({ row, type: f.type, was, now });
    }
    return ok;
  };

  const okKeys = new Set(); // "row:type" filled correctly in the latest round
  const undoneKeys = new Set(); // keys the page took and later emptied, rewrote or re-rendered (until refilled)
  const accepted = new Map(); // key -> what a successful fill looked like, to check the box again later
  const loose = (s) => String(s ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const witness = (f, v) => ({ v, text: f.kind === 'text' || f.kind === 'date' ? f.el.value : null });
  // Does the live box still hold what went in? The same test that made the fill count, run again on the current node:
  // a text box must show the text the page took (ignoring punctuation and case), a list box its chosen option.
  const holds = (f, w) => {
    const { el, kind } = f;
    if (!w || !el.isConnected) return false;
    if (kind === 'text' || kind === 'date') return loose(el.value) === loose(w.text);
    // An upload box is not read back: many pages empty the input once they have taken the file (a thumbnail shows
    // instead), and filling it again would upload the file a second time.
    if (kind === 'file') return true;
    const list = Array.isArray(w.v) ? w.v.map(String) : [String(w.v)];
    const m = matcherFor(f.type); // the same matching the fill chose with (age bands for an Age Group list)
    if (kind === 'select') { const opt = best([...el.options], list[0], (o) => [o.text, o.value], m); return !!opt && el.value === opt.value; }
    if (kind === 'radio') { const r = best(radioGroup(el), list[0], radioLabel, m); return !!r && r.checked; }
    if (kind === 'multi') return [...el.options].some((o) => o.selected);
    // A list box must show every choice that went in: one value, or each of a multi-select's (joined by commas).
    return list.every((v) => showsChoice(shownChoices(el), v, m) || m(el.textContent || '', v) >= 3);
  };
  // Boxes outside every person row (the booking-level contact section), keyed by type and position so the same box
  // is found again after the page re-rendered it.
  const contactItems = () => {
    const seen = {};
    return snap.items
      .filter((it) => CONTACT_TYPES.includes(it.type) && !rows.some((r) => r.el.contains(it.el)))
      .map((it) => ({ it, key: `c:${it.type}:${(seen[it.type] = (seen[it.type] || 0) + 1)}` }));
  };
  const fieldFor = (key, contacts) => {
    if (key.startsWith('c:')) return contacts.get(key) || null;
    const [i, type] = key.split(':');
    return (rows[+i] && rows[+i].fields[type]) || null;
  };
  // After a rescan: every box counted as filled is looked up again on the live page and must still hold its value;
  // one that is gone, empty or holding something else is dropped (and filled again by the next round, if any).
  const recheck = () => {
    const contacts = new Map(contactItems().map((c) => [c.key, c.it]));
    let lost = 0;
    for (const key of [...okKeys]) {
      const f = fieldFor(key, contacts);
      if (f && holds(f, accepted.get(key))) continue;
      okKeys.delete(key);
      undoneKeys.add(key);
      lost++;
    }
    return lost;
  };

  // Volunteer Service looks a typed pincode up (0.5 s debounce + an API call), then writes back a copy of the card taken
  // when the pincode was typed, blanking whatever was typed after it. So on address sections with a District box
  // the pincode is typed last of all, once everything else is in, whatever the lookup's latency.
  let pinHeld = false;
  let pinLate = false;
  const round = async (first) => {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (!rows[i]) continue; // the page removed this row meanwhile (re-render, ticket count changed)
      for (const [type, f] of Object.entries(rows[i].fields)) {
        const key = `${i}:${type}`;
        if (okKeys.has(key) || f.off || (first && DEFERRED.includes(type))) continue;
        if (type === 'pincode' && rows[i].fields.district && !pinLate) { pinHeld = true; continue; }
        const v = valueFor(list[i], type);
        if (isEmpty(v)) continue;
        if (await tryFill(f, v, i + 1)) { okKeys.add(key); accepted.set(key, witness(f, v)); changed++; }
      }
    }
    // Fields outside every person row belong to the booking-level contact section.
    for (const { it, key } of contactItems()) {
      if (it.off || okKeys.has(key)) continue;
      const v = isEmpty(contact[it.type]) && list.length === 1 ? list[0][it.type] : contact[it.type];
      if (isEmpty(v)) continue;
      if (await tryFill(it, v)) { okKeys.add(key); accepted.set(key, witness(it, v)); changed++; }
    }
    return changed;
  };

  // the portal enables a row's ID number box only once its ID type is chosen, and a page may do that late: the enable can
  // land after an API round-trip or a deferred state commit (or simply late on a slow phone), after the rounds below
  // have given up on the box. So once a row's ID type is in, a deferred box of that row that is still disabled and
  // empty is waited for (all such rows together, up to 1.5 s, once per row), and the rows are rescanned so a box the
  // page re-rendered is picked up. A read-only box, or one the site filled itself, is never waited for.
  const boxDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';
  const lateDeferred = (rowWanted) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (!rows[i] || !rowWanted(i) || !okKeys.has(`${i}:idType`)) continue;
      for (const [type, f] of Object.entries(rows[i].fields)) {
        if (!DEFERRED.includes(type) || okKeys.has(`${i}:${type}`) || f.locked || !boxDisabled(f.el) || f.el.value) continue;
        if (!isEmpty(valueFor(list[i], type))) out.push({ i, el: f.el });
      }
    }
    return out;
  };
  const waitedRows = new Set();
  const waitForDeferred = async () => {
    if (snap.dialogItems.length) return; // a popup is up (the portal's passport instructions): its boxes are filled below
    let late = lateDeferred((i) => !waitedRows.has(i));
    if (!late.length) return;
    const mine = new Set(late.map((x) => x.i));
    mine.forEach((i) => waitedRows.add(i));
    const end = performance.now() + 1500;
    while (late.length && performance.now() < end && !overdue()) {
      await waitFor(() => late.every((x) => !x.el.isConnected || !boxDisabled(x.el)), end - performance.now());
      snap = scan();
      rows = buildRows(snap.items);
      late = lateDeferred((i) => mine.has(i));
    }
  };

  // What the page already says before anything goes in, so that only new complaints are reported afterwards.
  const errorsBefore = new Set(pageErrors());

  // Keep going while something new got filled: each round can unlock the next field (age -> ID type -> ID number).
  let changed = await round(true);
  for (let k = 0; k < 6; k++) {
    await tick(changed ? 16 : 40);
    snap = scan();
    rows = buildRows(snap.items);
    // A box the page re-rendered, cleared or rewrote since it went in (e.g. the ID number wiped when the type
    // changed, or text typed over it) is filled again; a node the page replaced is not trusted.
    recheck();
    await waitForDeferred();
    changed = await round(false);
    if (!changed && k > 0) break;
  }

  if (pinHeld) {
    pinLate = true;
    if (await round(false)) {
      await tick(16);
      snap = scan();
      rows = buildRows(snap.items);
    }
  }

  // the portal's passport popup ("Photo ID Proof Instructions"); never press its buttons. Seva, DIP, PLD and infant pages
  // draw one popup inside each member's row, and its Submit writes into that row, so it gets that row's member.
  // SED draws one page-level popup (outside every row), tied to the last row switched to Passport.
  let passportPopup = false;
  const popupFailed = []; // passport-popup boxes that did not take their value (added to failed in the report)
  const lastPassport = list.slice(0, n).filter((p) => p.idType === 'Passport').pop();
  for (const it of snap.dialogItems) {
    if (it.off || !DEFERRED.includes(it.type)) continue;
    const owner = rows.findIndex((r) => r.el !== document.documentElement && r.el.contains(it.el));
    const p = owner < 0 ? lastPassport : list[owner]; // a row past the saved members has no one
    if (!p || p.idType !== 'Passport') continue;
    const v = it.type === 'idNumber' ? p.idNumber : valueFor(p, it.type);
    if (isEmpty(v)) continue;
    // row 0: the page-level popup. A box the popup did not take is reported like a row's, never as "filled".
    if (await tryFill(it, v, owner + 1)) passportPopup = true;
    else popupFailed.push({ type: it.type, row: owner + 1, ...(tooLongBoxes.get(it.el) || {}) });
  }

  // ---------- settle, then check again ----------
  // The page gets time to react before anything is reported. A check it runs late (a debounced validator, a
  // duplicate-ID lookup answered after blur), an effect resetting a dependent box, a re-render replacing the boxes
  // or a saved value arriving late would otherwise leave a box empty or holding something else while the card still
  // counts it as filled. The wait ends once the filled rows have been quiet for SETTLE_QUIET ms, after at least
  // SETTLE_MIN ms and at most SETTLE_MAX ms; then every box counted as filled is rechecked on the live page, one more
  // round refills what the page undid, and the page gets the same time again. All waiting goes through tick(), so it
  // holds in a hidden tab.
  const SETTLE_MIN = 500;
  const SETTLE_QUIET = 300;
  const SETTLE_MAX = 1500;
  const SETTLE_POLL = 50;
  const shape = (el) => `${el.isConnected ? 1 : 0}${el.disabled ? 1 : 0}${el.readOnly ? 1 : 0}|${el.value ?? ''}|${el.tagName === 'INPUT' ? '' : (el.textContent || '').length}`;
  const fingerprint = () => {
    const parts = [];
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      if (!row) { parts.push('-'); continue; }
      parts.push(row.el.isConnected ? `${row.el.querySelectorAll('*').length}|${(row.el.textContent || '').length}` : 'x');
      for (const f of Object.values(row.fields)) parts.push(shape(f.el));
    }
    for (const { it } of contactItems()) parts.push(shape(it.el));
    return parts.join('\n');
  };
  const settle = async () => {
    const start = performance.now();
    let last = fingerprint();
    let quietSince = start;
    let scanned = start;
    for (;;) {
      await tick(SETTLE_POLL);
      const now = performance.now();
      // A row the page re-mounted is found again, so the wait follows the live nodes rather than detached ones.
      if (now - scanned >= 150 && (rows.length < n || rows.some((r) => !r.el.isConnected))) {
        scanned = now;
        snap = scan();
        rows = buildRows(snap.items);
      }
      const cur = fingerprint();
      if (cur !== last) { last = cur; quietSince = now; }
      if (now - start >= SETTLE_MAX || overdue()) break; // past the fill's budget the page gets no more waiting
      if (now - start >= SETTLE_MIN && now - quietSince >= SETTLE_QUIET) break;
    }
    snap = scan();
    rows = buildRows(snap.items);
  };
  if (okKeys.size) {
    await settle();
    if (recheck() && (await round(false))) { await settle(); recheck(); }
  }

  // ---------- rows past the ticked members ----------
  // Rows beyond the ticked list are never written, but one may still hold someone from an earlier, larger fill
  // (three ticked, then two): left there, the portal's Continue books them. Such a row is reported by name, and its text
  // boxes are emptied when the filler itself wrote that row (its mark from the earlier fill still sits on the row's
  // element, with the name it wrote), never a row the user typed in by hand or edited since. Boxes the site locked
  // (PLD's spouse age, a registered volunteer) are the site's and do not count. Dropdowns keep their choice: the portal's
  // lists have no blank item, and an empty name box is enough for its Continue to stop at that row.
  const WROTE = Symbol.for('member-autofill.wrote'); // row element -> the name the filler put there (set in the report)
  const TEXT_ANCHORS = ['name', 'age', 'dob', 'idNumber'];
  const liveBox = (row, type) => {
    const f = row.fields[type];
    return f && !f.off && (f.kind === 'text' || f.kind === 'date') && f.el.isConnected ? f : null;
  };
  const rowHolds = (row) => TEXT_ANCHORS.some((t) => { const f = liveBox(row, t); return !!f && !isEmpty(f.el.value); });
  const shownName = (row) => { const f = liveBox(row, 'name'); return f ? f.el.value.trim() : ''; };
  const staleRows = [];
  const clearedRows = [];
  let firstStale = null;
  for (let i = n; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.el === document.documentElement || !row.el.isConnected || !rowHolds(row)) continue;
    const name = shownName(row);
    if (name && row.el[WROTE] === words(name) && !overdue()) {
      for (const t of TEXT_ANCHORS) {
        const f = liveBox(row, t);
        if (f && f.el.value) { try { await setText(f.el, '', t); } catch { /* stays: reported below */ } }
      }
      await tick(16); // let React commit; a refused clear shows up as the old value
      if (!rowHolds(row)) { delete row.el[WROTE]; clearedRows.push({ row: i + 1, name }); continue; }
    }
    staleRows.push({ row: i + 1, name: shownName(row) });
    if (!firstStale) firstStale = liveBox(row, 'name') ? liveBox(row, 'name').el : row.el;
  }

  // ---------- report ----------
  const stats = {};
  const failed = [];
  failed.push(...popupFailed);
  const undone = []; // taken by the page, then emptied, rewritten or replaced before the fill ended
  const noValue = [];
  const manual = []; // read-only date pickers holding nothing (or another date): left for the user to pick
  let complete = 0;
  let firstProblem = null;
  for (let i = 0; i < n; i++) {
    if (!rows[i]) continue; // gone from the page: not counted as complete
    let rowOk = true;
    for (const [type, f] of Object.entries(rows[i].fields)) {
      const v = valueFor(list[i], type);
      // AngularJS (older the portal portal) keeps a rejected value on screen and only marks the box ng-invalid.
      // (Not :invalid: the portal's React name box carries pattern="/^[a-zA-Z ]*$/", which no name can match.)
      const ngRejected = f.kind === 'text' && !!f.el.value && f.el.classList.contains('ng-invalid');
      // (A box something typed over after the fill was dropped from okKeys by the recheck after the settle wait.)
      if (okKeys.has(`${i}:${type}`) && !ngRejected) { stats[type] = (stats[type] || 0) + 1; continue; }
      // Locked by the site with its own value (e.g. senior-citizen flow): fine if it is this person's, a problem if not.
      if (f.off && f.el.value && fits(f, type, v)) continue;
      // One-row pages: the booking-level boxes land in the row; one the site already filled is fine.
      if (CONTACT_TYPES.includes(type) && isEmpty(v) && f.el.value) continue;
      rowOk = false;
      (isEmpty(v) ? noValue : f.manual ? manual : undoneKeys.has(`${i}:${type}`) ? undone : failed).push({ type, row: i + 1, ...(tooLongBoxes.get(f.el) || {}) });
      if (!firstProblem) firstProblem = f.el;
    }
    if (rowOk) complete++;
    // Remember that this row's name is the filler's own write, for a later, smaller fill (see "rows past the ticked members").
    if (okKeys.has(`${i}:name`) && rows[i].fields.name && rows[i].el !== document.documentElement) rows[i].el[WROTE] = words(rows[i].fields.name.el.value);
  }
  for (const { it, key } of contactItems()) {
    if (okKeys.has(key) || it.off) continue;
    const late = undoneKeys.has(key);
    if (it.el.value && !late) continue; // already holds something (e.g. the site's saved address)
    const v = contact[it.type];
    (late ? undone : isEmpty(v) ? noValue : failed).push({ type: it.type, row: 0, ...(tooLongBoxes.get(it.el) || {}) });
    if (!firstProblem) firstProblem = it.el;
  }
  // A read-only date picker in the passport popup (visa validity) is never written either: an empty one whose
  // member has a date saved is left for the user, like a row's.
  for (const it of snap.dialogItems) {
    if (!it.manual || it.el.value) continue;
    const owner = rows.findIndex((r) => r.el !== document.documentElement && r.el.contains(it.el));
    const p = owner < 0 ? lastPassport : list[owner];
    if (!p || p.idType !== 'Passport' || isEmpty(valueFor(p, it.type))) continue;
    manual.push({ type: it.type, row: owner + 1 });
    if (!firstProblem) firstProblem = it.el;
  }

  if (!firstProblem && firstStale) firstProblem = firstStale; // a row still holding someone not ticked needs the user too

  // Afterwards: jump to the first box that still needs the user, else a CAPTCHA box if the page has one.
  let focused = null;
  if (focusCaptcha) {
    let target = firstProblem;
    if (!target) {
      target = snap.captcha;
      if (!target) {
        const img = document.querySelector('img[src*="captcha" i], img[alt*="captcha" i], img[id*="captcha" i], canvas[id*="captcha" i]');
        for (let p = img && img.parentElement, i = 0; p && i < 4 && !target; p = p.parentElement, i++) {
          target = [...p.querySelectorAll('input[type="text"], input:not([type])')].find((e) => isShown(e) && !e.value) || null;
        }
      }
      if (target) focused = 'captcha';
    } else {
      focused = 'problem';
    }
    if (target) {
      target.scrollIntoView({ block: 'center' });
      if (!target.readOnly && !target.disabled) target.focus({ preventScroll: true });
    }
  }

  return done({
    rowsFound: rows.length,
    filled: n,
    complete,
    repeated,
    nameWritten: okKeys.has('0:name'),
    filledId: list[0] && list[0].id, // who went into the first row (Group Volunteer Service counts progress by it)
    hasName: !!(rows[0] && rows[0].fields.name && !rows[0].fields.name.off),
    stats,
    failed,
    undone,
    noValue,
    manual,
    // Every box that had a value to go in refused it: the page itself changed, not the person's details. (A value
    // the extension itself held back as too long for its box is not the page refusing anything.)
    rejected: failed.some((f) => !f.why) && !okKeys.size && !undoneKeys.size,
    pageErrors: pageErrors(errorsBefore, 4),
    staleRows, // rows past the ticked members that still hold someone: [{ row, name }] (name '' when only other boxes hold)
    clearedRows, // such rows the filler emptied, because it had written them itself
    replaced, // boxes that showed another value before this run wrote them: [{ row, type, was, now }]
    passportPopup,
    // Boxes the page took the focus away from while they were filled (a popup's trap, a check): nothing was typed
    // into the box that took it, the value went in through the page's own handler. The card asks for a look.
    focusPulled,
    focused,
    timedOut, // the time budget ran out with boxes still to fill (they are listed in `failed`)
    ms: Math.round(performance.now() - t0),
  });
  } finally {
    // Every way out, a thrown error included, frees the page for the next fill and stops the timing worker.
    if (window[LOCK] === lock) window[LOCK] = null;
    try { sleeper?.terminate(); } catch { /* already gone */ }
  }
}

// Small result card shown on the booking page itself (so Alt+A users see what happened). Also self-contained.
function showToast({ lines, kind, title }) {
  const ID = 'member-autofill-toast';
  document.getElementById(ID)?.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' }); // the page's scripts can't read the card
  const colors = { ok: '#1b5e20', warn: '#8a4b00', err: '#9b1c1c' };
  const box = document.createElement('div');
  box.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
  box.setAttribute('aria-live', kind === 'ok' ? 'polite' : 'assertive');
  box.tabIndex = 0;
  box.style.cssText = `max-width:340px;background:#fffdf8;color:#2b2118;border-left:5px solid ${colors[kind] || colors.ok};`
    + 'border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.22);padding:12px 14px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = `font-weight:700;margin-bottom:4px;color:${colors[kind] || colors.ok};`;
  box.append(h);
  for (const line of lines) {
    const p = document.createElement('div');
    p.textContent = line;
    box.append(p);
  }
  root.append(box);
  const close = () => host.remove();
  box.addEventListener('click', close);
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); });
  document.documentElement.append(host);
  setTimeout(close, kind === 'ok' ? 6000 : 15000);
}
