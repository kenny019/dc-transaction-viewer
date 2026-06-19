# DC Transaction Viewer

A browser-only viewer for [DemocracyCraft](https://www.democracycraft.net) business
transactions. Open the page, paste a **BUSINESS** Treasury token, type your firm name
(or an account id), and hit **Sync** — transactions are cached locally in IndexedDB so
re-opens are instant, ChestShop activity is auto-folded by day so the ledger stays
scannable on 80k-row accounts, and the **Export CSV** button produces a journal file
that imports directly into [DCManager](https://dcmanager.org). Your token is held in
this browser's `localStorage` and only ever sent to the stateless Cloudflare Worker in
[`worker/`](./worker/), which forwards it to the Treasury API and attaches the CORS
headers Chrome needs to read the response.
