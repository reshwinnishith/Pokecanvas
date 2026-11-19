// Artwork extension. Two labelled paths:
//  - "AI outpaint (beta)": real outpainting via the Worker's Stable Diffusion
//    1.5 inpainting model. The clean card art is composited onto a larger
//    canvas and only the border is masked for generation, so the artwork
//    itself is pixel-preserved and only the surrounding area is synthesised.
//    Verified by hand: the card's interior comes back unmodified; the
//    generated border matches palette/style well but is not perfectly
//    seamless, hence "beta".
//  - "Manual (Gemini)": the original copy-prompt-and-import workflow, kept
//    as-is for when quota is exhausted or higher quality is wanted.

const WORKER_BASE =
  typeof location !== "undefined" && (location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? "http://localhost:8787"
    : "https://patient-heart-c10a.reshwinnishith.workers.dev";

export async function buildOutpaintAssets(cardImage, { outW = 768, outH = 1056, coverage = 0.68 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");

  ctx.filter = "blur(28px)";
  coverDraw(ctx, cardImage, 0, 0, outW, outH);
  ctx.filter = "none";

  const cardW = Math.round(outW * coverage);
  const cardH = Math.round((cardW * cardImage.height) / cardImage.width);
  const offsetX = Math.round((outW - cardW) / 2);
  const offsetY = Math.round((outH - cardH) / 2);
  ctx.drawImage(cardImage, offsetX, offsetY, cardW, cardH);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = outW;
  maskCanvas.height = outH;
  const mctx = maskCanvas.getContext("2d");
  mctx.fillStyle = "#fff";
  mctx.fillRect(0, 0, outW, outH);
  mctx.filter = "blur(18px)"; // feathered edge: verified to remove the hard "sticker" seam
  mctx.fillStyle = "#000";
  mctx.fillRect(offsetX, offsetY, cardW, cardH);
  mctx.filter = "none";

  const [compositeBlob, maskBlob] = await Promise.all([toBlob(canvas), toBlob(maskCanvas)]);
  return { compositeBlob, maskBlob, offsetX, offsetY, cardW, cardH, outW, outH };
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
  const form = new FormData();
  form.append("image", compositeBlob, "composite.png");
  form.append("mask", maskBlob, "mask.png");
  form.append("prompt", prompt);
  form.append("width", String(outW));
  form.append("height", String(outH));
  form.append("num_steps", "20");
  form.append("guidance", "7.5");
  if (seed != null) form.append("seed", String(seed));

  const res = await fetch(`${WORKER_BASE}/api/extend`, { method: "POST", body: form, signal });
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
