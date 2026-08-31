# Streamlib AI Library prototype

Open `index.html` in a modern browser to use the interactive demo. No build step or external account is required. If you prefer a local web server, run `node serve.js` and visit `http://127.0.0.1:4173`.

The app is now named **CATHPRN — StreamVault Management Center**. It includes a local AES-GCM vault UX for multiple streaming credentials, OpenAI/Gemini keys, a NordVPN key, and an encrypted SOCKS5/SOCKS5H proxy URI; safe SeleniumBase settings; connector health and AI-assisted repair cards; backup/restore; watchlist; homepage shelves for most/recently viewed; and studio/site/year/duration/tag/performer library filters.

The prototype includes a dashboard, library search/filtering, service health, sync run history, settings, and a guided AI AutoScraper workflow. The wizard offers Playwright, Nodriver, and SeleniumBase as connector-engine choices and safely simulates gallery analysis, metadata mapping, crawl limits, and a review-before-import test flow.

Titles open an enhanced player preview with caption selection and an Auto/1080p/720p/480p quality preference. It uses an openly licensed demonstration video, so the quality picker is UI state only; a production player needs authorized HLS/DASH renditions supplied by the source service.

This is a front-end prototype: it does not crawl websites, store credentials, bypass security measures, or play protected media. Imported demo titles are stored only in the browser's local storage; clear site data to reset the demo.

## Real AutoScraper backend

The `backend/` folder is the runnable Node/Playwright implementation behind the wizard. See [backend/README.md](backend/README.md), run `npm install`, create `.env` from `.env.example`, run `npm run install-browser`, then `npm start`. The UI will queue real test runs against `http://127.0.0.1:8787` when that worker is available; otherwise it keeps the safe demo preview.
