// solve.js — a fast, fresh reimplementation of makefun-site 1.0.0's build(input).
// Same answers for every input, written for speed: bulk HTML escaping, indexOf-based
// inline scanning, manual line checks instead of per-line regexes, one template parse
// per case with array-based rendering, and a per-run slug cache. No dependencies.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const MARK_RE = /\p{M}/gu;
const NONASCII_RE = /[^\x00-\x7F]/;
const WS_RE = /\s/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const escReplacer = (c) => ESC_MAP[c];

const ESC_TEST_RE = /[&<>"']/;
/** HTML-escape a whole string in one native pass. */
function esc(s) {
  if (!ESC_TEST_RE.test(s)) return s;
  return s.replace(ESC_RE, escReplacer);
}

/** Per-run slug cache (set by run()). */
let slugCache = null;

/** The slug of `text` (README "Text"), cached per run. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  if (NONASCII_RE.test(text)) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
}

/** JS whitespace (\s) as a table: WS_TABLE[code] is 1 for whitespace, else 0. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** Whether `c` (a one-char string) is JS whitespace (\s). */
function isWSChar(c) {
  return WS_TABLE[c.charCodeAt(0)] === 1;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? +raw.slice(0, 4) : 0;
      const mo = ok ? +raw.slice(5, 7) : 0;
      const d = ok ? +raw.slice(8, 10) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends. */
function parseFrontMatter(text) {
  let pos = 0;
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  pos = nl + 1;
  const data = {};
  let lineNo = 1;
  let closeEnd = -1;
  while (true) {
    nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    lineNo++;
    if (line === '---') {
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    // blank (spaces and tabs only) or comment
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      const ci = line.indexOf(':');
      let key = null;
      let raw = null;
      if (ci > 0) {
        let okKey = true;
        for (let i = 0; i < ci; i++) {
          const c = line.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || c === 95)) {
            okKey = false;
            break;
          }
        }
        if (okKey) {
          key = line.slice(0, ci);
          if (ci + 1 === line.length) raw = '';
          else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
          else key = null; // colon not followed by a space: not "key: value"
        }
      }
      if (key === null) return { error: `line ${lineNo} is not "key: value"` };
      let end = raw.length;
      while (end > 0) {
        const c = raw.charCodeAt(end - 1);
        if (c !== 32 && c !== 9) break;
        end--;
      }
      if (end !== raw.length) raw = raw.slice(0, end);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** A line of only spaces and tabs (or empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
    || code === 95 || code === 43 || code === 45;
}

/** A fence-open line's language, or null (line must be ``` + lang + spaces/tabs only). */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` is a fence-close line (``` + spaces/tabs only). */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h < 1 || h > 6 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h + 1;
  while (a < line.length) {
    const cc = line.charCodeAt(a);
    if (cc !== 32 && cc !== 9) break;
    a++;
  }
  let b = line.length;
  while (b > a) {
    const cc = line.charCodeAt(b - 1);
    if (cc !== 32 && cc !== 9) break;
    b--;
  }
  if (b <= a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break (--- or *** + spaces/tabs only). */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break.
 * Dispatched on the first character: only the check that line can pass runs. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** First index >= `from` where `s` holds `what` outside a backslash escape, or -1 (bounded by `end`). */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * >= `from` (one whose run is not **), outside an escape, or -1 (bounded by `end`). */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s[a..b)` rendered inline into `out`; `env.link(target)` resolves a link's href. */
const SPECIAL_RE = /[\\`*[]/g;

/** First index in [from, end) holding one of \\ ` * [, or -1. */
function nextSpecial(s, from, end) {
  let best = -1;
  const b1 = s.indexOf('\\', from);
  if (b1 !== -1 && b1 < end) best = b1;
  const b2 = s.indexOf('`', from);
  if (b2 !== -1 && b2 < end && (best === -1 || b2 < best)) best = b2;
  const b3 = s.indexOf('*', from);
  if (b3 !== -1 && b3 < end && (best === -1 || b3 < best)) best = b3;
  const b4 = s.indexOf('[', from);
  if (b4 !== -1 && b4 < end && (best === -1 || b4 < best)) best = b4;
  return best;
}

/** `s[a..b)` rendered inline into `out`; `env.link(target)` resolves a link's href. */
function inlineRange(s, a, b, env, out) {
  let i = a;
  let plain = a;
  while (i < b) {
    const n = nextSpecial(s, i, b);
    if (n === -1) break;
    const c = s[n];
    if (c === '\\') {
      if (n + 1 < b && ESCAPABLE.has(s[n + 1])) {
        if (n > plain) out.push(esc(s.slice(plain, n)));
        const nx = s[n + 1];
        out.push(nx === '>' ? '&gt;' : nx);
        i = n + 2;
        plain = i;
      } else {
        i = n + 1; // backslash itself: stays in the plain run
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', n + 1);
      if (j !== -1 && j < b && j > n + 1) {
        if (n > plain) out.push(esc(s.slice(plain, n)));
        out.push('<code>', esc(s.slice(n + 1, j)), '</code>');
        i = j + 1;
        plain = i;
      } else {
        i = n + 1; // no closer: backtick itself
      }
      continue;
    }
    if (c === '*') {
      if (s[n + 1] === '*') {
        const j = findUnescaped(s, '**', n + 2, b);
        if (j > n + 2) {
          if (n > plain) out.push(esc(s.slice(plain, n)));
          out.push('<strong>');
          inlineRange(s, n + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else {
          i = n + 2; // no closer: ** itself
        }
      } else {
        const j = findSingleStar(s, n + 1, b);
        if (j > n + 1) {
          if (n > plain) out.push(esc(s.slice(plain, n)));
          out.push('<em>');
          inlineRange(s, n + 1, j, env, out);
          out.push('</em>');
          i = j + 1;
          plain = i;
        } else {
          i = n + 1; // no closer: * itself
        }
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', n + 1, b);
    if (k !== -1 && s[k + 1] === '(') {
      const m = s.indexOf(')', k + 2);
      if (m !== -1 && m < b) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          if (n > plain) out.push(esc(s.slice(plain, n)));
          out.push('<a href="', esc(env.link(target)), '">');
          inlineRange(s, n + 1, k, env, out);
          out.push('</a>');
          i = m + 1;
          plain = i;
          continue;
        }
      }
    }
    i = n + 1; // not a link: [ itself
  }
  if (b > plain) out.push(esc(s.slice(plain, b)));
}

/** Any inline markup or HTML special: text without one renders as itself. */
const PLAIN_RE = /[\\`*\[&<>"']/;

/** `text` rendered inline as a string (fast path when it holds no markup). */
function inlineHtml(text, env) {
  if (!PLAIN_RE.test(text)) return text;
  const out = [];
  inlineRange(text, 0, text.length, env, out);
  return out.join('');
}

/** `src` rendered: { html, toc, excerpt }. `env.link(target)` resolves a link's href. */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        const body = [];
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const parts = ['<pre><code'];
        if (lang !== '') {
          parts.push(' class="language-', lang, '"');
        }
        parts.push('>');
        if (body.length > 0) parts.push(esc(body.join('\n')), '\n');
        parts.push('</code></pre>');
        blocks.push(parts.join('') + '\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inlineHtml(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const inner = [];
      for (let k = 0; k < body.length; k++) if (body[k] !== '') inner.push(body[k]);
      if (inner.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else blocks.push(`<blockquote>\n<p>${inlineHtml(inner.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    // list?
    let isOrdered = false;
    let start = 1;
    let firstText = null;
    if ((line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) {
      firstText = line.slice(2);
    } else {
      let j = 0;
      while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
        isOrdered = true;
        start = +line.slice(0, j);
        firstText = line.slice(j + 2);
      }
    }
    if (firstText !== null) {
      const items = [[trimLine(firstText)]];
      i++;
      while (i < n) {
        const l = lines[i];
        let matched = false;
        if (isOrdered) {
          let j = 0;
          while (j < l.length && l.charCodeAt(j) >= 48 && l.charCodeAt(j) <= 57) j++;
          if (j >= 1 && j <= 9 && l.charCodeAt(j) === 46 && l.charCodeAt(j + 1) === 32) {
            items.push([trimLine(l.slice(j + 2))]);
            i++;
            matched = true;
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push([trimLine(l.slice(2))]);
          i++;
          matched = true;
        }
        if (matched) continue;
        // continuation: two or more spaces, then a non-space
        let k = 0;
        while (k < l.length && l.charCodeAt(k) === 32) k++;
        if (k >= 2 && k < l.length && !isWSChar(l[k])) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (let k = 0; k < items.length; k++) {
        parts.push('<li>', inlineHtml(items[k].join('\n'), env), '</li>\n');
      }
      parts.push(`</${tag}>`);
      blocks.push(parts.join('') + '\n');
      continue;
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inlineHtml(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

function isNameStart(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}
function isNameChar(code) {
  return isNameStart(code) || (code >= 48 && code <= 57);
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const parts = text.split('.');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length === 0 || !isNameStart(p.charCodeAt(0))) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    for (let j = 1; j < p.length; j++) if (!isNameChar(p.charCodeAt(j))) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return parts;
}

/** Whether src[a..b) holds only spaces and tabs. */
function isSpacesTabs(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const L = src.length;
  while (i < L) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === L - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? L : nl;
    const standalone = isSpacesTabs(src, lineStart, open) && isSpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? L : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `{% for x in path %}` parsed, or null. */
function parseFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  const n = tag.length;
  if (i >= n || !isNameStart(tag.charCodeAt(i))) return null;
  let j = i + 1;
  while (j < n && isNameChar(tag.charCodeAt(j))) j++;
  const name = tag.slice(i, j);
  if (tag.slice(j, j + 4) !== ' in ') return null;
  const path = tag.slice(j + 4);
  if (path === '') return null;
  for (let k = 0; k < path.length; k++) if (isWSChar(path[k])) return null;
  return [name, path];
}

/** `{% if [not] path %}` parsed, or null. */
function parseIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '') return null;
  for (let k = 0; k < rest.length; k++) if (isWSChar(rest[k])) return null;
  return [not, rest];
}

/** `{% include "name" %}`'s name, or null. */
function parseInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const name = tag.slice(9, -1);
  if (name.length === 0) return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return name;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = parseFor(tag)) !== null) {
        const node = { kind: 'for', name: m[0], path: pathOf(name, m[1]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = parseIf(tag)) !== null) {
        const node = { kind: 'if', not: m[0], path: pathOf(name, m[1]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null && parent.else !== undefined ? parent.else : parent.then;
      } else if ((m = parseInclude(tag)) !== null) body.push({ kind: 'include', name: m });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts = new Array(v.length);
    for (let i = 0; i < v.length; i++) parts[i] = textOf(v[i]);
    return parts.join(', ');
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at a one-name path in the scope chain. */
function lookupOne(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/**
 * Each template's free variables: the root names it reads (through its includes),
 * minus the names its own fors bind. null when a cycle makes it unknowable.
 * An include's output depends only on its template's free variables (plus the
 * run's globals), so an include whose free variables resolve to the same values
 * renders the same text and can be reused within the run.
 */
function computeDeps(templates) {
  const cache = new Map();
  const tainted = new Set();
  const compute = (name, visiting) => {
    if (cache.has(name)) return cache.get(name);
    const nodes = templates.get(name);
    if (nodes === undefined) return new Set();
    if (visiting.has(name)) {
      for (const v of visiting) tainted.add(v);
      tainted.add(name);
      return null;
    }
    visiting.add(name);
    const free = new Set();
    let bad = false;
    const walk = (ns, bound) => {
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          if (n.kind === 'if') {
            walk(n.then, bound);
            if (n.else !== null) walk(n.else, bound);
          }
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') {
          const sub = compute(n.name, visiting);
          if (sub === null) bad = true;
          else for (const v of sub) if (!bound.has(v)) free.add(v);
        }
      }
    };
    walk(nodes, new Set());
    visiting.delete(name);
    const result = bad || tainted.has(name) ? null : free;
    cache.set(name, result);
    return result;
  };
  for (const name of templates.keys()) compute(name, new Set());
  return cache;
}

/** Sentinel for the run's globals in memo keys: site, tags and recent never change within a run. */
const MEMO_GLOBAL = {};

/** `nodes` rendered in `scope` into `out` (an array of strings). */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        const t = textOf(v);
        out.push(typeof v === 'number' || typeof v === 'boolean' ? t : esc(t));
        break;
      }
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // One scope object for the whole loop, mutated per item: rendering is
        // synchronous and the scope never escapes the iteration.
        const vars = {};
        const loop = { index: 0, first: true, last: false, length: len };
        vars[n.name] = undefined;
        vars.loop = loop;
        const child = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const d = ctx.deps.get(n.name);
        if (d === null || d.has('loop')) {
          renderNodes(t, scope, ctx, depth + 1, out);
          break;
        }
        // Memo key: the include depth, then each free variable's current value
        // (the run's globals collapse to one sentinel). The key's values are
        // the objects the template actually reads, so a hit renders identically.
        const keys = new Array(d.size + 1);
        keys[0] = depth;
        let ki = 1;
        for (const vname of d) {
          let v = lookupOne(scope, vname);
          if (v === ctx.site || v === ctx.tags || v === ctx.recent) v = MEMO_GLOBAL;
          keys[ki++] = v;
        }
        let root = ctx.memo.get(n.name);
        if (root === undefined) {
          root = new Map();
          ctx.memo.set(n.name, root);
        }
        let node = root;
        let hit = true;
        for (let i = 0; i < keys.length; i++) {
          const nx = node.get(keys[i]);
          if (nx === undefined) {
            hit = false;
            break;
          }
          node = nx;
        }
        if (hit) {
          out.push(node);
          break;
        }
        const tmp = [];
        renderNodes(t, scope, ctx, depth + 1, tmp);
        const str = tmp.join('');
        let m = root;
        for (let i = 0; i < keys.length - 1; i++) {
          let nx = m.get(keys[i]);
          if (nx === undefined) {
            nx = new Map();
            m.set(keys[i], nx);
          }
          m = nx;
        }
        m.set(keys[keys.length - 1], str);
        out.push(str);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  let start = 0;
  for (let k = 0; k <= rel.length; k++) {
    if (k === rel.length || rel.charCodeAt(k) === 47) {
      const seg = rel.slice(start, k);
      start = k + 1;
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
  }
  return parts.join('/');
}

/** A link's href test: does `target` carry a scheme? */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, reserved dir, post without date, layout, draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout !== undefined && s.data.layout !== null ? s.data.layout : (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return page.url + frag;
          if (staticPaths.has(path)) return base + '/' + path + frag;
        }
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTagsOf = (s) => {
    const tags = s.data.tags !== undefined ? s.data.tags : [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugify(tags[i]);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(tags[i]);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTagsOf(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names2 = ownTagsOf(s);
    s.tagRefs = new Array(names2.length);
    for (let j = 0; j < names2.length; j++) {
      const slug = slugify(names2[j]);
      const t = bySlug.get(slug);
      s.tagRefs[j] = t !== undefined ? t : { name: names2[j], slug, url: '', posts: [] };
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages.
  // One link object per source, built lazily and shared by the pages that point at it.
  const linkOf = (s) => {
    if (s === null) return null;
    if (s.link === undefined) s.link = { title: s.data.title, url: s.url, date: s.data.date !== undefined ? s.data.date : '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
    return s.link;
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date !== undefined ? s.data.date : '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary !== undefined ? s.data.summary : '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs,
    };
    s.page = {
      title: s.card.title,
      url: s.card.url,
      date: s.card.date,
      date_long: s.card.date_long,
      summary: s.card.summary,
      excerpt: s.card.excerpt,
      reading_minutes: s.card.reading_minutes,
      tags: s.card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer !== undefined && s.newer !== null ? s.newer : null),
      older: linkOf(s.older !== undefined && s.older !== null ? s.older : null),
      is_post: s.post,
    };
  }

  // 7. Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = new Array(tags.length);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    allTags[i] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates, deps: computeDeps(templates), memo: new Map(), site, tags: allTags, recent };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const all = { site, tags: allTags, recent };
    for (const k of Object.keys(vars)) all[k] = vars[k];
    const out = [];
    renderNodes(nodes, { vars: all, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[s.outDir + '/index.html'] = render(s.layout, { page: s.page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const slice = posts.slice((k - 1) * per, k * per);
    const cards = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) cards[i] = slice[i].card;
    const html = render('index', {
      posts: cards,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const cards = new Array(t.posts.length);
    for (let j = 0; j < t.posts.length; j++) cards[j] = t.posts[j].card;
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: cards } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
