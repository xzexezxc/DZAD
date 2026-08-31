# CATHPRN deployment variants

## Localhost / same Wi-Fi

Run `node serve.js`, then open `http://<computer-LAN-IP>:4173` from another device on the same trusted Wi-Fi. Bind a production server deliberately to the LAN interface, use a firewall rule scoped to the private network, and protect the vault with a strong passphrase. Do not expose this demo server directly to the public internet.

## Online / anywhere

Put the production app behind HTTPS and an identity-aware reverse proxy. Use a server-side SQLite volume (or a managed database), environment-injected secrets, encrypted backups, rate limits, CSRF protection, secure cookies, and a private VPN/connector worker. Keep API keys and streaming credentials server-side; the browser prototype only demonstrates the encrypted vault UX.

## Dedicated scraper network

Run `src/worker.js` on a separate host/container or network namespace when practical. Configure the approved Webshare proxy URLs with `WEBSHARE_PROXY_URLS` (or generic `SCRAPER_PROXIES`) and keep proxy credentials in a secret manager or `.env` excluded from Git.

If the deployment requires VPN/tunnel egress, route the worker host through WireGuard/OpenVPN (or an equivalent organization-approved tunnel) and enforce the route with firewall rules. Do not rely on application code alone to guarantee that every packet uses the tunnel.

Recommended firewall policy:

- API/reverse-proxy: expose only the required HTTPS port(s).
- Worker: no public inbound access; allow only private worker-control traffic.
- Worker egress: permit only the VPN interface and approved proxy destinations.
- SSH: restrict by source IP/key and protect repeated authentication failures with Fail2ban where appropriate.

Example Linux services should be managed by your normal systemd/container orchestration. Fail2ban and firewall configuration are deployment-specific and are intentionally not executed by the Node application.

## Browser mode

Default operation is headless. Set `SCRAPER_HEADLESS=false` when an operator needs a visible browser for authorized troubleshooting. CAPTCHA/Cloudflare/human-verification detection stops the run; it does not automatically switch modes or attempt a bypass.

## Android

The prototype is responsive and PWA-installable. To ship an APK, wrap the hosted build using Capacitor or Trusted Web Activity after the production backend and authentication are in place. A release APK cannot be generated here because Android SDK/signing credentials are not present in this workspace.

Never embed OpenAI, Gemini, Webshare, VPN, or streaming-service secrets in an APK. Route those operations through an authenticated backend.
