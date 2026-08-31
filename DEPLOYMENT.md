# CATHPRN deployment variants

## Localhost / same Wi‑Fi

Run `node serve.js`, then open `http://<computer-LAN-IP>:4173` from another device on the same trusted Wi‑Fi. Bind a production server deliberately to the LAN interface, use a firewall rule scoped to the private network, and protect the vault with a strong passphrase. Do not expose this demo server directly to the public internet.

## Online / anywhere

Put the production app behind HTTPS and an identity-aware reverse proxy. Use a server-side SQLite volume (or a managed database), environment-injected secrets, encrypted backups, rate limits, CSRF protection, secure cookies, and a private VPN/connector worker. Keep API keys and streaming credentials server-side; the browser prototype only demonstrates the encrypted vault UX.

`manifest.webmanifest` and `sw.js` provide the installable PWA foundation for both variants. The sample `sw.js` should be replaced with a versioned production service worker during deployment.

## Android

The prototype is responsive and PWA-installable. To ship an APK, wrap the hosted build using Capacitor or Trusted Web Activity after the production backend and authentication are in place. A release APK cannot be generated here because Android SDK/signing credentials are not present in this workspace.

Never embed OpenAI, Gemini, NordVPN, or streaming-service secrets in an APK. Route those operations through an authenticated backend.
