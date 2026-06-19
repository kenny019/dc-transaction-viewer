// CORS-relay Worker for the DC Transaction Viewer.
// Forwards every request to https://api.democracycraft.net/economy and attaches
// CORS headers so the static GitHub Pages site can read responses. Stateless: no
// KV, no D1, no logging, no storage. The bearer token round-trips with the
// request and is never persisted here.
//
// Deploy: `cd worker && npx wrangler deploy`. The default URL is
// `dc-transaction-viewer-proxy.<account>.workers.dev`.
//
// Why this exists: the upstream API doesn't send Access-Control-Allow-Origin, so
// a browser fetch from any other origin (github.io, localhost, anywhere) is
// rejected at preflight. This Worker is the cheapest fix that lets the viewer
// stay a static page.

const UPSTREAM = "https://api.democracycraft.net/economy";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

// Hop-by-hop and storage headers we strip before re-emitting the response. Most
// fall out naturally from the runtime (Workers re-computes content-length /
// transfer-encoding from the new body) but we drop Set-Cookie explicitly so a
// stray upstream cookie can never end up on the static origin.
const DROP_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    // Forward only the headers we know matter to the Treasury — Authorization,
    // Content-Type, and Idempotency-Key. Everything else (Origin, Referer, browser
    // UA noise) gets dropped so the upstream sees a clean request.
    const headers = new Headers();
    for (const h of ["authorization", "content-type", "idempotency-key"]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }

    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.arrayBuffer();
    }

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body,
      });
    } catch (err) {
      return jsonError(502, "PROXY_FETCH_FAILED", err?.message ?? "fetch failed");
    }

    const outHeaders = new Headers(CORS_HEADERS);
    upstream.headers.forEach((v, k) => {
      if (DROP_HEADERS.has(k.toLowerCase())) return;
      outHeaders.set(k, v);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  },
};

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
