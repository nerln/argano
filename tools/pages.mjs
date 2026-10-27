#!/usr/bin/env node
/* Writes the static pages of argano, once per language, and the sitemap.
 *
 *   node tools/pages.mjs           write web/index.html, web/it/index.html,
 *                                  web/es/index.html, one page per case in
 *                                  every language, and web/sitemap.xml
 *   node tools/pages.mjs --check   write nothing, and fail if any of them is
 *                                  not what the sources would give
 *
 * The sources are tools/page.html and tools/case.html for the layout,
 * web/i18n.js for the words of the tool and tools/cases.mjs for the cases.
 * The pages stay static files served as they are, with no build at load time:
 * this only runs when the words or the layout change, and the files it writes
 * are committed. A language missing a sentence stops the run, so a page never
 * goes out with a hole where a sentence should be.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, LOCALES, words } from '../web/i18n.js';
import { CASES, UI } from './cases.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const WEB = join(TOOLS, '..', 'web');
const SITE = 'https://nerln.github.io/argano/';
const PAGES = ['privacy.html', 'terms.html'];
const checking = process.argv.includes('--check');

const pageTemplate = readFileSync(join(TOOLS, 'page.html'), 'utf8');
const caseTemplate = readFileSync(join(TOOLS, 'case.html'), 'utf8');
const english = words('en');
const textKeys = Object.keys(english).filter((k) => typeof english[k] === 'string');

const dirOf = (lang) => (lang === 'en' ? '' : `${lang}/`);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const caseDir = (c, lang) => `${dirOf(lang)}${c.slug[lang]}/`;

/* Fills a template. Every name in double braces must be text in one of the
   tables given, or the run stops: a page is never written with a hole. */
function fill(template, tables, what) {
  return template.replace(/\{\{(?:(attr|json):)?(\w+)\}\}/g, (_, mode, name) => {
    const table = tables.find((t) => typeof t[name] === 'string');
    if (!table) throw new Error(`${what} asks for ${name}, which is not there as text`);
    const value = table[name];
    if (mode === 'attr') return attr(value);
    if (mode === 'json') return JSON.stringify(value).slice(1, -1);
    return value;
  }).replace(/<!-- the source of [\s\S]*?-->\n/,
    '<!-- written by tools/pages.mjs from the files in tools/ and web/i18n.js: change those, not this -->\n');
}

const alternatesFor = (dirs) => LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${dirs[l]}">`)
  .concat(`<link rel="alternate" hreflang="x-default" href="${SITE}${dirs.en}">`).join('\n');

const langnavFor = (lang, hrefs) => LANGS.map((l) => (l === lang
  ? `<a href="${hrefs[l]}" lang="${l}" aria-current="page">${l.toUpperCase()}</a>`
  : `<a href="${hrefs[l]}" lang="${l}" hreflang="${l}">${l.toUpperCase()}</a>`)).join('');

const outputs = new Map();

for (const lang of LANGS) {
  const w = words(lang);
  const missing = Object.keys(english).filter((k) => !(k in w) || typeof w[k] !== typeof english[k]);
  if (missing.length) throw new Error(`${lang} is missing ${missing.join(', ')}`);
  const ui = UI[lang];
  for (const c of CASES) {
    if (!c[lang] || !c.slug[lang]) throw new Error(`case ${c.id} is missing ${lang}`);
  }

  /* the first screen of the tool */
  const root = lang === 'en' ? '' : '../';
  const toolHref = (to) => `${root}${dirOf(to)}` || './';
  const guides = `<section class="guides" aria-labelledby="guides-title">
      <h2 class="section-title" id="guides-title">${esc(ui.guidesTitle)}</h2>
      <ul>${CASES.map((c) => `<li><a href="${caseDir(c, lang).slice(dirOf(lang).length)}">${esc(c[lang].h1)}</a></li>`).join('')}</ul>
    </section>`;
  const toolSpecial = {
    root,
    lang,
    locale: LOCALES[lang],
    canonical: SITE + dirOf(lang),
    homeHref: toolHref(lang),
    alternates: alternatesFor(Object.fromEntries(LANGS.map((l) => [l, dirOf(l)]))),
    langnav: langnavFor(lang, Object.fromEntries(LANGS.map((l) => [l, toolHref(l)]))),
    guides,
  };
  outputs.set(join(WEB, dirOf(lang), 'index.html'), fill(pageTemplate, [toolSpecial, w], `page.html in ${lang}`));

  /* one page per case, two levels below the root of argano */
  for (const c of CASES) {
    const t = c[lang];
    const up = lang === 'en' ? '../' : '../../';
    const toHome = (l) => `${up}${dirOf(l)}` || './';
    const body = t.sections.map(([heading, paragraphs]) => {
      const inner = paragraphs.length > 1
        ? `<ol class="case-steps">${paragraphs.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>`
        : paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
      return `<section class="case-part"><h2>${esc(heading)}</h2>${inner}</section>`;
    }).join('\n  ');
    const otherLinks = CASES.filter((o) => o !== c)
      .map((o) => `<li><a href="../${o.slug[lang]}/">${esc(o[lang].h1)}</a></li>`).join('');
    const special = {
      root: up,
      locale: LOCALES[lang],
      title: t.title,
      description: t.description,
      canonical: SITE + caseDir(c, lang),
      alternates: alternatesFor(Object.fromEntries(LANGS.map((l) => [l, caseDir(c, l)]))),
      homeHref: toHome(lang),
      langnav: langnavFor(lang, Object.fromEntries(LANGS.map((l) => [l, `${up}${caseDir(c, l)}`]))),
      h1: esc(t.h1),
      lead: esc(t.lead),
      body,
      cta: ui.cta,
      ctaFine: ui.ctaFine,
      ctaHref: `${toHome(lang)}?ref=guide-${c.id}`,
      others: ui.others,
      otherLinks,
    };
    outputs.set(join(WEB, caseDir(c, lang), 'index.html'), fill(caseTemplate, [special, w], `case ${c.id} in ${lang}`));
  }
}

const urls = LANGS.map((l) => SITE + dirOf(l))
  .concat(CASES.flatMap((c) => LANGS.map((l) => SITE + caseDir(c, l))))
  .concat(PAGES.map((p) => SITE + p));
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
console.log(`${textKeys.length} sentences and ${CASES.length} cases in ${LANGS.length} languages`);
