# DC Transaction Viewer

A browser-only viewer for [DemocracyCraft](https://www.democracycraft.net) business
transactions. Open the page, paste a **BUSINESS** Treasury token, type your firm name
(or an account id), and hit **Sync** — transactions are cached locally in IndexedDB so
re-opens are instant, ChestShop activity is auto-folded by day so the ledger stays
scannable on 80k-row accounts, and the **Export CSV** button produces a journal file
that imports directly into [DCManager](https://dcmanager.org).

## Heads-up: requests are proxied

The Treasury API doesn't send CORS headers, so a browser can't call it directly. Every
request from this viewer is routed through a stateless Cloudflare Worker we run (source
in [`worker/`](./worker/)) that forwards the call to `api.democracycraft.net` and adds
the CORS headers your browser needs. The Worker doesn't log or store anything, but
**your bearer token does pass through our infrastructure in transit**. If you'd rather
not trust the proxy, **revoke your token in-game when you're done browsing** — or
deploy your own copy of the Worker from this repo and point `DEFAULT_BASE` in
[`lib/treasury.js`](./lib/treasury.js) at your URL instead.
