#!/usr/bin/env node
// Rewrites the generated blocks of a profile README from live package data.
//
// Env:
//   PROFILE      which entries to list ("personal" or "uluops"); default "personal"
//   README_PATH  file to update; default "README.md"
//   CONFIG       entry list; default "packages.json"
//   STYLE        "console" (terminal prompts, default) or "index" (numbered rows
//                under plain headings, for the Swiss README)
//   GITHUB_TOKEN optional, raises the GitHub API rate limit
//
// Blocks it owns (everything between the markers is overwritten):
//   <!-- PACKAGES:START --> ... <!-- PACKAGES:END -->   one table per group
//   <!-- SHIPPED:START -->  ... <!-- SHIPPED:END -->    most recent ships
//
// Entry fields (packages.json):
//   group    which table it belongs to (see "groups")
//   label    display name
//   desc     one-line description
//   profiles which profiles list it
//   npm      npm package name: version and date come from the registry
//   repo     "owner/name": used for GitHub release / last-push when there is no npm data
//   url      link target; defaults to the npm page, then the GitHub repo
//   static   fixed text for the Latest column (e.g. "live" for a hosted app)
//
// Group fields: id, cmd (console style heading), title (index style heading,
// defaults to the capitalised id).

import { readFileSync, writeFileSync } from 'node:fs';

const PROFILE = process.env.PROFILE ?? 'personal';
const README = process.env.README_PATH ?? 'README.md';
const CONFIG = process.env.CONFIG ?? 'packages.json';
const STYLE = process.env.STYLE ?? 'console';
const TOKEN = process.env.GITHUB_TOKEN;
const RECENT_SHIPS = 5;

if (STYLE !== 'console' && STYLE !== 'index') {
  throw new Error(`Unknown STYLE "${STYLE}" (use "console" or "index")`);
}

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'profile-updater',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

// Fixed text, else npm (what people install), else the latest GitHub release,
// else the last push to the repo.
async function lookup(entry) {
  if (entry.static) return { version: entry.static, shipped: null, shippedForReal: false };
  if (entry.npm) {
    const data = await getJson(`https://registry.npmjs.org/${entry.npm.replace('/', '%2F')}`);
    const latest = data?.['dist-tags']?.latest;
    if (latest && data.time?.[latest]) {
      return { version: latest, shipped: data.time[latest], shippedForReal: true };
    }
  }
  if (!entry.repo) return { version: '-', shipped: null, shippedForReal: false };
  const release = await getJson(`https://api.github.com/repos/${entry.repo}/releases/latest`, ghHeaders);
  if (release) {
    return { version: release.tag_name, shipped: release.published_at, shippedForReal: true };
  }
  const repo = await getJson(`https://api.github.com/repos/${entry.repo}`, ghHeaders);
  if (repo) return { version: 'main', shipped: repo.pushed_at, shippedForReal: false };
  return { version: '-', shipped: null, shippedForReal: false };
}

const day = (iso) => (iso ? iso.slice(0, 10) : '-');
const pad2 = (n) => String(n).padStart(2, '0');
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const linkFor = (entry) =>
  entry.url ??
  (entry.npm ? `https://www.npmjs.com/package/${entry.npm}` : `https://github.com/${entry.repo}`);

function replaceBlock(text, tag, body) {
  const re = new RegExp(`(<!-- ${tag}:START -->)[\\s\\S]*?(<!-- ${tag}:END -->)`);
  if (!re.test(text)) throw new Error(`Missing <!-- ${tag}:START/END --> markers in ${README}`);
  return text.replace(re, (_, start, end) => `${start}\n${body}\n${end}`);
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const groups = config.groups ?? [{ id: 'packages', cmd: 'ls ./packages' }];
const entries = config.packages.filter((p) => p.profiles.includes(PROFILE));

// Any lookup failure aborts the run, so a flaky API never overwrites good content.
const rows = await Promise.all(
  entries.map(async (entry) => ({ entry, ...(await lookup(entry)) })),
);

let counter = 0; // index style numbers rows continuously across groups

function renderGroup(group, inGroup) {
  if (STYLE === 'index') {
    return [
      `### ${group.title ?? capitalise(group.id)}`,
      '',
      '| # | Project | Latest | Shipped | What it is |',
      '| :-- | :-- | :-- | :-- | :-- |',
      ...inGroup.map(
        ({ entry, version, shipped }) =>
          `| ${pad2(++counter)} | [**${entry.label}** ↗](${linkFor(entry)}) | \`${version}\` | ${day(shipped)} | ${entry.desc} |`,
      ),
    ].join('\n');
  }
  return [
    '```console',
    `$ ${group.cmd}`,
    '```',
    '',
    '| Project | Latest | Shipped | What it is |',
    '| :-- | :-- | :-- | :-- |',
    ...inGroup.map(
      ({ entry, version, shipped }) =>
        `| [\`${entry.label}\`](${linkFor(entry)}) | \`${version}\` | ${day(shipped)} | ${entry.desc} |`,
    ),
  ].join('\n');
}

const tables = groups
  .map((group) => {
    const inGroup = rows.filter((r) => (r.entry.group ?? groups[0].id) === group.id);
    return inGroup.length ? renderGroup(group, inGroup) : null;
  })
  .filter(Boolean)
  .join('\n\n');

const recent = rows
  .filter((r) => r.shippedForReal && r.shipped)
  .sort((a, b) => b.shipped.localeCompare(a.shipped))
  .slice(0, RECENT_SHIPS);

const labelWidth = Math.max(0, ...recent.map((r) => r.entry.label.length)) + 2;
const versionWidth = Math.max(0, ...recent.map((r) => r.version.length)) + 2;
const shippedLines = recent.length
  ? recent.map(
      (r) => `${r.entry.label.padEnd(labelWidth)}${r.version.padEnd(versionWidth)}${day(r.shipped)}`,
    )
  : ['nothing shipped yet'];

// Index style: the README supplies the "Last shipped" heading, so no prompt line here.
const shippedBlock =
  STYLE === 'index'
    ? ['```text', ...shippedLines, '```'].join('\n')
    : ['```console', '$ ./last-shipped', ...shippedLines, '```'].join('\n');

const original = readFileSync(README, 'utf8');
let next = replaceBlock(original, 'PACKAGES', tables);
next = replaceBlock(next, 'SHIPPED', shippedBlock);

if (next === original) {
  console.log(`${README}: already up to date (${PROFILE}, ${STYLE})`);
} else {
  writeFileSync(README, next);
  console.log(`${README}: updated (${PROFILE}, ${STYLE}, ${rows.length} entries)`);
}
