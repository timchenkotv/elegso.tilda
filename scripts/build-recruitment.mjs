#!/usr/bin/env node
/** Static, separately themed recruitment pages; no ERP/CMS writes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRecruitingPage } from './recruitment-renderer.mjs';
import { loadPrivacyBuild, applyPrivacyAnalytics } from './privacy-analytics.mjs';

export function validateRecruitment(data) {
  if (data.version !== 1 || !Array.isArray(data.pages) || data.pages.filter(p => p.kind === 'hub').length !== 1) throw Error('One recruitment hub is required');
  const seen = new Set();
  for (const page of data.pages) {
    if (!/^\/recruitment\/(?:[a-z][a-z-]*\/)?$/.test(page.route) || seen.has(page.route)) throw Error('Unsafe or duplicate recruitment route');
    seen.add(page.route);
    if (!page.h1 || !page.title || !page.description || !page.lead || !page.intro?.paragraphs?.length || !page.criteria?.length || !page.sections?.length || !page.faq?.length) throw Error('Incomplete recruitment page ' + page.route);
    const ids = new Set(['main', 'specialisations', 'approach', 'process', 'prices', 'questions', 'contact']);
    for (const section of page.sections) {
      if (!/^[a-z][a-z0-9-]*$/.test(section.id) || ids.has(section.id) || !section.paragraphs?.length) throw Error('Invalid recruitment section');
      ids.add(section.id);
    }
  }
  if (data.pages.find(p => p.kind === 'hub').route !== '/recruitment/') throw Error('Unexpected recruitment hub URL');
  if (!Array.isArray(data.plans) || data.plans.length !== 3) throw Error('Three pricing plans required');
  const plans = new Set();
  for (const plan of data.plans) {
    if (!/^[a-z][a-z-]*$/.test(plan.id) || plans.has(plan.id) || !Number.isFinite(plan.percent) || plan.percent <= 0 || plan.percent > 100 || !Number.isFinite(plan.minFee) || plan.minFee < 0 || !Number.isInteger(plan.guaranteeDays) || plan.guaranteeDays <= 0) throw Error('Invalid recruitment pricing');
    plans.add(plan.id);
  }
  if (!(data.linear?.price > 0) || !(data.linear.guaranteeDays > 0)) throw Error('Invalid frontline pricing');
  return data;
}

export async function buildRecruitment(root) {
  const data = validateRecruitment(JSON.parse(await fs.readFile(path.join(root, 'content/recruitment-pages.json'), 'utf8')));
  const privacy = await loadPrivacyBuild(root);
  for (const page of data.pages) {
    const file = path.join(root, 'www', page.route, 'index.html');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, applyPrivacyAnalytics(renderRecruitingPage(page, data), privacy));
  }
  return data.pages.map(p => p.route);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.indexOf('--root');
  const root = path.resolve(arg < 0 ? path.join(import.meta.dirname, '..') : process.argv[arg + 1]);
  console.log(JSON.stringify({ recruitment: await buildRecruitment(root) }));
}
