# Girl’s Night

Private game club — Cloudflare Workers deployment. The production URL is assigned by Cloudflare after deployment.

Visitors enter a shared password in a form. No username, GitHub or ChatGPT account is needed. Password verification happens on the server before game HTML is served. Keep the repository private and GitHub Pages disabled.

Production secrets are managed in Cloudflare Workers (Settings > Variables and Secrets): `SITE_PASSWORD` and a random `SESSION_SECRET` (at least 32 characters). Never put real values in source or client code. To change the password, update `SITE_PASSWORD` in Cloudflare and deploy. Existing sessions are automatically invalidated by password or signing-key changes.

Successful login sets a signed, seven-day `__Host-gn-session` cookie with Secure, HttpOnly and SameSite=Strict attributes. Login/logout require same-origin POST requests. Logout clears the current browser cookie. There is a best-effort per-IP attempt limit in each Worker instance; it is not a global distributed rate limit. Responses disable caching and search indexing. Missing secrets fail closed.

Build and test: `npm run build && npm test`.

Deploy with `npx wrangler deploy` after building. The Wrangler configuration points only to `dist/server/index.js`. In Cloudflare Workers Builds, connect the repository, select `main`, set the build command to `npm run build && npm test`, and the deploy command to `npx wrangler deploy`. Set the two runtime secrets after creating the Worker; until then, the Worker refuses access. Do not configure any static assets directory. There is no public static directory: `index.html` is bundled into server code. Do not deploy HTML directly to a static host, because that bypasses password protection.

GitHub stores source. Once Cloudflare Workers Builds is connected, GitHub pushes to the production branch can automatically redeploy the site. Games currently run on one device; online multiplayer is not implemented.
