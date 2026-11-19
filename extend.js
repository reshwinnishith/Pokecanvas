// Artwork extension. Two labelled paths:
//  - "AI outpaint (beta)": real outpainting via the Worker's Stable Diffusion
//    1.5 inpainting model. The clean card art is composited onto a larger
//    canvas and only the area outside the card is masked for generation. The
//    model re-encodes the whole image, so the original card is pasted back over
//    the result afterwards (restoreOriginalCard). The generated area matches
//    palette/style but is not guaranteed seamless, hence "beta".
//  - "Manual (Gemini)": the original copy-prompt-and-import workflow, kept
//    as-is for when quota is exhausted or higher quality is wanted.

import { CARD_W, CARD_H } from "./binder.js";

const WORKER_BASE =
  typeof location !== "undefined" && (location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? "http://localhost:8787"
    : "https://patient-heart-c10a.reshwinnishith.workers.dev";

const PASS_KEY = "pokecanvas.studioPassphrase";

// The passphrase lives in sessionStorage only (cleared when the tab closes or on Lock).
export function getPassphrase() {
  try { return sessionStorage.getItem(PASS_KEY) || ""; } catch { return ""; }
}
export function clearPassphrase() {
  try { sessionStorage.removeItem(PASS_KEY); } catch { /* storage unavailable */ }
}
function savePassphrase(p) {
  try { sessionStorage.setItem(PASS_KEY, p); return true; } catch { return false; }
}

// Checks the passphrase against the Worker (this never starts an AI generation)
// and remembers it for this browser tab only if it is correct.
export async function unlockStudio(passphrase) {
  let res;
  try {
    res = await fetch(`${WORKER_BASE}/api/auth`, { method: "POST", headers: { Authorization: `Bearer ${passphrase}` } });
  } catch {
    throw Object.assign(new Error("Could not reach the AI service. Check your connection."), { code: "network" });
  }
  if (res.ok) {
    if (!savePassphrase(passphrase)) {
      throw Object.assign(new Error("This browser blocked session storage, so the passphrase can't be kept for this tab."), { code: "storage" });
    }
    return true;
  }
  const body = await res.json().catch(() => ({}));
  throw Object.assign(new Error(body.error || "Could not unlock."), { code: body.code || "unauthorized", status: res.status });
}

// Builds the generation canvas so it has exactly the binder's proportions and the
// original card sits in its own pocket cell. Everything outside that cell is masked
// for generation, so the neighbouring pockets get artwork and the card is never
// repeated or stretched: it is drawn with its own aspect ratio, contained in the cell.
export async function buildOutpaintAssets(cardImage, { n = 3, slot = 4, outW = 768 } = {}) {
  const outH = Math.floor((outW * CARD_H) / CARD_W / 8) * 8; // model sizes are multiples of 8
  const cellW = outW / n;
  const cellH = outH / n;
  const col = slot % n;
  const row = Math.floor(slot / n);

  // Contain the card inside its cell without distortion.
  const scale = Math.min(cellW / cardImage.width, cellH / cardImage.height);
  const cardW = Math.round(cardImage.width * scale);
  const cardH = Math.round(cardImage.height * scale);
  const offsetX = Math.round(col * cellW + (cellW - cardW) / 2);
  const offsetY = Math.round(row * cellH + (cellH - cardH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.filter = "blur(28px)";
  coverDraw(ctx, cardImage, 0, 0, outW, outH); // colour seed for the generated area only
  ctx.filter = "none";
  ctx.drawImage(cardImage, offsetX, offsetY, cardW, cardH);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = outW;
  maskCanvas.height = outH;
  const mctx = maskCanvas.getContext("2d");
  mctx.fillStyle = "#fff"; // white = generate
  mctx.fillRect(0, 0, outW, outH);
  mctx.filter = "blur(3px)"; // slight feather at the card edge only
  mctx.fillStyle = "#000"; // black = keep
  mctx.fillRect(offsetX, offsetY, cardW, cardH);
  mctx.filter = "none";

  const [compositeBlob, maskBlob] = await Promise.all([toBlob(canvas), toBlob(maskCanvas)]);
  return { compositeBlob, maskBlob, offsetX, offsetY, cardW, cardH, outW, outH, n, slot };
}

// Stable Diffusion inpainting re-encodes the whole image, so even the unmasked
// card interior comes back slightly altered (card text gets garbled). Paste the
// original card pixels back over the model output so the artwork is exactly
// preserved and only the generated border is kept.
export function restoreOriginalCard(resultImage, cardImage, { offsetX, offsetY, cardW, cardH, outW, outH }) {
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(resultImage, 0, 0, outW, outH);
  ctx.drawImage(cardImage, offsetX, offsetY, cardW, cardH);
  return canvas;
}

export async function requestOutpaint({ compositeBlob, maskBlob, prompt, outW, outH, seed, signal }) {
  const passphrase = getPassphrase();
  if (!passphrase) throw Object.assign(new Error("Unlock the studio with your passphrase first."), { code: "locked" });
  const form = new FormData();
  form.append("image", compositeBlob, "composite.png");
  form.append("mask", maskBlob, "mask.png");
  form.append("prompt", prompt);
  form.append("width", String(outW));
  form.append("height", String(outH));
  form.append("num_steps", "20");
  form.append("guidance", "7.5");
  if (seed != null) form.append("seed", String(seed));

  const res = await fetch(`${WORKER_BASE}/api/extend`, {
    method: "POST",
    body: form,
    signal,
    headers: { Authorization: `Bearer ${passphrase}` },
  });
  if (!res.ok) {
    let message = "Generation failed. Please try again.";
    let code = "generation_failed";
    try {
      const body = await res.json();
      message = body.error || message;
      code = body.code || code;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(message);
    err.code = code;
    err.status = res.status;
    if (res.status === 401) clearPassphrase();
    throw err;
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function buildGeminiPrompt({ n, i, direction }) {
  return (
    "Create one continuous portrait artwork with aspect ratio 63:88 for a " + n + " by " + n +
    " trading card binder. The uploaded card occupies row " + (Math.floor(i / n) + 1) +
    ", column " + ((i % n) + 1) +
    ". Extend its background seamlessly across the entire canvas. Keep the original composition aligned to that pocket. " +
    direction
  );
}

function coverDraw(ctx, im, x, y, w, h) {
  const s = Math.max(w / im.width, h / im.height);
  const a = w / s;
  const b = h / s;
  ctx.drawImage(im, (im.width - a) / 2, (im.height - b) / 2, a, b, x, y, w, h);
}

function toBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
