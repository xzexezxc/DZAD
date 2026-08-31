# CATHPRN / StreamVault

## Scraper architecture (v3.1)

The metadata scraper runs in a dedicated Node worker so browser work is isolated from the Express API. Jobs are queued and browser concurrency is capped at 2 by default (maximum 3).

### Reliability and responsible crawling

- Persistent Playwright session state is encrypted with AES-256-GCM before being written to disk.
- Authorized proxy endpoints can be supplied through `SCRAPER_PROXIES` or `WEBSHARE_PROXY_URLS`; transient retries rotate to the next configured endpoint.
- For Webshare residential proxies, use the proxy URLs and credentials provided by your Webshare account. Do not commit credentials to source control.
- Retries use exponential backoff plus jitter for HTTP 429/502/503/504 and common transient network failures.
- Requests use configurable User-Agent and Accept-Language headers for compatibility testing. The scraper does not implement stealth plugins or fingerprint spoofing intended to evade anti-bot systems.
- Client-side delay includes jitter and concurrent browser contexts are capped at 2 by default.
- CAPTCHA / Cloudflare / human-verification pages are detected and surfaced; the scraper stops instead of attempting to bypass them.
- Headless mode is configurable with `SCRAPER_HEADLESS=false` for authorized troubleshooting. A detection event does not automatically switch modes to evade a site's controls.
- Structured run metrics include request count, success rate, average response time, retries and error categories.

### Network isolation

For production, put the scraper worker on a separate host/container or network namespace. If all worker traffic must traverse a VPN/Tunnel, enforce this at the host/network layer (for example WireGuard/OpenVPN plus firewall egress rules); `SCRAPER_EGRESS_INTERFACE` documents the intended deployment interface but does not create a VPN itself.

Recommended host controls:

1. Allow inbound traffic only to the web reverse proxy/API ports required by the deployment.
2. Allow the scraper worker outbound traffic only through the approved VPN/proxy egress.
3. Restrict worker-to-API traffic to the private network.
4. Use Fail2ban on exposed SSH/reverse-proxy services where appropriate.
5. Keep Playwright/session files and API secrets outside the public web root.

### Configuration

Copy `.env.example` to `.env` and set a unique `CREDENTIAL_ENCRYPTION_KEY` (32 random bytes, hexadecimal). Configure only proxy infrastructure you are authorized to use.

Relevant settings include `SCRAPER_PROXIES`, `WEBSHARE_PROXY_URLS`, `SCRAPER_CONCURRENCY`, `SCRAPER_MAX_RETRIES`, `SCRAPER_BASE_BACKOFF_MS`, `SCRAPER_MAX_BACKOFF_MS`, `SCRAPER_DELAY_MS`, `SCRAPER_HEADLESS`, and `MAX_WORKER_QUEUE`.

The deployment guide continues to recommend HTTPS, authentication, server-side secrets and a private connector/worker for public deployments.
