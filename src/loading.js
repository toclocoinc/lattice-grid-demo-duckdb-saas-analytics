/**
 * What the page says while it works.
 *
 * Two pieces, both plain DOM, so the other DuckDB demos can copy this file:
 *
 *   `status`   one line of plain English with a spinner, and a progress bar
 *              when the size is known. It is in the static HTML, so it is on
 *              screen from first paint, and it keeps going through the engine
 *              download, the engine start and the Parquet reads.
 *   `slot`     wraps a panel (KPI strip, chart, grid) in a loading state that
 *              covers it until its first answer, so no panel is ever blank.
 */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** "34 MB", "1.9 MB", "420 KB": sizes as a person says them. */
export const megabytes = (bytes) => {
  if (bytes >= 10 * 1048576) return `${Math.round(bytes / 1048576)} MB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/**
 * The status line. Pass the element already in the HTML, or none to make one.
 *
 * @param {HTMLElement} [existing] a `.load-status` element
 */
export function createStatus(existing) {
  const root = existing ?? el('div', 'load-status');
  root.classList.add('load-status');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  if (!existing) {
    root.append(el('span', 'spinner'), el('p', 'load-text'), el('div', 'load-bar'));
    root.querySelector('.load-bar').append(el('div', 'load-fill'));
  }
  const text = root.querySelector('.load-text');
  const bar = root.querySelector('.load-bar');
  const fill = root.querySelector('.load-fill');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  let frame = 0;
  let pending = null;
  const paint = () => {
    frame = 0;
    const { message, fraction } = pending;
    text.textContent = message;
    bar.hidden = fraction == null;
    if (fraction != null) {
      const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      fill.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
    }
  };
  return {
    el: root,
    /** @param {string} message what is happening @param {number|null} [fraction] 0..1 where the size is known */
    set(message, fraction = null) {
      pending = { message, fraction };
      if (!frame) frame = requestAnimationFrame(paint);
    },
    show() { root.hidden = false; },
    hide() { root.hidden = true; },
  };
}

/**
 * A panel with a loading state over it. `show(text)` covers the panel with a
 * spinner and the text; `hide()` removes the cover. The panel itself is left
 * alone, so a library that fills it can do so underneath.
 *
 * @param {HTMLElement} panel the element the library fills
 * @param {string} text what the cover says at first
 */
export function slot(panel, text) {
  const wrap = el('div', 'slot');
  const cover = el('div', 'panel-loading');
  cover.setAttribute('role', 'status');
  const words = el('p', null, text);
  cover.append(el('span', 'spinner'), words);
  wrap.append(panel, cover);
  return {
    el: wrap,
    show(next) { if (next) words.textContent = next; cover.hidden = false; },
    hide() { cover.hidden = true; },
  };
}
