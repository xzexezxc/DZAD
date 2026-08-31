# CATHPRN / StreamVault

## Scraper architecture (v3)

The metadata scraper now runs in a dedicated Node worker so browser work is isolated from the Express API. Jobs are queued and the scraper itself caps browser concurrency at 2 by default (maximum 3).

### Reliability and responsible crawling

- Persistent Playwright session state is encrypted with AES-256-GCM before being written to disk.
- Optional authorized proxy endpoints can be supplied through `SCRAPER_PROXIES`; retries rotate to the next configured endpoint after transient failures.
- Retries use exponential backoff plus jitter for HTTP 429/502/503/504 and common transient network failures.
- Requests use adaptive, configurable `User-Agent` and `Accept-Language` headers for normal compatibility testing.
- Client-side delay includes jitter and concurrent browser contexts are capped at 2 by default.
- CAPTCHA / human-verification pages are detected and surfaced; the scraper does not attempt to bypass them.
- Structured run metrics include request count, success rate, average response time, retries and error categories.

### Configuration

Copy `.env.example` to `.env` and set a unique `CREDENTIAL_ENCRYPTION_KEY` (32 random bytes, hexadecimal). Configure only proxy infrastructure you are authorized to use.

Relevant settings include `SCRAPER_PROXIES`, `SCRAPER_CONCURRENCY`, `SCRAPER_MAX_RETRIES`, `SCRAPER_BASE_BACKOFF_MS`, `SCRAPER_MAX_BACKOFF_MS`, `SCRAPER_DELAY_MS`, and `MAX_WORKER_QUEUE`.

The deployment guide continues to recommend HTTPS, authentication, server-side secrets and a private connector/worker for public deployments.
