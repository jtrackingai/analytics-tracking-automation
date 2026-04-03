import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function parseFrontmatterName(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return null;
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return null;
  }

  const frontmatter = normalized.slice(4, closingIndex);
  for (const line of frontmatter.split('\n')) {
    if (!line.startsWith('name:')) {
      continue;
    }
    return line.slice('name:'.length).trim();
  }

  return null;
}

function parseFrontmatterValue(markdown, key) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return null;
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return null;
  }

  const frontmatter = normalized.slice(4, closingIndex);
  for (const line of frontmatter.split('\n')) {
    if (!line.startsWith(`${key}:`)) {
      continue;
    }
    return line.slice(`${key}:`.length).trim();
  }

  return null;
}

test('skill manifest stays aligned with skill docs and metadata', () => {
  const manifest = readJson('skills/manifest.json');
  const docsSkillMap = readText('docs/skills.md');

  for (const bundle of manifest.bundles) {
    const skillContent = readText(bundle.skillFile);
    const metadataContent = readText(bundle.metadataFile);

    assert.equal(parseFrontmatterName(skillContent), bundle.name, `${bundle.skillFile} frontmatter name should match manifest.`);
    assert.match(
      parseFrontmatterValue(skillContent, 'description') || '',
      /^Use when /,
      `${bundle.skillFile} description should stay trigger-oriented and start with "Use when ".`,
    );
    assert.match(docsSkillMap, new RegExp(`\\\`${bundle.name}\\\``), `docs/skills.md should mention ${bundle.name}.`);
    assert.ok(!('generatedFiles' in bundle), `${bundle.name} should now ship runtime references directly from source instead of generatedFiles transforms.`);

    if (bundle.kind === 'phase') {
      assert.match(skillContent, /^## Stop Boundary$/m, `${bundle.skillFile} should declare a Stop Boundary section.`);
    }

    assert.match(metadataContent, /display_name:/, `${bundle.metadataFile} should declare display_name.`);
    assert.match(metadataContent, /short_description:/, `${bundle.metadataFile} should declare short_description.`);
    assert.match(metadataContent, /default_prompt:/, `${bundle.metadataFile} should declare default_prompt.`);
    assert.match(
      metadataContent,
      new RegExp(`\\$${bundle.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `${bundle.metadataFile} default prompt should reference $${bundle.name}.`,
    );
  }
});

test('umbrella skill keeps Shopify handoff and phase routing rules explicit', () => {
  const rootSkill = readText('SKILL.md');
  const architectureRef = readText('references/architecture.md');
  const skillMapRef = readText('references/skill-map.md');

  assert.match(rootSkill, /## Routing Rules/, 'Root skill should keep routing rules explicit.');
  assert.match(rootSkill, /track(?:ing)?-shopify|`tracking-shopify`/, 'Root skill should mention the Shopify phase skill.');
  assert.match(rootSkill, /Do not continue past the phase boundary the user asked for\./, 'Root skill should keep a phase stop rule.');
  assert.match(rootSkill, /Use `\.\/event-tracking status <artifact-dir-or-file>` whenever the current checkpoint or next step is unclear\./, 'Root skill should keep the status entry point visible.');
  assert.match(rootSkill, /\[skill-map\.md\]\(references\/skill-map\.md\)/, 'Root skill should reference the install-shaped skill map path directly.');
  assert.match(rootSkill, /\[architecture\.md\]\(references\/architecture\.md\)/, 'Root skill should reference the install-shaped architecture path directly.');
  assert.match(architectureRef, /\[\.\.\/SKILL\.md\]\(\.\.\/SKILL\.md\)/, 'The runtime architecture reference should link to the root skill with bundle-safe relative paths.');
  assert.match(skillMapRef, /# Skill Map Reference/, 'The runtime skill-map reference should exist in source.');
});

test('Shopify phase skill owns the Shopify-specific branch contract', () => {
  const shopifySkill = readText('skills/tracking-shopify/SKILL.md');

  assert.match(shopifySkill, /Use this skill as the Shopify-specific branch contract after platform detection\./);
  assert.match(shopifySkill, /Use `tracking-discover` and `tracking-group` for those phases\./, 'Shopify skill should preserve shared early stages.');
  assert.match(shopifySkill, /Do not force the generic preview path on a Shopify run\./, 'Shopify skill should keep the Shopify verification boundary explicit.');
});

test('Codex install docs cover both copy and link workflows', () => {
  const codexGuide = readText('docs/README.codex.md');
  const bootstrapNote = readText('.codex/INSTALL.md');
  const readme = readText('README.md');

  assert.match(codexGuide, /--mode link/, 'Codex guide should document link mode.');
  assert.match(codexGuide, /npm run export:skills/, 'Codex guide should explain how linked installs refresh.');
  assert.match(bootstrapNote, /\.\/setup --install-skills/, '.codex bootstrap note should expose the setup entry point.');
  assert.match(readme, /\[docs\/README\.codex\.md\]\(docs\/README\.codex\.md\)/, 'README should link to the Codex guide.');
});
