# CORS-relay Worker

Stateless Cloudflare Worker that forwards browser requests to
`https://api.democracycraft.net/economy` with CORS headers attached. Exists so the
viewer can stay a pure static page hosted on GitHub Pages.

## Deploy

```sh
cd worker
npx wrangler deploy
```

First run prompts you to log in. After deploy the URL is
`https://dc-transaction-viewer-proxy.<your-subdomain>.workers.dev`.

Update [`../lib/treasury.js`](../lib/treasury.js)'s `DEFAULT_BASE` to that URL and
push — the static site CI redeploys automatically.
