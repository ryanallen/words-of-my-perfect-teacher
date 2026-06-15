// reader.js
// ---------------------------------------------------------------------------
// The glue: fetch ./README.md (the file sitting next to this page), turn it
// into HTML with our renderer, put it on the page, set the browser tab title,
// and jump to any #anchor that is in the URL.
//
// This file is intentionally short. The interesting work is in markdown.js
// (rendering) and styles.css (the look).
// ---------------------------------------------------------------------------

import { renderMarkdown } from './markdown.js';
import { initMinimap } from './minimap.js';

const content = document.getElementById('content');
const statusEl = document.getElementById('status');

function showStatus(message) {
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.hidden = false;
  }
}

// Jump to the heading/element named in the URL (e.g. .../#lama). We do this
// ourselves because the content is added after the page loads, so the browser's
// own jump may have happened too early.
function scrollToHash() {
  if (!location.hash) return;
  const raw = location.hash.slice(1);
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch (e) {
    id = raw;
  }
  const target = document.getElementById(id) || document.getElementById(raw);
  if (target) target.scrollIntoView();
}

async function main() {
  try {
    const res = await fetch('./README.md', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching README.md');
    const markdown = await res.text();

    content.innerHTML = renderMarkdown(markdown);
    if (statusEl) statusEl.hidden = true;

    // Use the first heading as the tab title, if there is one.
    const firstHeading = content.querySelector('h1, h2, h3');
    if (firstHeading) {
      const title = firstHeading.textContent.trim();
      if (title) document.title = title.slice(0, 80);
    }

    // Build the side-rail minimap from the rendered document, then jump to any
    // #anchor. (Minimap first so its viewport rectangle is correct on landing.)
    initMinimap(content);
    scrollToHash();
  } catch (err) {
    showStatus(
      'Could not load README.md (' +
        err.message +
        '). This page must be served over http, not opened from a file path. ' +
        'For example, in this folder run:  python -m http.server  then open the printed address.'
    );
  }
}

// Note: we deliberately do NOT re-scroll on every `hashchange`. The browser
// already scrolls to the anchor when you click an in-page link, and on
// back/forward it restores your previous scroll position. A hashchange handler
// would override that restoration and snap you back to the heading instead of
// where you had scrolled to.

main();
