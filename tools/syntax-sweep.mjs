#!/usr/bin/env node
/* Syntax-check every inline <script> block in the given HTML files.
 *
 * Every tool on this site is one hand-authored .html file with its JS inline,
 * and there is no build step to catch a dropped brace. A single missing `});`
 * silently kills an entire page's script — that shipped once (index.html, the
 * whole dashboard) and was caught only because this sweep existed.
 *
 *   node tools/syntax-sweep.mjs *.html          # before every push
 *
 * Exits non-zero if anything fails. Reported line numbers match the HTML file,
 * not the extracted block, because each block is padded with the newlines that
 * preceded it.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
let n = 0, bad = 0;

for (const f of process.argv.slice(2)) {
  const html = readFileSync(f, 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '', code = m[2];
    if (/\bsrc\s*=/.test(attrs)) continue;                                  // external file
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue; // json/template
    if (!code.trim()) continue;
    i++; n++;
    const isMod = /type\s*=\s*["']module["']/i.test(attrs);
    const before = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
    const p = join(dir, `${f.replace(/[^\w]/g, '_')}_${i}.${isMod ? 'mjs' : 'js'}`);
    writeFileSync(p, '\n'.repeat(before) + code);
    try {
      execFileSync(process.execPath, ['--check', p], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      bad++;
      console.log(`FAIL  ${f}  block #${i}${isMod ? ' (module)' : ''}`);
      console.log(String(e.stderr).split('\n').filter(Boolean).slice(0, 6).map(s => '      ' + s).join('\n'));
    }
  }
}
console.log(`\n  ${n} inline script blocks checked · ${bad} failed`);
process.exit(bad ? 1 : 0);
