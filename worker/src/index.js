// PokéCanvas Worker.
//
// Access model (private personal app):
//  - /api/extend and /api/auth require "Authorization: Bearer <studio passphrase>",
//    compared in constant time against the Worker secret API_KEY.
//    Missing/incorrect credentials are rejected BEFORE any AI binding call.
//  - Browsers are additionally restricted by CORS to explicitly listed origins
//    (ALLOWED_ORIGINS var). CORS is NOT authentication; it only stops other
//    websites from using a visitor's browser. The passphrase is what protects the AI quota.
//  - Local development origins are allowed only when ALLOW_LOCAL_DEV=true is set
//    in the git-ignored worker/.dev.vars file. It is never set in production.
//  - The Cache API rate limiter below is best-effort and per data centre. It is an
//    abuse guard, NOT a guaranteed global quota.

const MODEL = "@cf/runwayml/stable-diffusion-v1-5-inpainting";

const DEFAULT_ALLOWED_ORIGINS = ["https://pokecanvas-ashy.vercel.app"];
const LOCAL_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173",
];

function allowedOrigins(env) {
  const fromEnv = String((env && env.ALLOWED_ORIGINS) || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = fromEnv.length ? fromEnv : DEFAULT_ALLOWED_ORIGINS;
  if (env && env.ALLOW_LOCAL_DEV === "true") list.push(...LOCAL_DEV_ORIGINS);
  return new Set(list);
}

function isAllowedOrigin(origin, env) {
  return !!origin && allowedOrigins(env).has(origin);
}

function corsHeaders(origin, env) {
  const headers = { Vary: "Origin" };
  if (isAllowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

function json(data, status, origin, env, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin, env),
      ...extraHeaders,
    },
  });
}

const encoder = new TextEncoder();

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

// Constant-time comparison: hash both sides to equal-length digests first so
// neither the content nor the length of the secret leaks through timing.
async function secretsMatch(provided, expected) {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim().slice(0, 256) : "";
}

// Returns null when authorised, otherwise a Response to send back.
async function authenticate(request, env, origin) {
  if (!env.API_KEY) {
    // Fail closed: never run AI when the secret is not configured.
    return json({ error: "Server is not configured.", code: "not_configured" }, 503, origin, env);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const token = bearerToken(request);
  if (!token) {
    return json({ error: "Passphrase required.", code: "unauthorized" }, 401, origin, env, {
      "WWW-Authenticate": 'Bearer realm="pokecanvas"',
    });
  }
  // Slow down passphrase guessing (best-effort, per data centre).
  const underLimit = await checkRateLimit(request, `authfail-probe:${ip}`, 30, 600, { peek: true });
  if (!underLimit) {
    return json({ error: "Too many attempts. Please wait and try again.", code: "rate_limited" }, 429, origin, env);
  }
  if (!(await secretsMatch(token, env.API_KEY))) {
    await checkRateLimit(request, `authfail-probe:${ip}`, 30, 600);
    return json({ error: "Incorrect passphrase.", code: "unauthorized" }, 401, origin, env, {
      "WWW-Authenticate": 'Bearer realm="pokecanvas"',
    });
  }
  return null;
}

const MAX_BYTES = 6 * 1024 * 1024;
const MIN_DIM = 256;
const MAX_DIM = 2048;

// Best-effort abuse guard using the zone Cache API (no extra bindings required).
// Not a strict distributed limiter -- each data centre counts separately and
// cache entries can be evicted -- so it bounds accidental hammering and retry
// loops but does NOT guarantee a global quota. With { peek: true } it only reads.
async function checkRateLimit(request, bucketKey, limit, windowSeconds, { peek = false } = {}) {
  const cache = caches.default;
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSeconds);
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = "/__ratelimit__";
  cacheUrl.search = `?k=${encodeURIComponent(bucketKey)}&w=${window}`;
  const cacheKey = new Request(cacheUrl.toString());

  let count = 0;
  const cached = await cache.match(cacheKey);
  if (cached) count = Number(await cached.text()) || 0;
  if (peek) return count < limit;
  count += 1;
  await cache.put(cacheKey, new Response(String(count), { headers: { "Cache-Control": `max-age=${windowSeconds}` } }));
  return count <= limit;
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function readField(form, name, max) {
  const v = form.get(name);
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, max || 4000);
  return null; // a File where text was expected
}

