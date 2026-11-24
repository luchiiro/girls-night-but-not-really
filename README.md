# Girl’s Night

Private game club. Production: https://girls-night-luchiiro.resolutechar2.chatgpt.site

The site uses server-side HTTP Basic authentication over HTTPS. Browsers ask for a shared username and password. GitHub and ChatGPT accounts are not required for visitors. Keep the repository private and GitHub Pages disabled.

`SITE_USERNAME` and `SITE_PASSWORD` are production secrets managed in Sites. No real credentials belong in this repository. Passwords must contain at least 20 characters; use a randomly generated password. To revoke a shared password, update the production secret and redeploy. Browsers may remember credentials until their session ends; use a private browser window on shared devices.

All routes require authentication. HTML is bundled into the Worker; there is no public static asset directory. Missing secrets fail closed. Responses disable caching and search indexing.

Build with `node scripts/build.mjs`, then check with `node --test scripts/auth.test.mjs`. Deploy only the Worker build from `dist/` via Sites. Never deploy `index.html` directly to a static host: static hosting bypasses the server password protection.

The GitHub repository stores source. Sites hosts a separately synchronized source repository; GitHub pushes do not automatically redeploy this site.

Games currently run on one device. Online multiplayer is not implemented.
