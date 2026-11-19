// Card identification, step 1: browser-side OCR (Tesseract.js, loaded via <script>
// in index.html as a classic global so it works with no build step) plus a small
// heuristic parser that pulls a name guess, a collector number ("4/102") and a
// Japanese/English signal out of the raw recognition.

const JP_RE = /[぀-ヿ㐀-䶿一-鿿]/;
const NUMBER_RE = /(\d{1,4})\s*\/\s*(\d{1,4})/;
const NOISE_WORDS = new Set([
  "hp", "stage", "basic", "pokemon", "pokémon", "energy", "evolves", "from",
  "trainer", "item", "supporter", "stadium", "weakness", "resistance", "retreat",
]);

export async function recognizeCard(imageFile, { onProgress } = {}) {
  const Tesseract = window.Tesseract;
  if (!Tesseract) {
    throw new Error("The OCR engine could not load (check your connection). You can still search for the card manually below.");
  }
  const { data } = await Tesseract.recognize(imageFile, "eng+jpn", {
    langPath: "https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast",
    logger: (m) => {
      if (onProgress && m.status && typeof m.progress === "number") {
        onProgress(m.status, m.progress);
      }
    },
  });
  return parseCardText(data);
}

function parseCardText(data) {
  const text = data.text || "";
  // Require a few CJK characters, not just one, so a single misread glyph on an
  // otherwise-English card (common on busy holo backgrounds) doesn't flip this.
  const japanese = (text.match(JP_RE) || []).length >= 3;

  let number = null;
  let total = null;
  const numMatch = text.match(NUMBER_RE);
  if (numMatch) {
    number = stripLeadingZeros(numMatch[1]);
    total = stripLeadingZeros(numMatch[2]);
  }

  const lines = (data.lines || [])
    .map((l) => ({
      text: (l.text || "").trim(),
      confidence: l.confidence || 0,
      y: l.bbox ? l.bbox.y0 : 0,
    }))
    .filter((l) => l.text.length >= 2 && l.text.length <= 28)
    .sort((a, b) => a.y - b.y);

  const topLines = lines.slice(0, Math.max(3, Math.ceil(lines.length * 0.3)));

  // Card name lines are often cluttered with neighbouring badge/HP text that OCR
  // merges onto one line (e.g. "AS Charizard 120 HPWY"), so rather than trust the
  // whole line, pull out its longest run of clean, non-numeric word tokens.
  let nameGuess = null;
  let bestLen = 0;
  for (const line of topLines) {
    const cleaned = line.text.replace(/[^\p{L}\p{N}'.\- ]/gu, " ").trim();
    if (!cleaned) continue;
    const tokens = cleaned.split(/\s+/);
    let run = [];
    const flush = () => {
      if (run.length) {
        const phrase = run.join(" ");
        if (phrase.length > bestLen) { bestLen = phrase.length; nameGuess = phrase; }
        run = [];
      }
    };
    for (const token of tokens) {
      const valid = token.length >= 2 && !/\d/.test(token) && !NOISE_WORDS.has(token.toLowerCase());
      if (valid) run.push(token);
      else flush();
    }
    flush();
  }

  return { rawText: text, japanese, number, total, nameGuess };
}

function stripLeadingZeros(s) {
  const n = s.replace(/^0+(?=\d)/, "");
  return n || "0";
}
