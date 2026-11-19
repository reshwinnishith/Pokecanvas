// Run with: node --test tests/worker.test.mjs
// Uses a mocked AI binding only -- never calls Cloudflare.
import test from "node:test";
import assert from "node:assert/strict";

// Minimal in-memory Cache API polyfill for the rate limiter.
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { const v = store.get(req.url); return v ? new Response(v) : undefined; },
    async put(req, res) { store.set(req.url, await res.text()); },
  },
};

const { default: worker } = await import("../worker/src/index.js");

const SECRET = "test-passphrase-local-only";
const ORIGIN = "https://pokecanvas-ashy.vercel.app";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function makeEnv(over = {}) {
  const env = { API_KEY: SECRET, ALLOWED_ORIGINS: ORIGIN, aiCalls: 0, aiImpl: async () => PNG, ...over };
  env.AI = { run: async (...a) => { env.aiCalls++; return env.aiImpl(...a); } };
  return env;
}

function form({ image = true, mask = true, prompt = "extend", type = "image/png", size = 10 } = {}) {
  const f = new FormData();
  const blob = () => new File([new Uint8Array(size)], "x.png", { type });
  if (image) f.append("image", blob());
  if (mask) f.append("mask", blob());
  if (prompt) f.append("prompt", prompt);
  f.append("width", "768"); f.append("height", "1072");
  return f;
}

function req(path, { method = "POST", origin = ORIGIN, auth = SECRET, body, ip = "1.1.1.1" } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  if (auth !== null) headers.Authorization = `Bearer ${auth}`;
  return new Request(`https://w.example${path}`, { method, headers, body });
}

test.beforeEach(() => store.clear());

test("missing credentials -> 401, AI not called", async () => {
  const env = makeEnv();
  const r = await worker.fetch(req("/api/extend", { auth: null, body: form() }), env);
  assert.equal(r.status, 401); assert.equal(env.aiCalls, 0);
});
test("wrong credentials -> 401, AI not called", async () => {
  const env = makeEnv();
  const r = await worker.fetch(req("/api/extend", { auth: "nope", body: form() }), env);
  assert.equal(r.status, 401); assert.equal(env.aiCalls, 0);
});
test("secret not configured -> fail closed 503, AI not called", async () => {
  const env = makeEnv({ API_KEY: undefined });
  const r = await worker.fetch(req("/api/extend", { body: form() }), env);
  assert.equal(r.status, 503); assert.equal(env.aiCalls, 0);
});
test("disallowed origin -> 403 even with correct passphrase, AI not called", async () => {
  const env = makeEnv();
  const r = await worker.fetch(req("/api/extend", { origin: "https://evil.vercel.app", body: form() }), env);
  assert.equal(r.status, 403); assert.equal(env.aiCalls, 0);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
});
test("wildcard *.vercel.app no longer allowed", async () => {
  const env = makeEnv();
  const r = await worker.fetch(req("/api/auth", { origin: "https://other-app.vercel.app" }), env);
  assert.equal(r.status, 403);
});
test("localhost blocked unless ALLOW_LOCAL_DEV=true", async () => {
  let env = makeEnv();
  assert.equal((await worker.fetch(req("/api/auth", { origin: "http://localhost:4173" }), env)).status, 403);
  env = makeEnv({ ALLOW_LOCAL_DEV: "true" });
  assert.equal((await worker.fetch(req("/api/auth", { origin: "http://localhost:4173" }), env)).status, 200);
});
test("OPTIONS preflight: allowed origin 204 with headers; disallowed 403", async () => {
  const env = makeEnv();
  const ok = await worker.fetch(req("/api/extend", { method: "OPTIONS", auth: null }), env);
  assert.equal(ok.status, 204);
  assert.match(ok.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const bad = await worker.fetch(req("/api/extend", { method: "OPTIONS", auth: null, origin: "https://evil.example" }), env);
  assert.equal(bad.status, 403);
  assert.equal(env.aiCalls, 0);
});
test("/api/auth validates passphrase without calling AI", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req("/api/auth"), env)).status, 200);
  assert.equal((await worker.fetch(req("/api/auth", { auth: "bad" }), env)).status, 401);
  assert.equal(env.aiCalls, 0);
});
test("valid request -> 200 PNG, AI called exactly once", async () => {
  const env = makeEnv();
  const r = await worker.fetch(req("/api/extend", { body: form() }), env);
  assert.equal(r.status, 200); assert.equal(r.headers.get("Content-Type"), "image/png");
  assert.equal(env.aiCalls, 1);
});
test("malformed: not multipart -> 400; missing files -> 400; missing prompt -> 400", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req("/api/extend", { body: "hello" }), env)).status, 400);
  assert.equal((await worker.fetch(req("/api/extend", { body: form({ mask: false }) }), env)).status, 400);
  assert.equal((await worker.fetch(req("/api/extend", { body: form({ prompt: "" }) }), env)).status, 400);
  assert.equal(env.aiCalls, 0);
});
test("wrong file type -> 400; oversized -> 413; AI not called", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req("/api/extend", { body: form({ type: "image/gif" }) }), env)).status, 400);
  assert.equal((await worker.fetch(req("/api/extend", { body: form({ size: 6 * 1024 * 1024 + 1 }) }), env)).status, 413);
  assert.equal(env.aiCalls, 0);
});
test("AI failure -> 502; quota error -> 429 quota_exceeded", async () => {
  let env = makeEnv({ aiImpl: async () => { throw new Error("boom"); } });
  assert.equal((await worker.fetch(req("/api/extend", { body: form() }), env)).status, 502);
  env = makeEnv({ aiImpl: async () => { throw new Error("daily neurons quota exceeded"); } });
  const r = await worker.fetch(req("/api/extend", { body: form(), ip: "2.2.2.2" }), env);
  assert.equal(r.status, 429); assert.equal((await r.json()).code, "quota_exceeded");
});
test("per-IP rate limit kicks in after 12 requests", async () => {
  const env = makeEnv();
  let last;
  for (let i = 0; i < 13; i++) last = await worker.fetch(req("/api/extend", { body: form(), ip: "3.3.3.3" }), env);
  assert.equal(last.status, 429); assert.equal(env.aiCalls, 12);
});
test("repeated wrong passphrases get throttled", async () => {
  const env = makeEnv();
  let last;
  for (let i = 0; i < 32; i++) last = await worker.fetch(req("/api/auth", { auth: "x" + i, ip: "4.4.4.4" }), env);
  assert.equal(last.status, 429);
  // even the correct passphrase is throttled from that IP for the window
  assert.equal((await worker.fetch(req("/api/auth", { ip: "4.4.4.4" }), env)).status, 429);
});
test("responses never echo the secret", async () => {
  const env = makeEnv();
  const r = await worker.fetch(req("/api/extend", { auth: "wrong", body: form() }), env);
  assert.ok(!(await r.text()).includes(SECRET));
});
