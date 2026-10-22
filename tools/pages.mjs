#!/usr/bin/env node
/* Writes the page once per language, and the sitemap that lists them.
 *
 *   node tools/pages.mjs           write web/index.html, web/it/index.html,
 *                                  web/es/index.html and web/sitemap.xml
 *   node tools/pages.mjs --check   write nothing, and fail if any of them is
 *                                  not what tools/page.html and web/i18n.js would give
 *
 * The page stays a static file served as it is, with no build at load time:
 * this only runs when the words or the layout change, and the files it writes
 * are committed. A language missing a sentence stops the run, so a page never
 * goes out with a hole where a sentence should be.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, LOCALES, words } from '../web/i18n.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const SITE = 'https://nerln.github.io/argano/';
const PAGES = ['privacy.html', 'terms.html'];
const checking = process.argv.includes('--check');

const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'page.html'), 'utf8');
const english = words('en');
const textKeys = Object.keys(english).filter((k) => typeof english[k] === 'string');

const dirOf = (lang) => (lang === 'en' ? '' : `${lang}/`);
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const outputs = new Map();

for (const lang of LANGS) {
  const w = words(lang);
  const missing = Object.keys(english).filter((k) => !(k in w) || typeof w[k] !== typeof english[k]);
  if (missing.length) throw new Error(`${lang} is missing ${missing.join(', ')}`);

  const root = lang === 'en' ? '' : '../';
  const href = (to) => `${root}${dirOf(to)}` || './';
  const special = {
    root,
    lang,
    locale: LOCALES[lang],
    canonical: SITE + dirOf(lang),
    homeHref: href(lang),
    alternates: LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${dirOf(l)}">`)
      .concat(`<link rel="alternate" hreflang="x-default" href="${SITE}">`).join('\n'),
    langnav: LANGS.map((l) => (l === lang
      ? `<a href="${href(l)}" lang="${l}" aria-current="page">${l.toUpperCase()}</a>`
      : `<a href="${href(l)}" lang="${l}" hreflang="${l}">${l.toUpperCase()}</a>`)).join(''),
  };

  const html = template.replace(/\{\{(?:(attr|json):)?(\w+)\}\}/g, (_, mode, name) => {
    const value = name in special ? special[name] : w[name];
    if (typeof value !== 'string') throw new Error(`page.html asks for ${name}, which ${lang} does not have as text`);
    if (mode === 'attr') return attr(value);
    if (mode === 'json') return JSON.stringify(value).slice(1, -1);
    return value;
  }).replace(/<!-- the source of index\.html[\s\S]*?-->\n/,
    '<!-- written by tools/pages.mjs from tools/page.html and web/i18n.js: change those, not this -->\n');

  outputs.set(join(WEB, dirOf(lang), 'index.html'), html);
}

const urls = LANGS.map((l) => SITE + dirOf(l)).concat(PAGES.map((p) => SITE + p));
outputs.set(join(WEB, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')
  + '\n</urlset>\n');

let stale = 0;
for (const [path, text] of outputs) {
  const now = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (now === text) continue;
  if (checking) {
    console.error(`out of date: ${path.slice(WEB.length + 1)}`);
    stale += 1;
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${path.slice(WEB.length + 1)}`);
}
if (stale) {
  console.error('run `node tools/pages.mjs` and commit what it writes');
  process.exit(1);
}
console.log(`${textKeys.length} sentences in ${LANGS.length} languages`);
