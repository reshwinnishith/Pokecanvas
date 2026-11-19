// Card identification, step 2: match the OCR guess against TCGdex
// (https://tcgdex.dev -- free, keyless, covers English and Japanese sets with
// hosted card scans) and rank candidates by name + collector number + set size.

const BASE = "https://api.tcgdex.net/v2";

export async function searchCandidates({ name, number, total, japanese }) {
  if (!name) return { lang: japanese ? "ja" : "en", candidates: [] };

  const primaryLang = japanese ? "ja" : "en";
  let lang = primaryLang;
  let results = await searchByName(lang, name);
  if (!results.length && lang !== "en") {
    lang = "en";
    results = await searchByName(lang, name);
  }
  if (!results.length) {
    // OCR often glues a stray badge/stage token onto the name (e.g. "AS
    // Charizard"); the database's substring match needs the clean word, so
    // retry with just the longest token in the guess.
    const words = name.split(/\s+/).filter((w) => w.length >= 3);
    const longest = words.sort((a, b) => b.length - a.length)[0];
    if (longest && longest !== name) {
      results = await searchByName(lang, longest);
      if (!results.length && lang !== "en") results = await searchByName("en", longest);
    }
  }
  results = results.filter((c) => !!c.image);
  if (!results.length) return { lang, candidates: [] };

  let candidates = results;
  if (number) {
    const stripped = stripLeadingZeros(number);
    const byNumber = results.filter((c) => {
      const loc = stripLeadingZeros(String(c.localId || ""));
      return loc === stripped || String(c.localId) === number;
    });
    if (byNumber.length) candidates = byNumber;
  }

  if (candidates.length > 1 && total) {
    const detailed = await Promise.all(
      candidates.slice(0, 20).map(async (c) => {
        const setId = setIdFromCardId(c.id);
        if (!setId) return c;
        try {
          const set = await fetchJson(`${BASE}/${lang}/sets/${setId}`);
          return {
            ...c,
            _setTotal: set && set.cardCount ? set.cardCount.total : null,
            _setName: set ? set.name : null,
          };
        } catch {
          return c;
        }
      })
    );
    const totalMatches = detailed.filter((c) => String(c._setTotal) === String(total));
    candidates = totalMatches.length ? totalMatches : detailed;
  }

  return { lang, candidates: candidates.slice(0, 12) };
}

export async function fetchCardDetail(lang, id) {
  return fetchJson(`${BASE}/${lang}/cards/${id}`);
}

export function cardImageUrl(card, quality = "high", ext = "png") {
  return `${card.image}/${quality}.${ext}`;
}

function setIdFromCardId(id) {
  const idx = id.lastIndexOf("-");
  return idx > -1 ? id.slice(0, idx) : null;
}

async function searchByName(lang, name) {
  try {
    return await fetchJson(`${BASE}/${lang}/cards?name=${encodeURIComponent(name)}`);
  } catch {
    return [];
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TCGdex request failed: ${res.status}`);
  return res.json();
}

function stripLeadingZeros(s) {
  const n = String(s).replace(/^0+(?=\d)/, "");
  return n || "0";
}
