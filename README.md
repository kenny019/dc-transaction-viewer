# DC Transaction Viewer

A browser-only viewer for [DemocracyCraft](https://www.democracycraft.net) business
transactions. Open the page, paste a **BUSINESS** Treasury token, type your firm name
(or an account id), and hit **Sync** — transactions are cached locally in IndexedDB so
re-opens are instant, ChestShop activity is auto-folded by day so the ledger stays
scannable on 80k-row accounts, and the **Export CSV** button produces a journal file
that imports directly into [DCManager](https://dcmanager.org). Your token never leaves
the browser.
