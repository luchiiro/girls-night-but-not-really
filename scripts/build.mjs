import {readFile, mkdir, writeFile, rm} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const loginHtml = await readFile(new URL('worker/login.html', root), 'utf8');
const worker = await readFile(new URL('worker/index.js', root), 'utf8');
await rm(new URL('dist/', root), {recursive: true, force: true});
await mkdir(new URL('dist/server/', root), {recursive: true});
await writeFile(new URL('dist/server/index.js', root), worker.replace('__SITE_HTML__', () => JSON.stringify(html)).replace('__LOGIN_HTML__', () => JSON.stringify(loginHtml)));
console.log('Built password-protected Worker; no public static files.');
