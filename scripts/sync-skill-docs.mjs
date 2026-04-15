#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'skills', 'contract.json'), 'utf8'));

function replaceSection(content, marker, generatedContent) {
  const startMarker = `<!-- contract-generated:${marker}:start -->`;
  const endMarker = `<!-- contract-generated:${marker}:end -->`;
  const pattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`);

  if (!pattern.test(content)) {
    throw new Error(`Missing generated section markers for ${marker}.`);
  }

  return content.replace(pattern, `${startMarker}\n${generatedContent}\n${endMarker}`);
}

function renderRuntimeSkillMap() {
  const rows = [
    '| Skill | Role | Use When | Typical Stop Point |',
    '| --- | --- | --- | --- |',
    '| `analytics-tracking-automation` | umbrella workflow router | the request is end-to-end, ambiguous, or spans multiple phases | whichever checkpoint matches the user intent |',
  ];

  for (const [phaseName, phase] of Object.entries(contract.phases)) {
    rows.push(`| \`${phaseName}\` | ${phase.role} | ${phase.runtimeUseWhen} | ${phase.typicalStopPoint} |`);
  }

  return rows.join('\n');
}

function renderRuntimeBoundaries() {
  const lines = [];

  for (const [phaseName, phase] of Object.entries(contract.phases)) {
    lines.push(`\`${phaseName}\` ${phaseName === 'tracking-shopify' ? 'modifies:' : 'owns:'}`);
    lines.push('');
    for (const commandName of phase.ownedCommands) {
      lines.push(`- \`${commandName}\``);
    }
    if (phaseName === 'tracking-discover') {
      lines.push('- bootstrap artifact directory');
      lines.push('- crawl summary and platform detection');
    }
    if (phaseName === 'tracking-group') {
      lines.push('- editing `pageGroups`');
      lines.push('- page-group review');
    }
    if (phaseName === 'tracking-live-gtm') {
      lines.push('- public live GTM runtime comparison');
      lines.push('- primary comparison container selection');
    }
    if (phaseName === 'tracking-schema') {
      lines.push('- schema authoring and validation');
    }
    if (phaseName === 'tracking-sync') {
      lines.push('- custom-dimension gate');
    }
    if (phaseName === 'tracking-verify') {
      lines.push('- preview report interpretation');
      lines.push('- optional publish transition when the user explicitly wants to go live');
    }
    if (phaseName === 'tracking-shopify') {
      lines.push('- schema bootstrap expectations');
      lines.push('- sync outputs');
      lines.push('- verification path');
      lines.push('- post-branch handoff rules once the platform is confirmed as Shopify');
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderUserSkillMap() {
  const rows = [
    '| Skill | Best For | What The User Usually Says |',
    '| --- | --- | --- |',
    '| `analytics-tracking-automation` | end-to-end routing | "Help me set up or review tracking for this site" |',
  ];

  for (const [phaseName, phase] of Object.entries(contract.phases)) {
    rows.push(`| \`${phaseName}\` | ${phase.userFacingBestFor} | "${phase.userTypicalSay}" |`);
  }

  return rows.join('\n');
}

function syncFile(relativePath, replacements, checkOnly) {
  const fullPath = path.join(repoRoot, relativePath);
  let content = fs.readFileSync(fullPath, 'utf8');
  let updated = content;

  for (const [marker, generatedContent] of replacements) {
    updated = replaceSection(updated, marker, generatedContent);
  }

  if (checkOnly) {
    if (updated !== content) {
      throw new Error(`${relativePath} is out of sync with skills/contract.json. Run node scripts/sync-skill-docs.mjs.`);
    }
    return;
  }

  if (updated !== content) {
    fs.writeFileSync(fullPath, updated);
  }
}

const checkOnly = process.argv.includes('--check');

syncFile('references/skill-map.md', [
  ['runtime-skill-map', renderRuntimeSkillMap()],
  ['runtime-boundaries', renderRuntimeBoundaries()],
], checkOnly);

syncFile('docs/skills.md', [
  ['user-skill-map', renderUserSkillMap()],
], checkOnly);

if (!checkOnly) {
  console.log('Synchronized skill docs from skills/contract.json');
}
