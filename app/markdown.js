// markdown.js
// ---------------------------------------------------------------------------
// A small Markdown -> HTML renderer, tuned to render this README the way
// GitHub does. It covers GitHub-Flavored Markdown: headings, paragraphs,
// blockquotes, lists (nested), tables, fenced/inline code, task lists,
// images, links (inline + reference style), footnotes, emphasis, line breaks,
// and raw HTML pass-through.
//
// It is deliberately written to be readable and editable by hand, not to be
// the fastest or most complete parser in the world. If you want to change how
// something renders, find its section below and edit it.
//
// The public function is renderMarkdown(text). Everything else is a helper.
// Heading ids come from slugger.js so in-page #anchor links work.
// ---------------------------------------------------------------------------

import { slugify } from './slugger.js';

// ---- tiny generic helpers (no document/DOM needed) ------------------------

// Escape text that goes inside an element (code blocks, code spans).
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Escape text that goes inside a "double quoted" attribute (href, src, ...).
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
// How many leading spaces a line has (used for list nesting).
function indentOf(s) {
  const m = s.match(/^ */);
  return m ? m[0].length : 0;
}
function isBlank(s) {
  return /^\s*$/.test(s);
}

// Turn HTML entities like &amp; &mdash; into real characters. Used only when
// building a heading slug, so the slug matches the visible text. Uses the
// browser when available; falls back to a small table so this file can also be
// unit-tested in Node.
let _decoder;
function decodeEntities(s) {
  s = String(s);
  if (typeof document !== 'undefined') {
    if (!_decoder) _decoder = document.createElement('textarea');
    _decoder.innerHTML = s;
    return _decoder.value;
  }
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
}

