import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXPORT_PROFILE_CLAWHUB,
  EXPORT_PROFILE_PORTABLE,
  getCopiedDirectoriesForProfile,
  listExpectedExportedFiles,
  loadSourceSkillManifest,
  normalizeSkillContent,
} from '../scripts/skill-bundles.mjs';

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
      assert.match(skillContent, /^## Closeout Style$/m, `${bundle.skillFile} should declare a Closeout Style section.`);
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

  assert.match(rootSkill, /## Conversation Intake/, 'Root skill should define a conversation-first intake section for chat entry.');
  assert.match(rootSkill, /Do not ask the user to choose between `scenario` and `analyze`\./, 'Root skill should keep intent routing separate from command selection.');
  assert.match(rootSkill, /## Routing Rules/, 'Root skill should keep routing rules explicit.');
  assert.match(rootSkill, /track(?:ing)?-shopify|`tracking-shopify`/, 'Root skill should mention the Shopify phase skill.');
  assert.match(rootSkill, /Do not continue past the phase boundary the user asked for\./, 'Root skill should keep a phase stop rule.');
  assert.match(rootSkill, /Use `\.\/event-tracking status <artifact-dir-or-file>` whenever the current checkpoint or next step is unclear\./, 'Root skill should keep the status entry point visible.');
  assert.match(rootSkill, /\[skill-map\.md\]\(references\/skill-map\.md\)/, 'Root skill should reference the install-shaped skill map path directly.');
  assert.match(rootSkill, /\[architecture\.md\]\(references\/architecture\.md\)/, 'Root skill should reference the install-shaped architecture path directly.');
  assert.match(architectureRef, /\[\.\.\/SKILL\.md\]\(\.\.\/SKILL\.md\)/, 'The runtime architecture reference should link to the root skill with bundle-safe relative paths.');
  assert.match(skillMapRef, /# Skill Map Reference/, 'The runtime skill-map reference should exist in source.');
});

test('root skill metadata and docs keep conversation-first routing explicit', () => {
  const metadata = readText('agents/openai.yaml');
  const readme = readText('README.md');
  const docsSkillMap = readText('docs/skills.md');

  assert.match(metadata, /new setup/i, 'Root skill metadata should mention new setup intake.');
  assert.match(metadata, /analysis-only request/i, 'Root skill metadata should mention analysis-only intake.');
  assert.match(readme, /The intended experience is simple: tell your agent what you want in plain language\./, 'README should keep the user-facing experience conversation-first.');
  assert.match(readme, /Example Prompts/, 'README should show prompt-oriented quick start examples.');
  assert.match(docsSkillMap, /first-turn conversational intake/i, 'docs\\/skills.md should describe conversation-first routing for the root skill.');
  assert.match(docsSkillMap, /answer-first summaries/i, 'docs\\/skills.md should document answer-first closeout style.');
});

test('Shopify phase skill owns the Shopify-specific branch contract', () => {
  const shopifySkill = readText('skills/tracking-shopify/SKILL.md');

  assert.match(shopifySkill, /Use this skill as the Shopify-specific branch contract after platform detection\./);
  assert.match(shopifySkill, /Use `tracking-discover` and `tracking-group` for those phases\./, 'Shopify skill should preserve shared early stages.');
  assert.match(shopifySkill, /Do not force the generic preview path on a Shopify run\./, 'Shopify skill should keep the Shopify verification boundary explicit.');
});

test('Shared install docs cover the default minimal install and optional phase installs', () => {
  const genericGuide = readText('docs/README.install.md');
  const readme = readText('README.md');

  assert.match(genericGuide, /Agent Install Guide/, 'A shared agent install guide should exist.');
  assert.match(genericGuide, /--target-dir \/path\/to\/agent\/skills/, 'The shared guide should explain portable target-dir installs.');
  assert.match(genericGuide, /--with-phases/, 'The shared guide should show how to install the full phase family explicitly.');
  assert.match(genericGuide, /cloned this repository locally|local checkout/, 'The shared guide should make the local-checkout prerequisite explicit.');
  assert.match(genericGuide, /auto-update/i, 'The shared guide should explain auto-update behavior.');
  assert.match(readme, /\[docs\/README\.install\.md\]\(docs\/README\.install\.md\)/, 'README should link to the shared install guide.');
  assert.match(readme, /Most users only need the umbrella skill\./, 'README should keep the default install path minimal and explicit.');
  assert.match(readme, /If you do not want to clone the repository, install the root skill directly:/, 'README should distinguish the no-clone path from the repo-based installer path.');
  assert.match(readme, /\[DEVELOPING\.md\]\(DEVELOPING\.md\)/, 'README should route repo-local CLI and maintainer setup to DEVELOPING.md.');
  assert.doesNotMatch(readme, /## Advanced Commands/, 'README should no longer foreground CLI-heavy command inventory.');
  assert.doesNotMatch(readme, /## Workflow/, 'README should no longer read like the internal workflow contract.');
});

test('portable and ClawHub export profiles keep different packaging boundaries', () => {
  const manifest = loadSourceSkillManifest(repoRoot);
  const rootBundle = manifest.bundles.find(bundle => bundle.name === 'event-tracking-skill');

  assert.ok(rootBundle, 'Source manifest should include the umbrella skill bundle.');
  assert.ok(
    getCopiedDirectoriesForProfile(rootBundle, EXPORT_PROFILE_PORTABLE).some(entry => entry.target === 'runtime'),
    'Portable exports should keep the runtime directory.',
  );
  assert.ok(
    getCopiedDirectoriesForProfile(rootBundle, EXPORT_PROFILE_CLAWHUB).every(entry => entry.target !== 'runtime'),
    'ClawHub exports should omit the runtime directory.',
  );

  const portableSkill = normalizeSkillContent(rootBundle, readText(rootBundle.skillFile), { profile: EXPORT_PROFILE_PORTABLE });
  const clawhubSkill = normalizeSkillContent(rootBundle, readText(rootBundle.skillFile), { profile: EXPORT_PROFILE_CLAWHUB });

  assert.match(portableSkill, /## Auto-Update/, 'Portable exports should keep the Auto-Update bootstrap.');
  assert.doesNotMatch(clawhubSkill, /## Auto-Update/, 'ClawHub exports should strip the Auto-Update bootstrap.');
  assert.match(clawhubSkill, /compatibility:/, 'ClawHub exports should preserve compatibility frontmatter.');

  const portableFiles = listExpectedExportedFiles(repoRoot, manifest, { profile: EXPORT_PROFILE_PORTABLE });
  const clawhubFiles = listExpectedExportedFiles(repoRoot, manifest, { profile: EXPORT_PROFILE_CLAWHUB });

  assert.ok(
    portableFiles.some(relativePath => relativePath.endsWith('runtime/skill-runtime/update-check.mjs')),
    'Portable exports should include the updater runtime.',
  );
  assert.ok(
    clawhubFiles.every(relativePath => !relativePath.includes('/runtime/')),
    'ClawHub exports should not include runtime files.',
  );
  assert.ok(
    clawhubFiles.some(relativePath => relativePath.startsWith('dist/clawhub-skill-bundles/event-tracking-skill/')),
    'ClawHub exports should use the dedicated publish directory.',
  );
});
