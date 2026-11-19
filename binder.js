// Binder layout, preview and export. Physical card size is 63 x 88 mm; the
// tile pixel size below (756 x 1056) renders at ~305 dpi at that size, which is
// kept unchanged from the original studio since it was already print-accurate.

export const CARD_W = 756;
export const CARD_H = 1056;
export const CARD_MM_W = 63;
export const CARD_MM_H = 88;

export function createBinder(canvas) {
  const ctx = canvas.getContext("2d");
  const state = { art: null, preview: null, layout: 3, slot: 4, guides: true };

  function setLayout(n) {
    state.layout = n;
    state.slot = Math.min(state.slot, n * n - 1);
  }
  function setSlot(i) { state.slot = i; }
  function setGuides(v) { state.guides = v; }
  function setArt(img) { state.art = img; }
  function setPreview(img) { state.preview = img; }
  function getSlot() { return state.slot; }
  function getLayout() { return state.layout; }

  function draw(exporting = false) {
    const n = state.layout;
    const i = state.slot;
    canvas.width = CARD_W * n;
    canvas.height = CARD_H * n;
    canvas.style.setProperty("--print-width", `${CARD_MM_W * n}mm`);
    canvas.style.setProperty("--print-height", `${CARD_MM_H * n}mm`);

    ctx.fillStyle = "#efe6d2";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (state.art) coverDraw(ctx, state.art, 0, 0, canvas.width, canvas.height);
    else {
      ctx.fillStyle = "#31483c";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const x = (i % n) * CARD_W;
    const y = Math.floor(i / n) * CARD_H;
    // The real card sits here physically once printed, so the exported pocket
    // is left blank; the preview-only fill lets you check alignment on screen.
    ctx.fillStyle = exporting ? "#ffffff" : "#d8cdae";
    ctx.fillRect(x, y, CARD_W, CARD_H);
    if (state.preview && !exporting) containDraw(ctx, state.preview, x, y, CARD_W, CARD_H);

    if (state.guides) drawGuides(ctx, n, canvas.width, canvas.height);

    return { printDisabled: n === 4 };
  }

  function exportPng(filename = "pokecanvas.png") {
    draw(true);
    const a = document.createElement("a");
    a.download = filename;
    a.href = canvas.toDataURL("image/png");
    a.click();
    draw(false);
  }

  function printPdf() {
    draw(true);
    window.print();
    draw(false);
  }

  return { setLayout, setSlot, setGuides, setArt, setPreview, getSlot, getLayout, draw, exportPng, printPdf };
}

function coverDraw(ctx, im, x, y, w, h) {
  const s = Math.max(w / im.width, h / im.height);
  const a = w / s;
  const b = h / s;
  ctx.drawImage(im, (im.width - a) / 2, (im.height - b) / 2, a, b, x, y, w, h);
}

// Draws the image with its own aspect ratio, centred in the box (no crop, no stretch).
function containDraw(ctx, im, x, y, w, h) {
  const s = Math.min(w / im.width, h / im.height);
  const dw = im.width * s;
  const dh = im.height * s;
  ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function drawGuides(ctx, n, w, h) {
  ctx.strokeStyle = "#8a8a8a";
  ctx.lineWidth = 3;
  for (let j = 0; j <= n; j++) {
    ctx.beginPath();
    ctx.moveTo(j * CARD_W, 0);
    ctx.lineTo(j * CARD_W, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, j * CARD_H);
    ctx.lineTo(w, j * CARD_H);
    ctx.stroke();
  }
}

export function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not open this image.")); };
    img.src = url;
  });
}

export function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load that image."));
    img.src = url;
  });
}