// Pull the plain text out of a heading line so we can build its slug. Removes
// images/links (keeping their text), raw HTML tags, and emphasis/code markers,
// then decodes entities and collapses whitespace. This matches what GitHub
// slugs: the visible text of the heading.
function stripToText(s) {
  let t = String(s);
  // Remove images and links, innermost first, looping until none remain. The
  // [^\[\]]* (no brackets inside) makes each pass match the innermost link, so
  // nested links like [WRONG [VIEW](#view)](#wrong-view) collapse correctly to
  // "WRONG VIEW" -> the heading text GitHub uses for the slug.
  let prev;
  do {
    prev = t;
    t = t.replace(/!\[([^\[\]]*)\]\([^)]*\)/g, '$1'); // image -> alt text
    t = t.replace(/\[([^\[\]]*)\]\([^)]*\)/g, '$1'); // inline link -> text
    t = t.replace(/\[([^\[\]]*)\]\[[^\]]*\]/g, '$1'); // reference link -> text
  } while (t !== prev);
  t = t.replace(/<[^>]+>/g, ''); // strip HTML tags
  t = t.replace(/[*_~`]/g, ''); // strip emphasis / code markers
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

// Split one row of a pipe table into trimmed cell strings. Handles optional
// leading/trailing pipes and escaped \| inside a cell.
function splitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

// If a line is a table's delimiter row (the |---|:--:| line) return an array
// of column alignments; otherwise return null.
function parseDelimiter(line) {
  if (!line.includes('|') && !line.includes('-')) return null;
  const cells = splitRow(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const c of cells) {
    const t = c.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (/^:-+:$/.test(t)) aligns.push('center');
    else if (/-+:$/.test(t)) aligns.push('right');
    else if (/^:-+/.test(t)) aligns.push('left');
    else aligns.push('');
  }
  return aligns;
}
function alignAttr(a) {
  return a ? ` align="${a}"` : '';
}

// The block-level HTML tags that start a raw-HTML block (per CommonMark). A
// line beginning with one of these is passed through verbatim until a blank
// line. Inline tags (a, sup, sub, i, b, span, br, img, ...) are NOT here, so
// lines that start with them go through the normal paragraph path where the
// markdown inside them still renders.
const HTML_BLOCK_TAGS = new RegExp(
  '^ {0,3}<(?:' +
    '/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|' +
    'col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|' +
    'footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|' +
    'link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|' +
    'summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\\s|/?>|$)' +
    '|!--)',
  'i'
);

// True if a line starts a new block, used to know where a paragraph ends.
function isBlockStart(line) {
  return (
    /^ {0,3}#{1,6}\s/.test(line) ||
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(line) ||
    HTML_BLOCK_TAGS.test(line)
  );
}

// A marker we hide raw HTML and code spans behind while running the markdown
// regexes, so those regexes cannot damage their insides (for example an
// underscore inside a URL must not turn into italics). The token uses
// characters that never appear together in normal text or markdown.
const SENTINEL = String.fromCharCode(0xf8ff);
const STASH_RE = new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g');

// ---- Frontmatter ----------------------------------------------------------
// A leading `--- … ---` block renders as a compact metadata table at the top of
// the document, matching the desktop app. The parser is a small, documented YAML
// subset (the same rules the app's indexer uses).

// Drop one surrounding pair of matching quotes.
function stripQuotes(s) {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}
// Split `a, b, c` inside an inline `[ … ]` array into trimmed, unquoted items.
function parseInlineArray(inner) {
  return inner
    .split(',')
    .map((x) => stripQuotes(x.trim()).trim())
    .filter((x) => x !== '');
}
// Return {inner, rest} when `text` opens with a `---` line and a later `---`
// closes it (after an optional BOM); otherwise null. Only the leading block
// counts — a `---` later in the document is a horizontal rule.
function splitLeadingFrontmatter(text) {
  const afterBom = text.replace(/^﻿/, '');
  const firstNl = afterBom.indexOf('\n');
  const firstLineEnd = firstNl < 0 ? afterBom.length : firstNl + 1;
  if (afterBom.slice(0, firstLineEnd).trim() !== '---') return null;
  let offset = firstLineEnd;
  while (offset < afterBom.length) {
    const nl = afterBom.indexOf('\n', offset);
    const lineEnd = nl < 0 ? afterBom.length : nl + 1;
    if (afterBom.slice(offset, lineEnd).trim() === '---') {
      return { inner: afterBom.slice(firstLineEnd, offset), rest: afterBom.slice(lineEnd) };
    }
    offset = lineEnd;
  }
  return null;
}
// Parse the block into {key, value} rows: `key: value` scalars, `key: [a, b]`
// inline arrays (one row per item), and `key:` followed by `- item` block lists
// (one row per item). Keys are lowercased; `#` lines and blanks are ignored.
function parseFrontmatter(inner) {
  const fields = [];
  let listKey = null;
  for (const raw of inner.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      if (listKey !== null) {
        const value = stripQuotes(trimmed === '-' ? '' : trimmed.slice(2).trim()).trim();
        if (value !== '') fields.push({ key: listKey, value });
      }
      continue;
    }
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const key = line.slice(0, ci).trim().toLowerCase();
    if (key === '') continue;
    const value = line.slice(ci + 1).trim();
    if (value === '') {
      listKey = key;
      continue;
    }
    listKey = null;
    if (value.startsWith('[') && value.endsWith(']')) {
      for (const item of parseInlineArray(value.slice(1, -1))) fields.push({ key, value: item });
    } else {
      fields.push({ key, value: stripQuotes(value).trim() });
    }
  }
  return fields;
}
function renderFrontmatterTable(inner) {
  const fields = parseFrontmatter(inner);
  if (!fields.length) return '';
  const rows = fields
    .map((f) => `<tr><th>${esc(f.key)}</th><td>${esc(f.value)}</td></tr>`)
    .join('');
  return `<div class="frontmatter"><table><tbody>${rows}</tbody></table></div>\n`;
}

// ---------------------------------------------------------------------------
// The main entry point.
// ---------------------------------------------------------------------------
export function renderMarkdown(src) {
  let text = String(src).replace(/\r\n?/g, '\n');

  // Pull off a leading frontmatter block (rendered as a table, prepended below).
  let frontmatterHtml = '';
  const frontmatter = splitLeadingFrontmatter(text);
  if (frontmatter) {
    frontmatterHtml = renderFrontmatterTable(frontmatter.inner);
    text = frontmatter.rest;
  }

  // Shared state for this one document:
  const slugOcc = Object.create(null); // heading-slug duplicate counters
  const linkRefs = Object.create(null); // [ref]: url  definitions
  const footnoteDefs = Object.create(null); // [^id]: text  definitions
  const fn = {
    order: [], // footnote ids in the order they are first referenced
    num: Object.create(null), // id -> footnote number
    refs: Object.create(null), // id -> how many times referenced (for back-links)
  };

  const fnSafe = (id) => String(id).toLowerCase().replace(/[^\w-]+/g, '-');

  // --- Pass 1: pull out [ref]: and [^id]: definitions ----------------------
  // We blank out the lines they sat on so the rest of the layout is unchanged.
  const rawLines = text.split('\n');
  const lines = [];
  let inFence = false;
  let fenceCh = '';
  for (let k = 0; k < rawLines.length; k++) {
    const line = rawLines[k];
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fm) {
      if (!inFence) {
        inFence = true;
        fenceCh = fm[1][0];
      } else if (line.trim()[0] === fenceCh) {
        inFence = false;
      }
      lines.push(line);
      continue;
    }
    if (inFence) {
      lines.push(line);
      continue;
    }
    // footnote definition: [^id]: text  (plus indented continuation lines)
    const fd = line.match(/^ {0,3}\[\^([^\]]+)\]:[ \t]?(.*)$/);
    if (fd) {
      let content = fd[2];
      while (
        k + 1 < rawLines.length &&
        (/^\s{2,}\S/.test(rawLines[k + 1]) ||
          (isBlank(rawLines[k + 1]) && /^\s{2,}\S/.test(rawLines[k + 2] || '')))
      ) {
        k++;
        if (!isBlank(rawLines[k])) content += ' ' + rawLines[k].trim();
      }
      footnoteDefs[fd[1]] = content.trim();
      lines.push('');
      continue;
    }
    // link reference definition: [ref]: url "optional title"
    const ld = line.match(
      /^ {0,3}\[([^^\]][^\]]*)\]:\s*<?([^>\s]+)>?(?:\s+["'(]([^"')]*)["')])?\s*$/
    );
    if (ld) {
      linkRefs[ld[1].toLowerCase()] = { url: ld[2], title: ld[3] || '' };
      lines.push('');
      continue;
    }
    lines.push(line);
  }

  // --- Inline renderer -----------------------------------------------------
  // Turns the text inside one block (a paragraph, heading, list item, table
  // cell, ...) into HTML.
  function renderInline(input) {
    if (input == null) return '';
    let s = String(input);
    const stash = [];
    const keep = (html) => SENTINEL + (stash.push(html) - 1) + SENTINEL;

    // Code spans `like this` FIRST: their contents are escaped and stashed, so
    // the later autolink/raw-HTML passes can't turn text like `<details>` into a
    // real element. (CommonMark gives code spans this priority.)
    s = s.replace(/(`+)([\s\S]*?[^`]|[^`])\1(?!`)/g, (_, _ticks, code) =>
      keep('<code>' + esc(code.replace(/^ | $/g, '')) + '</code>')
    );
    // Autolinks <https://...> and <mailto:...> (before we treat <...> as tags).
    s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, (_, url) =>
      keep(`<a href="${escAttr(url)}">${esc(url)}</a>`)
    );
    // HTML comments, then raw HTML tags -> stashed verbatim.
    s = s.replace(/<!--[\s\S]*?-->/g, (m) => keep(m));
    s = s.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*?)?\/?>/g, (m) => keep(m));
    // Images ![alt](src "title").
    s = s.replace(
      /!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["']([^"']*)["'])?\s*\)/g,
      (_, alt, srcUrl, title) =>
        keep(
          `<img src="${escAttr(srcUrl)}" alt="${escAttr(alt)}"` +
            (title ? ` title="${escAttr(title)}"` : '') +
            '>'
        )
    );
    // Footnote markers [^id] -> superscript link (only if defined).
    s = s.replace(/\[\^([^\]]+)\]/g, (m, id) => {
      if (!(id in footnoteDefs)) return m;
      const safe = fnSafe(id);
      if (fn.num[id] === undefined) {
        fn.order.push(id);
        fn.num[id] = fn.order.length;
        fn.refs[id] = 1;
        return keep(
          `<sup class="footnote-ref" id="fnref-${safe}"><a href="#fn-${safe}">${fn.num[id]}</a></sup>`
        );
      }
      fn.refs[id] += 1;
      return keep(
        `<sup class="footnote-ref" id="fnref-${safe}-${fn.refs[id]}"><a href="#fn-${safe}">${fn.num[id]}</a></sup>`
      );
    });
    // Inline links [text](url "title").
    s = s.replace(
      /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["']([^"']*)["'])?\s*\)/g,
      (_, txt, url, title) =>
        keep(
          `<a href="${escAttr(url)}"` +
            (title ? ` title="${escAttr(title)}"` : '') +
            '>' +
            inlineLite(txt) +
            '</a>'
        )
    );
    // Reference links [text][ref] and shortcut [ref].
    s = s.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (m, txt, ref) => {
      const d = linkRefs[(ref || txt).toLowerCase()];
      return d
        ? keep(
            `<a href="${escAttr(d.url)}"` +
              (d.title ? ` title="${escAttr(d.title)}"` : '') +
              '>' +
              inlineLite(txt) +
              '</a>'
          )
        : m;
    });
    s = s.replace(/\[([^\]]+)\]/g, (m, txt) => {
      const d = linkRefs[txt.toLowerCase()];
      return d ? keep(`<a href="${escAttr(d.url)}">${inlineLite(txt)}</a>`) : m;
    });
    // Bare autolinks (URL, www, email) on the remaining plain text. Each result
    // is stashed so the emphasis pass can't touch it. (GitHub refs/mentions/emoji
    // and math are deliberately NOT enabled here — this is prose, and `#123`,
    // `@name`, `$...$` would create hundreds of false matches.)
    s = s.replace(/(^|[^"'(<\w])(https?:\/\/[^\s<>)]+[^\s<>).,;:])/g, (_m, pre, url) =>
      pre + keep(`<a href="${escAttr(url)}">${esc(url)}</a>`)
    );
    s = s.replace(/(^|[^/@.\w])(www\.[^\s<>)]+[^\s<>).,;:])/g, (_m, pre, url) =>
      pre + keep(`<a href="http://${escAttr(url)}">${esc(url)}</a>`)
    );
    s = s.replace(/(^|[^\w.+-])([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g, (_m, pre, mail) =>
      pre + keep(`<a href="mailto:${escAttr(mail)}">${esc(mail)}</a>`)
    );
    // Emphasis. Strong before em; underscore emphasis only at word edges so
    // snake_case_words are left alone.
    s = s.replace(/\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__([^\s](?:[\s\S]*?[^\s])?)__(?=[^\w]|$)/g, '$1<strong>$2</strong>');
    s = s.replace(/\*([^\s*](?:[\s\S]*?[^\s*])?)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^\w])_([^\s_](?:[\s\S]*?[^\s_])?)_(?=[^\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');
    // Hard line breaks: two+ trailing spaces, or a backslash, before a newline.
    s = s.replace(/( {2,}|\\)\n/g, '<br>\n');

    // Put the stashed HTML/code back.
    let prev;
    do {
      prev = s;
      s = s.replace(STASH_RE, (_, k) => stash[+k]);
    } while (s !== prev && STASH_RE.test(s));
    return s;
  }

  // A lighter inline pass for text that sits inside a link (no nested links).
  function inlineLite(t) {
    return String(t)
      .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([\s\S]+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, (_, c) => '<code>' + esc(c) + '</code>');
  }

  // --- Block renderer ------------------------------------------------------
  // Walks the lines and emits block-level HTML. Called recursively for the
  // contents of blockquotes and list items.
  function blocks(lns) {
    const out = [];
    let i = 0;
    const n = lns.length;

    while (i < n) {
      const line = lns[i];
      if (isBlank(line)) {
        i++;
        continue;
      }

      // Fenced code block.
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\n]*)$/);
      if (fence) {
        const ch = fence[1][0];
        const len = fence[1].length;
        const lang = (fence[2] || '').trim().split(/\s+/)[0];
        const close = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
        i++;
        const code = [];
        while (i < n && !close.test(lns[i])) {
          code.push(lns[i]);
          i++;
        }
        if (i < n) i++; // skip closing fence
        out.push(
          '<pre><code' +
            (lang ? ` class="language-${escAttr(lang)}"` : '') +
            '>' +
            esc(code.join('\n')) +
            '\n</code></pre>'
        );
        continue;
      }

      // ATX heading (#, ##, ... up to ######).
      const h = line.match(/^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
      if (h) {
        const level = h[1].length;
        const content = h[2];
        const id = slugify(stripToText(content), slugOcc);
        out.push(`<h${level} id="${id}">${renderInline(content)}</h${level}>`);
        i++;
        continue;
      }

      // Horizontal rule (---, ***, ___).
      if (/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // Blockquote (one or more > lines). Render the inner text recursively.
      if (/^ {0,3}>/.test(line)) {
        const buf = [];
        while (i < n && /^ {0,3}>/.test(lns[i])) {
          buf.push(lns[i].replace(/^ {0,3}> ?/, ''));
          i++;
        }
        // GitHub-style alert: a blockquote whose first line is [!TYPE]. Drop that
        // marker line and tag the blockquote so CSS can style it (title + color).
        const alert = buf.length
          ? buf[0].trim().match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i)
          : null;
        if (alert) {
          const type = alert[1].toLowerCase();
          out.push(
            `<blockquote class="markdown-alert markdown-alert-${type}">\n` +
              blocks(buf.slice(1)) +
              '\n</blockquote>'
          );
        } else {
          out.push('<blockquote>\n' + blocks(buf) + '\n</blockquote>');
        }
        continue;
      }

      // List (ordered or unordered, possibly nested).
      if (/^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(line)) {
        const [html, ni] = consumeList(lns, i, indentOf(line));
        out.push(html);
        i = ni;
        continue;
      }

      // Pipe table: a line with a pipe, followed by a delimiter row.
      if (line.includes('|') && i + 1 < n && parseDelimiter(lns[i + 1])) {
        const header = splitRow(line);
        const aligns = parseDelimiter(lns[i + 1]);
        i += 2;
        const rows = [];
        while (
          i < n &&
          !isBlank(lns[i]) &&
          lns[i].includes('|') &&
          !/^ {0,3}#{1,6}\s/.test(lns[i]) &&
          !/^ {0,3}>/.test(lns[i])
        ) {
          rows.push(splitRow(lns[i]));
          i++;
        }
        out.push(renderTable(header, aligns, rows));
        continue;
      }

      // Raw HTML block (block-level tag) -> passed through verbatim.
      if (HTML_BLOCK_TAGS.test(line)) {
        const buf = [];
        while (i < n && !isBlank(lns[i])) {
          buf.push(lns[i]);
          i++;
        }
        out.push(buf.join('\n'));
        continue;
      }

      // Paragraph: gather lines until a blank line or the start of a new block.
      const para = [line];
      i++;
      while (i < n && !isBlank(lns[i]) && !isBlockStart(lns[i])) {
        para.push(lns[i]);
        i++;
      }
      out.push('<p>' + renderInline(para.join('\n')) + '</p>');
    }

    return out.join('\n');
  }

  function renderTable(header, aligns, rows) {
    const cols = Math.max(header.length, aligns.length);
    const th = [];
    for (let k = 0; k < cols; k++) {
      th.push(`<th${alignAttr(aligns[k])}>${renderInline(header[k] != null ? header[k] : '')}</th>`);
    }
    const body = rows
      .map((r) => {
        let cells = '';
        for (let k = 0; k < cols; k++) {
          cells += `<td${alignAttr(aligns[k])}>${renderInline(r[k] != null ? r[k] : '')}</td>`;
        }
        return '<tr>' + cells + '</tr>';
      })
      .join('\n');
    return `<table>\n<thead>\n<tr>${th.join('')}</tr>\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
  }

  // Consume a list starting at line i whose items are indented `startIndent`
  // spaces. Returns [html, nextLineIndex]. Calls itself for nested lists.
  function consumeList(lns, i, startIndent) {
    const n = lns.length;
    const ordered = /^\d/.test(lns[i].slice(startIndent));
    let html = ordered ? '<ol>\n' : '<ul>\n';

    while (i < n) {
      if (isBlank(lns[i])) {
        // A blank line continues the list only if the next non-blank line is a
        // sibling item at the same indent.
        let j = i + 1;
        while (j < n && isBlank(lns[j])) j++;
        if (
          j < n &&
          indentOf(lns[j]) === startIndent &&
          /^([-*+]|\d{1,9}[.)])(\s|$)/.test(lns[j].slice(startIndent))
        ) {
          i = j;
          continue;
        }
        break;
      }
      const ind = indentOf(lns[i]);
      if (ind !== startIndent) break;
      const rest = lns[i].slice(ind);
      const m =
        rest.match(/^([-*+]|\d{1,9}[.)])\s+(.*)$/) || rest.match(/^([-*+]|\d{1,9}[.)])\s*$/);
      if (!m) break;

      let content = m[2] || '';
      i++;
      let childHtml = '';
      // Gather this item's continuation lines and any deeper nested list.
      while (i < n) {
        if (isBlank(lns[i])) {
          let j = i + 1;
          while (j < n && isBlank(lns[j])) j++;
          if (j < n && indentOf(lns[j]) > startIndent) {
            i++;
            continue;
          }
          break;
        }
        const ci = indentOf(lns[i]);
        if (ci <= startIndent) break;
        if (/^([-*+]|\d{1,9}[.)])(\s|$)/.test(lns[i].slice(ci))) {
          const [nh, ni] = consumeList(lns, i, ci);
          childHtml += nh;
          i = ni;
        } else {
          content += '\n' + lns[i].trim();
          i++;
        }
      }
      html += '<li>' + renderItem(content) + childHtml + '</li>\n';
    }

    html += ordered ? '</ol>' : '</ul>';
    return [html, i];
  }

  function renderItem(content) {
    // Task list item: - [ ] or - [x]
    const t = content.match(/^\[([ xX])\]\s+([\s\S]*)$/);
    if (t) {
      const checked = t[1].toLowerCase() === 'x' ? ' checked' : '';
      return `<input type="checkbox" disabled${checked}> ` + renderInline(t[2].replace(/\n/g, ' '));
    }
    return renderInline(content.replace(/\n/g, ' '));
  }

  // --- Render, then append the footnotes section (if any) ------------------
  let html = blocks(lines);

  if (fn.order.length) {
    const items = fn.order
      .map((id) => {
        const safe = fnSafe(id);
        const body = renderInline(footnoteDefs[id]);
        return `<li id="fn-${safe}"><p>${body} <a href="#fnref-${safe}" class="footnote-back" aria-label="Back to content"><svg class="footnote-back-icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"/></svg></a></p></li>`;
      })
      .join('\n');
    html +=
      '\n<section class="footnotes" aria-label="Footnotes">\n<hr>\n<ol>\n' +
      items +
      '\n</ol>\n</section>';
  }

  return frontmatterHtml + html;
}
