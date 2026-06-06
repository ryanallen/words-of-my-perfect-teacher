// slugger.js
// ---------------------------------------------------------------------------
// Turns a heading's plain text into the SAME id ("slug") that GitHub uses, so
// in-page links like [text](#some-heading) land on the right heading.
//
// This README has thousands of these in-page links. If our slugs do not match
// GitHub's exactly, those links break. So this file copies GitHub's rule:
//
//   1. lowercase the text
//   2. drop every character that is not a letter, number, mark, underscore,
//      hyphen, or space. So "1.2.1 Taking by Force" -> "121-taking-by-force"
//      (the dots go away), but accented letters like in "Śākyamuni" are kept
//      and become "śākyamuni".
//   3. turn each space into a hyphen
//   4. if the same slug appears again later, add -1, -2, ... so every id is
//      unique (GitHub does this too).
//
// Pulling the plain text OUT of a heading (removing HTML tags and markdown
// such as **bold** or [links](...)) happens in markdown.js before it calls
// here. This file only deals with already-plain text.
// ---------------------------------------------------------------------------

// Characters we KEEP. Everything not in this set is removed in step 2:
//   \p{L}  any letter, including accented ones (ś, ā, ṇ, ü, ...)
//   \p{M}  combining marks (accents stored separately from their letter)
//   \p{Nd} decimal digits 0-9 (and other scripts' digits)
//   \p{Pc} connector punctuation, which is basically the underscore
//   - and space, which we handle in steps 2-3
const DROP_CHARS = /[^\p{L}\p{M}\p{Nd}\p{Pc}\- ]/gu;

/**
 * Make a GitHub-style slug from plain text.
 *
 * @param {string} text  the heading's plain text (no HTML, no markdown)
 * @param {Object} seen  a shared bookkeeping object. Pass the SAME object for
 *                       every heading in one document so duplicate ids get
 *                       -1, -2, ... suffixes. Start it as {} (or
 *                       Object.create(null)).
 * @returns {string} the unique slug/id for this heading
 */
export function slugify(text, seen) {
  // Steps 1-3: lowercase, drop unwanted characters, spaces become hyphens.
  const base = String(text)
    .trim()
    .toLowerCase()
    .replace(DROP_CHARS, '')
    .replace(/ /g, '-');

  // Step 4: make it unique. This mirrors GitHub's "github-slugger" exactly:
  // the first time we see a slug we use it as-is; each later repeat gets the
  // next number appended.
  let result = base;
  while (Object.prototype.hasOwnProperty.call(seen, result)) {
    seen[base] = (seen[base] || 0) + 1;
    result = base + '-' + seen[base];
  }
  seen[result] = 0;
  return result;
}
