import { recognizeCard } from "./ocr.js";
import { searchCandidates, fetchCardDetail, cardImageUrl } from "./identify.js";
import { createBinder, loadImageFromFile, loadImageFromUrl } from "./binder.js";
import { buildOutpaintAssets, requestOutpaint, restoreOriginalCard, buildGeminiPrompt } from "./extend.js";

const $ = (id) => document.getElementById(id);

const photoInput = $("photo");
const photoThumb = $("photoThumb");
const ocrStatus = $("ocrStatus");
const ocrProgressWrap = $("ocrProgressWrap");
const ocrProgressBar = $("ocrProgressBar");
const candidatePanel = $("candidatePanel");
const candidateList = $("candidateList");
const noMatch = $("noMatch");
const manualName = $("manualName");
const manualNumber = $("manualNumber");
const manualLang = $("manualLang");
const manualSearch = $("manualSearch");

const cleanThumb = $("cleanThumb");
const cleanStatus = $("cleanStatus");

const aiExtendBtn = $("aiExtend");
const aiProgressWrap = $("aiProgressWrap");
const aiProgressBar = $("aiProgressBar");
const aiStatus = $("aiStatus");
const aiResultRow = $("aiResultRow");
const regenerateBtn = $("regenerate");

const promptInput = $("prompt");
const copyBtn = $("copy");
const artInput = $("art");

const layoutSelect = $("layout");
const slotSelect = $("slot");
const guidesCheck = $("guides");
const saveBtn = $("save");
const printBtn = $("print");
const statusEl = $("status");

const canvas = $("preview");
const binder = createBinder(canvas);

const studio = {
  cleanImage: null, // clean, identified card artwork (Image element)
  lastSeed: null,
};

function setStatus(el, message, tone) {
  el.textContent = message || "";
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function refreshSlots() {
  const n = Number(layoutSelect.value);
  const current = binder.getSlot();
  slotSelect.replaceChildren(
    ...Array.from({ length: n * n }, (_, idx) => new Option(`Pocket ${idx + 1}`, idx))
  );
  const keep = Math.min(current, n * n - 1);
  slotSelect.value = String(keep >= 0 ? keep : Math.floor((n * n) / 2));
  binder.setLayout(n);
  binder.setSlot(Number(slotSelect.value));
  redraw();
}

function redraw() {
  const { printDisabled } = binder.draw();
  printBtn.disabled = printDisabled;
}

layoutSelect.addEventListener("change", refreshSlots);
slotSelect.addEventListener("change", () => { binder.setSlot(Number(slotSelect.value)); redraw(); });
guidesCheck.addEventListener("change", () => { binder.setGuides(guidesCheck.checked); redraw(); });

saveBtn.addEventListener("click", () => {
  binder.exportPng();
  setStatus(statusEl, "Exported pokecanvas.png.", "ok");
});
printBtn.addEventListener("click", () => binder.printPdf());

copyBtn.addEventListener("click", async () => {
  const n = binder.getLayout();
  const i = binder.getSlot();
  const text = buildGeminiPrompt({ n, i, direction: promptInput.value });
  try {
    await navigator.clipboard.writeText(text);
    setStatus(statusEl, "Prompt copied. Paste it into Gemini along with your card photo.", "ok");
  } catch {
    setStatus(statusEl, text, null);
  }
});

artInput.addEventListener("change", async () => {
  const file = artInput.files[0];
  if (!file) return;
  try {
    const img = await loadImageFromFile(file);
    binder.setArt(img);
    aiResultRow.hidden = true;
    redraw();
    setStatus(statusEl, "Manual artwork imported.", "ok");
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

// ---- Step 1: photograph + identify -----------------------------------

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) return;
  photoThumb.hidden = false;
  photoThumb.src = URL.createObjectURL(file);
  binder.setPreview(await safeLoad(file));
  redraw();

  candidatePanel.hidden = true;
  noMatch.hidden = true;
  candidateList.replaceChildren();

  ocrProgressWrap.hidden = false;
  setStatus(ocrStatus, "Reading the card...", "busy");
  ocrProgressBar.style.width = "4%";

  try {
    const result = await recognizeCard(file, {
      onProgress: (stage, progress) => {
        ocrProgressBar.style.width = `${Math.round(progress * 100)}%`;
        if (stage === "recognizing text") setStatus(ocrStatus, "Recognising text...", "busy");
      },
    });
    ocrProgressWrap.hidden = true;

    if (!result.nameGuess) {
      setStatus(ocrStatus, "Couldn't read the card clearly. Try a closer, well-lit photo, or search manually below.", "error");
      noMatch.hidden = false;
      return;
    }

    manualName.value = result.nameGuess;
    if (result.number) manualNumber.value = `${result.number}/${result.total || "?"}`;
    manualLang.value = result.japanese ? "ja" : "en";

    setStatus(ocrStatus, `Read "${result.nameGuess}"${result.number ? ` · No. ${result.number}` : ""}. Matching against the card database...`, "busy");
    await runSearch({ name: result.nameGuess, number: result.number, total: result.total, japanese: result.japanese });
  } catch (err) {
    ocrProgressWrap.hidden = true;
    setStatus(ocrStatus, err.message, "error");
    noMatch.hidden = false;
  }
});

async function safeLoad(file) {
  try { return await loadImageFromFile(file); } catch { return null; }
}

manualSearch.addEventListener("click", async () => {
  const name = manualName.value.trim();
  if (!name) { setStatus(ocrStatus, "Enter a card name to search.", "error"); return; }
  const raw = manualNumber.value.trim();
  const [number, total] = raw.includes("/") ? raw.split("/").map((s) => s.trim()) : [raw || null, null];
  setStatus(ocrStatus, "Searching the card database...", "busy");
  await runSearch({ name, number: number || null, total: total || null, japanese: manualLang.value === "ja" });
});

async function runSearch(query) {
  try {
    const { lang, candidates } = await searchCandidates(query);
    if (!candidates.length) {
      setStatus(ocrStatus, "No matching card with artwork was found. Adjust the name/number above and search again.", "error");
      noMatch.hidden = false;
      candidatePanel.hidden = true;
      return;
    }
    noMatch.hidden = true;
    renderCandidates(lang, candidates);
    setStatus(
      ocrStatus,
      candidates.length === 1
        ? "Found a match. Confirm below."
        : `Found ${candidates.length} possible matches -- pick the right one.`,
      "ok"
    );
  } catch (err) {
    setStatus(ocrStatus, `Card lookup failed: ${err.message}`, "error");
  }
}

function renderCandidates(lang, candidates) {
  candidatePanel.hidden = false;
  candidateList.replaceChildren();
  for (const card of candidates) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "candidate";
    btn.innerHTML = `
      <img src="${cardImageUrl(card, "low", "webp")}" alt="">
      <span class="meta"><strong>${escapeHtml(card.name)}</strong>
      <span>${escapeHtml(card._setName || card.id)} · No. ${escapeHtml(String(card.localId))}</span></span>
    `;
    btn.addEventListener("click", () => selectCard(lang, card, btn));
    li.appendChild(btn);
    candidateList.appendChild(li);
  }
  if (candidates.length === 1) {
    const only = candidateList.querySelector(".candidate");
    if (only) only.click();
  }
}

