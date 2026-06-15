// minimap.js
// ---------------------------------------------------------------------------
// A document minimap for the README reader: a scaled-down picture of the whole
// rendered document pinned to the right edge, with a rectangle showing the part
// you are currently looking at. Click or drag the rail to jump anywhere. It
// replaces the page scrollbar (styles.css hides that).
//
// This is the same idea as the minimap in the Leaf Text desktop app: instead of
// drawing an abstract bar, we clone the actual rendered document and shrink it
// with a CSS transform, so what you see in the rail is a real (tiny) thumbnail
// of the page. The only difference here is that the page scrolls the window,
// not an inner pane, so all the math is against window.scrollY / innerHeight.
//
// Public entry point: initMinimap(source) where `source` is the .markdown-body
// element. Call it once after the README has been rendered into the page.
// ---------------------------------------------------------------------------

// Below this viewport width the rail is hidden (see styles.css) and we skip all
// work. Keep this in sync with the @media rule in styles.css.
const HIDE_BELOW = 720;

// Minimum on-screen height of the viewport rectangle, so it stays grabbable
// even on very long documents. Mirrors the desktop app's 22px floor.
const MIN_VIEWPORT_HEIGHT = 22;

export function initMinimap(source) {
  if (!source) return;

  // Build the rail: a sticky aside holding a track, a (scaled) content clone,
  // and the viewport rectangle. aria-hidden throughout — it is a pointer
  // convenience that duplicates the scrollbar, not new content for a reader.
  const minimap = document.createElement('aside');
  minimap.className = 'document-minimap';
  minimap.setAttribute('aria-hidden', 'true');
  minimap.innerHTML =
    '<div class="document-minimap-track">' +
    '<div class="document-minimap-content"></div>' +
    '<div class="document-minimap-viewport"></div>' +
    '</div>';
  document.body.appendChild(minimap);

  const track = minimap.querySelector('.document-minimap-track');
  const content = minimap.querySelector('.document-minimap-content');
  const viewport = minimap.querySelector('.document-minimap-viewport');

  let pointerId = null;
  let pointerOffsetY = null; // grab offset inside the viewport rect, or null for a click-jump
  let previewFrame = 0;
  let viewportFrame = 0;

  const isHidden = () => window.innerWidth < HIDE_BELOW;
  const scrollEl = document.scrollingElement || document.documentElement;

  // ---- measurements -------------------------------------------------------
  // Everything the renderers below need, gathered in one place so a single
  // layout read drives both the preview scale and the viewport rectangle.
  function measure() {
    const rect = source.getBoundingClientRect();
    const sourceWidth = Math.max(1, Math.ceil(rect.width));
    const contentWidth = Math.max(1, content.clientWidth);
    const scrollHeight = Math.max(1, Math.ceil(scrollEl.scrollHeight));
    const viewportHeight = Math.max(1, Math.ceil(window.innerHeight));
    const scrollable = Math.max(0, scrollHeight - viewportHeight);
    const rawScroll = window.scrollY || scrollEl.scrollTop || 0;
    const scrollTop = Math.min(scrollable, Math.max(0, rawScroll));
    // Where the document's content actually begins, INCLUDING the blank space the
    // page leaves above it. The thumbnail starts here too, so it's a faithful
    // picture of the top — the box's "0" (document top) lines up with the rail.
    const sourceTop = Math.max(0, Math.round(rect.top + rawScroll));
    // Fit the thumbnail to the rail's width (real proportions, never stretched).
    const previewScale = contentWidth / sourceWidth;
    const scaledDocHeight = Math.max(1, scrollHeight * previewScale);
    // Size the rail to the thumbnail, capped at the viewport — the key fix. A
    // short document gets a short rail (no dead space below it, so the box can't
    // be stranded near the top); a long one fills the screen and the thumbnail
    // scrolls inside it the way a code-editor minimap does.
    const trackHeight = Math.max(1, Math.min(viewportHeight, scaledDocHeight));
    return {
      sourceWidth, contentWidth, trackHeight, scrollHeight, viewportHeight,
      scrollable, scrollTop, sourceTop, previewScale, scaledDocHeight,
    };
  }

  // ---- the thumbnail ------------------------------------------------------
  // Clone the live document, strip ids/links (so nothing is focusable or
  // duplicated for assistive tech), and shrink it to the rail width with a
  // transform. Rebuilt whenever the document reflows (images decoding, resize).
  function buildPreview() {
    previewFrame = 0;
    if (isHidden()) return;
    const m = measure();
    const preview = source.cloneNode(true);
    preview.removeAttribute('id');
    preview.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    preview.querySelectorAll('a[href]').forEach((link) => link.removeAttribute('href'));
    preview.classList.add('document-minimap-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.style.width = `${m.sourceWidth}px`;
    // Scale to the rail width, then nudge down by the document's top gap so the
    // thumbnail sits where the real content sits.
    preview.style.transform = `translateY(${m.sourceTop * m.previewScale}px) scale(${m.previewScale})`;
    content.style.height = `${m.scaledDocHeight}px`;
    track.style.height = `${m.trackHeight}px`;
    content.replaceChildren(preview);
    updateViewport();
  }

  // ---- the viewport rectangle --------------------------------------------
  // Place the rectangle (and slide the thumbnail) to reflect the current
  // scroll position. When the thumbnail is taller than the rail it scrolls
  // inside the rail, the way a code-editor minimap does on long files.
  function updateViewport() {
    viewportFrame = 0;
    if (isHidden()) return;
    const m = measure();
    const scaledDocHeight = m.scaledDocHeight;
    content.style.height = `${scaledDocHeight}px`;
    track.style.height = `${m.trackHeight}px`;

    const scrollRatio = m.scrollable === 0 ? 0 : Math.min(1, Math.max(0, m.scrollTop / m.scrollable));
    const rawViewportHeight = Math.max(MIN_VIEWPORT_HEIGHT, m.viewportHeight * m.previewScale);
    const boundedViewportHeight = Math.min(m.trackHeight, rawViewportHeight);
    const previewTop = -scrollRatio * Math.max(0, scaledDocHeight - m.trackHeight);
    const viewportDocumentTop = m.scrollTop * m.previewScale;
    const viewportTop = Math.min(
      Math.max(0, m.trackHeight - boundedViewportHeight),
      Math.max(0, previewTop + viewportDocumentTop)
    );

    content.style.top = `${previewTop}px`;
    viewport.style.top = `${viewportTop}px`;
    viewport.style.height = `${boundedViewportHeight}px`;
  }

  function scheduleBuild() {
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(buildPreview);
  }
  function scheduleViewport() {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(updateViewport);
  }

  // ---- pointer: click to jump, drag to scrub ------------------------------
  function scrollWindowTo(top) {
    const m = measure();
    window.scrollTo(0, Math.min(m.scrollable, Math.max(0, top)));
  }

  // A click on empty rail centers the viewport on the clicked document point.
  function jumpToPoint(event) {
    const m = measure();
    const contentRect = content.getBoundingClientRect();
    if (m.previewScale <= 0 || contentRect.height <= 0) return;
    const clickedDocumentY = (event.clientY - contentRect.top) / m.previewScale;
    scrollWindowTo(clickedDocumentY - m.viewportHeight / 2);
  }

  // Dragging the viewport rectangle keeps the grab point under the cursor and
  // converts the rectangle's new position back into a window scroll offset.
  // This is the inverse of updateViewport()'s placement math.
  function dragToPointer(event, offsetY) {
    const m = measure();
    const trackRect = track.getBoundingClientRect();
    if (trackRect.height <= 0 || m.scrollable <= 0) return;
    const scaledDocHeight = Math.max(1, m.scrollHeight * m.previewScale);
    const rawViewportHeight = Math.max(MIN_VIEWPORT_HEIGHT, m.viewportHeight * m.previewScale);
    const boundedViewportHeight = Math.min(m.trackHeight, rawViewportHeight);
    const handleRange = Math.max(0, m.trackHeight - boundedViewportHeight);
    const grab = Number.isFinite(offsetY) ? offsetY : boundedViewportHeight / 2;
    const targetViewportTop = Math.min(handleRange, Math.max(0, event.clientY - trackRect.top - grab));
    const previewTravel = Math.max(0, scaledDocHeight - m.trackHeight);
    const viewportTopPerScrollPixel = m.previewScale - previewTravel / m.scrollable;
    const targetScroll = viewportTopPerScrollPixel > 0
      ? targetViewportTop / viewportTopPerScrollPixel
      : (handleRange <= 0 ? 0 : (targetViewportTop / handleRange) * m.scrollable);
    scrollWindowTo(targetScroll);
  }

  // Returns the grab offset if the press landed on the viewport rectangle, else
  // null to signal a click-jump.
  function pressOffset(event) {
    const rect = viewport.getBoundingClientRect();
    if (event.clientY < rect.top || event.clientY > rect.bottom) return null;
    return event.clientY - rect.top;
  }

  track.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    pointerOffsetY = pressOffset(event);
    track.setPointerCapture(event.pointerId);
    if (Number.isFinite(pointerOffsetY)) {
      dragToPointer(event, pointerOffsetY);
    } else {
      jumpToPoint(event);
    }
  });
  track.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    dragToPointer(event, pointerOffsetY);
  });
  const endDrag = (event) => {
    if (event.pointerId === pointerId) {
      pointerId = null;
      pointerOffsetY = null;
    }
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('lostpointercapture', endDrag);

  // ---- keep it in sync ----------------------------------------------------
  window.addEventListener('scroll', scheduleViewport, { passive: true });
  window.addEventListener('resize', () => {
    scheduleBuild();
    scheduleViewport();
  });

  // Rebuild when the document changes height: images decoding, fonts loading,
  // Mermaid/etc. The README is static, but images still arrive a few frames
  // after the HTML is in, which would otherwise leave the thumbnail stale.
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      scheduleBuild();
      scheduleViewport();
    }).observe(source);
  }
  source.querySelectorAll('img').forEach((image) => {
    if (image.complete) return;
    image.addEventListener('load', scheduleBuild, { once: true });
    image.addEventListener('error', scheduleBuild, { once: true });
  });

  buildPreview();
}