async function handleExtend(request, env, origin) {
  // 1. Authentication happens before anything else, in particular before the AI binding is touched.
  const denied = await authenticate(request, env, origin);
  if (denied) return denied;

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // 2. Best-effort rate limits (not a guaranteed quota).
  if (!(await checkRateLimit(request, `ip:${ip}`, 12, 600))) {
    return json({ error: "Too many requests. Please wait a few minutes and try again.", code: "rate_limited" }, 429, origin, env);
  }
  if (!(await checkRateLimit(request, "global", 300, 86400))) {
    return json(
      { error: "Daily generation budget reached for this studio. Try again tomorrow, or use the manual Gemini workflow.", code: "daily_cap" },
      429,
      origin,
      env
    );
  }

  // 3. Input validation.
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BYTES * 2 + 8192) {
    return json({ error: "Upload too large.", code: "too_large" }, 413, origin, env);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data.", code: "bad_request" }, 400, origin, env);
  }

  const imageFile = form.get("image");
  const maskFile = form.get("mask");
  const prompt = readField(form, "prompt", 600);
  const negativePrompt = readField(form, "negative_prompt", 400);
  const width = clamp(form.get("width"), MIN_DIM, MAX_DIM, 768);
  const height = clamp(form.get("height"), MIN_DIM, MAX_DIM, 1072);
  const strength = clamp(form.get("strength"), 0, 1, 1);
  const guidance = clamp(form.get("guidance"), 1, 20, 7.5);
  const numSteps = Math.round(clamp(form.get("num_steps"), 1, 20, 20));
  const seedRaw = form.get("seed");
  const seed = seedRaw != null && seedRaw !== "" ? Math.round(clamp(seedRaw, 0, 2 ** 31 - 1, 0)) : undefined;

  if (!(imageFile instanceof File) || !(maskFile instanceof File)) {
    return json({ error: "image and mask files are required.", code: "bad_request" }, 400, origin, env);
  }
  if (!prompt) {
    return json({ error: "prompt is required.", code: "bad_request" }, 400, origin, env);
  }
  if (imageFile.size > MAX_BYTES || maskFile.size > MAX_BYTES) {
    return json({ error: "image/mask must each be under 6MB.", code: "too_large" }, 413, origin, env);
  }
  if (!/^image\/(png|jpeg)$/.test(imageFile.type) || !/^image\/(png|jpeg)$/.test(maskFile.type)) {
    return json({ error: "image/mask must be PNG or JPEG.", code: "bad_request" }, 400, origin, env);
  }

  const [imageBytes, maskBytes] = await Promise.all([imageFile.arrayBuffer(), maskFile.arrayBuffer()]);

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

  // 4. The only place the AI binding is invoked.
  let result;
  try {
    result = await env.AI.run(MODEL, inputs);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (/quota|limit|exceeded|429|neurons/i.test(message)) {
      return json(
        { error: "AI generation quota for today is exhausted. Use the manual Gemini workflow instead.", code: "quota_exceeded" },
        429,
        origin,
        env
      );
    }
    return json({ error: "Image generation failed. Please try again.", code: "generation_failed" }, 502, origin, env);
  }

  let pngBytes;
  if (result instanceof ReadableStream || result instanceof Uint8Array || result instanceof ArrayBuffer) {
    pngBytes = result;
  } else if (result && typeof result === "object" && typeof result.image === "string") {
    const bin = atob(result.image);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    pngBytes = arr;
  } else {
    return json({ error: "Unexpected response from the image model.", code: "generation_failed" }, 502, origin, env);
  }

  return new Response(pngBytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store", ...corsHeaders(origin, env) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    const isApi = url.pathname === "/api/extend" || url.pathname === "/api/auth";

    // Browsers from non-approved origins are refused outright on API routes.
    if (isApi && origin && !isAllowedOrigin(origin, env)) {
      return json({ error: "Origin not allowed.", code: "origin_not_allowed" }, 403, null, env);
    }

    if (request.method === "OPTIONS") {
      if (isApi && !isAllowedOrigin(origin, env)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true }, 200, origin, env);
    }

    // Checks the passphrase only; never touches the AI binding.
    if (url.pathname === "/api/auth" && request.method === "POST") {
      const denied = await authenticate(request, env, origin);
      return denied || json({ ok: true }, 200, origin, env);
    }

    if (url.pathname === "/api/extend" && request.method === "POST") {
      return handleExtend(request, env, origin);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("PokeCanvas worker.", { headers: { "Content-Type": "text/plain" } });
    }

    return json({ error: "Not found" }, 404, origin, env);
  },
};
