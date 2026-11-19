const MODEL = "@cf/runwayml/stable-diffusion-v1-5-inpainting";

const ALLOWED_ORIGIN_SUFFIXES = [".vercel.app"];
const ALLOWED_ORIGINS_EXACT = new Set([
  "https://pokecanvas-ashy.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS_EXACT.has(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "https:") return false;
    return ALLOWED_ORIGIN_SUFFIXES.some((suf) => hostname.endsWith(suf));
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

const MAX_BYTES = 6 * 1024 * 1024;
const MIN_DIM = 256;
const MAX_DIM = 2048;

// Best-effort abuse guard using the zone Cache API (no extra bindings required).
// Not a strict distributed limiter -- a single colo/isolate can undercount --
// but it bounds accidental hammering and runaway retry loops.
async function checkRateLimit(request, bucketKey, limit, windowSeconds) {
  const cache = caches.default;
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSeconds);
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = "/__ratelimit__";
  cacheUrl.search = `?k=${encodeURIComponent(bucketKey)}&w=${window}`;
  const cacheKey = new Request(cacheUrl.toString());

  let count = 0;
  const cached = await cache.match(cacheKey);
  if (cached) {
    count = Number(await cached.text()) || 0;
  }
  count += 1;
  const resp = new Response(String(count), {
    headers: { "Cache-Control": `max-age=${windowSeconds}` },
  });
  await cache.put(cacheKey, resp);
  return count <= limit;
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

async function readField(form, name, max) {
  const v = form.get(name);
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, max || 4000);
  return v; // File
}

async function handleExtend(request, env, origin) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const okPerIp = await checkRateLimit(request, `ip:${ip}`, 12, 600); // 12 / 10 min / IP
  if (!okPerIp) {
    return json(
      { error: "Too many requests. Please wait a few minutes and try again.", code: "rate_limited" },
      429,
      origin
    );
  }
  const okGlobal = await checkRateLimit(request, "global", 300, 86400); // soft daily cap, free-tier guard
  if (!okGlobal) {
    return json(
      { error: "Daily generation budget reached for this studio. Try again tomorrow, or use the manual Gemini workflow.", code: "daily_cap" },
      429,
      origin
    );
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BYTES * 2 + 8192) {
    return json({ error: "Upload too large.", code: "too_large" }, 413, origin);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data.", code: "bad_request" }, 400, origin);
  }

  const imageFile = form.get("image");
  const maskFile = form.get("mask");
  const prompt = await readField(form, "prompt", 600);
  const negativePrompt = await readField(form, "negative_prompt", 400);
  const width = clamp(form.get("width"), MIN_DIM, MAX_DIM, 768);
  const height = clamp(form.get("height"), MIN_DIM, MAX_DIM, 1072);
  const strength = clamp(form.get("strength"), 0, 1, 1);
  const guidance = clamp(form.get("guidance"), 1, 20, 7.5);
  const numSteps = Math.round(clamp(form.get("num_steps"), 1, 20, 20));
  const seedRaw = form.get("seed");
  const seed = seedRaw != null && seedRaw !== "" ? Math.round(clamp(seedRaw, 0, 2 ** 31 - 1, undefined)) : undefined;

  if (!(imageFile instanceof File) || !(maskFile instanceof File)) {
    return json({ error: "image and mask files are required.", code: "bad_request" }, 400, origin);
  }
  if (!prompt) {
    return json({ error: "prompt is required.", code: "bad_request" }, 400, origin);
  }
  if (imageFile.size > MAX_BYTES || maskFile.size > MAX_BYTES) {
    return json({ error: "image/mask must each be under 6MB.", code: "too_large" }, 413, origin);
  }
  if (!/^image\/(png|jpeg)$/.test(imageFile.type) || !/^image\/(png|jpeg)$/.test(maskFile.type)) {
    return json({ error: "image/mask must be PNG or JPEG.", code: "bad_request" }, 400, origin);
  }

  const [imageBytes, maskBytes] = await Promise.all([
    imageFile.arrayBuffer(),
    maskFile.arrayBuffer(),
  ]);

  const inputs = {
    prompt: `${prompt} Seamless continuation of the surrounding illustration, consistent lighting, palette and brushwork, no text, no borders, no logos, no watermark, no duplicate characters.`,
    image: Array.from(new Uint8Array(imageBytes)),
    mask: Array.from(new Uint8Array(maskBytes)),
    width: Math.round(width),
    height: Math.round(height),
    strength,
    guidance,
    num_steps: numSteps,
  };
  if (negativePrompt) inputs.negative_prompt = negativePrompt;
  if (seed !== undefined) inputs.seed = seed;

  let result;
  try {
    result = await env.AI.run(MODEL, inputs);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (/quota|limit|exceeded|429/i.test(message)) {
      return json(
        { error: "AI generation quota for today is exhausted. Use the manual Gemini workflow instead.", code: "quota_exceeded" },
        429,
        origin
      );
    }
    return json({ error: "Image generation failed. Please try again.", code: "generation_failed" }, 502, origin);
  }

  let pngBytes;
  if (result instanceof ReadableStream) {
    pngBytes = result;
  } else if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
    pngBytes = result;
  } else if (result && typeof result === "object" && typeof result.image === "string") {
    // Some models return { image: base64 }; normalize to bytes.
    const bin = atob(result.image);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    pngBytes = arr;
  } else {
    return json({ error: "Unexpected response from the image model.", code: "generation_failed" }, 502, origin);
  }

  return new Response(pngBytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, model: MODEL, aiBindingPresent: !!env.AI }, 200, origin);
    }

    if (url.pathname === "/api/extend" && request.method === "POST") {
      return handleExtend(request, env, origin);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("PokeCanvas worker. See /api/health and POST /api/extend.", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    return json({ error: "Not found" }, 404, origin);
  },
};
