export type MessageLayout = "fit" | "original";
export interface MessageDisplay { layout: MessageLayout; zoom: number }

export interface FrameSize { width: number; viewportWidth: number }
export interface EmailFrameLayout { update: (display: MessageDisplay) => void; dispose: () => void }

const FIT_STYLE = `
  body{width:auto!important;min-width:0!important;max-width:100%!important;word-break:break-word;overflow-wrap:anywhere;}
  *{min-width:0!important;max-width:100%!important;box-sizing:border-box;}
  img{max-width:100%;height:auto;}
  table{max-width:100%;table-layout:auto!important;}
  td,th{white-space:normal!important;word-break:normal;overflow-wrap:normal;}
  a{overflow-wrap:anywhere;}
  [style*="white-space"][style*="nowrap"]{white-space:normal!important;}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;}
`;

/** Size a script-free message document without giving it a vertical scrollport.
 * Wide documents pan in the enclosing viewport; zoom never reloads the email. */
export function bindEmailFrameLayout(
  frame: HTMLIFrameElement,
  viewport: HTMLElement,
  initial: MessageDisplay,
  onSize: (size: FrameSize) => void,
): EmailFrameLayout {
  const doc = frame.contentDocument;
  if (!doc?.body) return { update: () => {}, dispose: () => {} };
  const body = doc.body;
  const rules = doc.createElement("style");
  rules.dataset.bhargaLayout = "true";
  doc.head.appendChild(rules);
  body.style.setProperty("height", "auto", "important");
  body.style.setProperty("min-height", "0", "important");
  body.style.setProperty("display", "flow-root", "important");
  let display = initial;
  let active = true;
  let pending: number | null = null;

  const measure = () => {
    if (!active || frame.contentDocument !== doc) return;
    const previousLeft = viewport.scrollLeft;
    const scale = display.zoom / 100;
    const available = viewport.clientWidth || frame.clientWidth;
    body.style.setProperty("--bharga-message-padding", `${Math.max(12, Math.min(24, available * 0.04))}px`);
    const frameStyle = getComputedStyle(frame);
    const border = (parseFloat(frameStyle.borderLeftWidth) || 0) + (parseFloat(frameStyle.borderRightWidth) || 0);
    const verticalBorder = (parseFloat(frameStyle.borderTopWidth) || 0) + (parseFloat(frameStyle.borderBottomWidth) || 0);
    if (available > 0) frame.style.width = `${available}px`;
    const bodyStyle = doc.defaultView?.getComputedStyle(body);
    const rightPadding = parseFloat(bodyStyle?.paddingRight ?? "0") || 0;
    const bottomPadding = parseFloat(bodyStyle?.paddingBottom ?? "0") || 0;
    const range = doc.createRange();
    range.selectNodeContents(body);
    const bounds = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    const width = Math.max(available, Math.ceil(Math.max(body.scrollWidth * scale, (bounds?.right ?? 0) + rightPadding * scale) + border));
    if (available > 0) frame.style.width = `${width}px`;
    const finalBounds = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    const height = Math.ceil(Math.max(
      body.scrollHeight * scale,
      body.offsetHeight * scale,
      body.getBoundingClientRect().height,
      (finalBounds?.bottom ?? 0) + bottomPadding * scale,
    ) + verticalBorder);
    if (height > verticalBorder && frame.style.height !== `${height}px`) frame.style.height = `${height}px`;
    viewport.scrollLeft = previousLeft;
    onSize({ width: available > 0 ? width : 0, viewportWidth: available });
  };

  const schedule = () => {
    if (!active || pending !== null) return;
    // The observed body lives in a different document from the resized frame.
    // Leave the current rendering pass before changing its ancestor's size.
    pending = window.setTimeout(() => { pending = null; measure(); }, 0);
  };
  // Do not force layout reads inside an observer callback: the body and its
  // ancestor viewport belong to different documents and rendering passes.
  const bodyObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  bodyObserver?.observe(body);
  let viewportWidth = viewport.clientWidth;
  const viewportObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    const entry = entries.find((item) => item.target === viewport);
    if (!entry) return;
    const nextWidth = Math.round(entry.contentRect.width);
    if (nextWidth !== viewportWidth) { viewportWidth = nextWidth; schedule(); }
  });
  viewportObserver?.observe(viewport);
  const images = [...doc.querySelectorAll("img")];
  images.forEach((image) => { image.addEventListener("load", schedule); image.addEventListener("error", schedule); });
  void doc.fonts?.ready.then(schedule);

  const update = (next: MessageDisplay) => {
    if (!active) return;
    const pan = next.layout === display.layout ? viewport.scrollLeft * next.zoom / display.zoom : 0;
    display = next;
    rules.textContent = next.layout === "fit" ? FIT_STYLE : "";
    body.style.setProperty("zoom", String(next.zoom / 100));
    measure();
    viewport.scrollLeft = next.layout === "fit" ? 0 : pan;
  };
  update(initial);
  return {
    update,
    dispose: () => {
      active = false;
      if (pending !== null) window.clearTimeout(pending);
      bodyObserver?.disconnect();
      viewportObserver?.disconnect();
      images.forEach((image) => { image.removeEventListener("load", schedule); image.removeEventListener("error", schedule); });
      rules.remove();
    },
  };
}