async function selectCard(lang, card, btnEl) {
  for (const el of candidateList.querySelectorAll(".candidate")) el.classList.remove("selected");
  if (btnEl) btnEl.classList.add("selected");

  setStatus(cleanStatus, "Fetching clean artwork...", "busy");
  cleanThumb.hidden = true;
  try {
    const detail = await fetchCardDetail(lang, card.id).catch(() => card);
    const url = cardImageUrl(detail.image ? detail : card, "high", "png");
    const img = await loadImageFromUrl(url);
    studio.cleanImage = img;
    cleanThumb.src = url;
    cleanThumb.hidden = false;
    binder.setPreview(img);
    redraw();
    setStatus(cleanStatus, `Using ${detail.name || card.name} (${detail._setName || card._setName || card.id}). Never substituted -- this is the exact card matched above.`, "ok");
    aiExtendBtn.disabled = false;
  } catch (err) {
    setStatus(cleanStatus, `Could not load the card image: ${err.message}`, "error");
    aiExtendBtn.disabled = true;
  }
}

// ---- Step 3: AI outpaint (beta) ---------------------------------------

aiExtendBtn.disabled = true;

async function runOutpaint(seed) {
  if (!studio.cleanImage) {
    setStatus(aiStatus, "Identify a card first.", "error");
    return;
  }
  aiExtendBtn.disabled = true;
  regenerateBtn.disabled = true;
  aiResultRow.hidden = true;
  aiProgressWrap.hidden = false;
  aiProgressBar.style.width = "10%";
  setStatus(aiStatus, "Composing the extended canvas...", "busy");

  let ticker;
  try {
    const assets = await buildOutpaintAssets(studio.cleanImage, { outW: 768, outH: 1056 });
    setStatus(aiStatus, "Generating with Workers AI (Stable Diffusion inpainting)... this can take up to a minute.", "busy");

    let pct = 15;
    ticker = setInterval(() => {
      pct = Math.min(90, pct + 3);
      aiProgressBar.style.width = `${pct}%`;
    }, 1500);

    const url = await requestOutpaint({
      compositeBlob: assets.compositeBlob,
      maskBlob: assets.maskBlob,
      prompt: promptInput.value,
      outW: assets.outW,
      outH: assets.outH,
      seed,
    });
    clearInterval(ticker);
    aiProgressBar.style.width = "100%";

    const img = await loadImageFromUrl(url);
    binder.setArt(restoreOriginalCard(img, studio.cleanImage, assets));
    redraw();
    aiResultRow.hidden = false;
    setStatus(aiStatus, "AI outpaint applied. The card's own artwork is preserved exactly; only the border was generated. Regenerate for a different border, or use the manual Gemini workflow below for a second opinion.", "ok");
  } catch (err) {
    clearInterval(ticker);
    aiProgressBar.style.width = "0%";
    const friendly = {
      rate_limited: "Too many requests in a short time -- wait a few minutes and try again.",
      daily_cap: "Today's free AI generation budget is used up. Try again tomorrow, or use the manual Gemini workflow below.",
      quota_exceeded: "Workers AI's free daily quota is exhausted. Use the manual Gemini workflow below instead.",
    }[err.code];
    setStatus(aiStatus, friendly || `Generation failed: ${err.message}`, "error");
  } finally {
    aiProgressWrap.hidden = true;
    aiExtendBtn.disabled = false;
    regenerateBtn.disabled = false;
  }
}

aiExtendBtn.addEventListener("click", () => {
  studio.lastSeed = Math.floor(Math.random() * 1_000_000);
  runOutpaint(studio.lastSeed);
});
regenerateBtn.addEventListener("click", () => {
  studio.lastSeed = Math.floor(Math.random() * 1_000_000);
  runOutpaint(studio.lastSeed);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

refreshSlots();
