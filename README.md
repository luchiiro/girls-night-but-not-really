# Girl’s Night

Private game club: https://girls-night-luchiiro.resolutechar2.chatgpt.site

Visitors enter a shared password in a form. No username, GitHub or ChatGPT account is needed. Password verification happens on the server before game HTML is served. Keep the repository private and GitHub Pages disabled.

Production secrets are managed in Sites: `SITE_PASSWORD` and a random `SESSION_SECRET` (at least 32 characters). Never put real values in source or client code. To change the password, update `SITE_PASSWORD` in Sites and redeploy. Existing sessions are automatically invalidated by password or signing-key changes.

Successful login sets a signed, seven-day `__Host-gn-session` cookie with Secure, HttpOnly and SameSite=Strict attributes. Login/logout require same-origin POST requests. Logout clears the current browser cookie. There is a best-effort per-IP attempt limit in each Worker instance; it is not a global distributed rate limit. Responses disable caching and search indexing. Missing secrets fail closed.

Build: `node scripts/build.mjs`. Tests: `node --test scripts/auth.test.mjs`.

Deploy only the Worker build in `dist/` through Sites. There is no public static directory: `index.html` is bundled into server code. Do not deploy HTML directly to a static host, because that bypasses password protection.

GitHub stores source. Sites hosts a separately synchronized source repository; GitHub pushes do not automatically redeploy this site. Games currently run on one device; online multiplayer is not implemented.
