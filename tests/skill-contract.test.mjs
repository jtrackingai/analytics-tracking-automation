import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function parseCliCommands() {
  const result = spawnSync('./event-tracking', ['--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  assert.equal(result.status, 0, 'Repo-local CLI help should be available after build.');

  const commands = new Set();
  for (const line of (result.stdout || '').split('\n')) {
    const match = /^\s{2}([a-z][a-z0-9-]*)\b/.exec(line);
    if (match) {
      commands.add(match[1]);
    }
  }

  return commands;
}

function detectArtifact(input) {
  const match = /(site-analysis\.json|event-schema\.json|gtm-config\.json|gtm-context\.json)/.exec(input);
  return match ? match[1] : null;
}

function inferIntent(input) {
  const text = input.toLowerCase();

  if (/health audit|repair or rebuild|assessment[, -]?only|assessment only/.test(text)) {
    return 'tracking_health_audit';
  }

  if (/upkeep|what drifted|still healthy|needs repair/.test(text)) {
    return 'upkeep';
  }

  if (/tracking update|update existing tracking|revise|extend|new cta flows/.test(text)) {
    return 'tracking_update';
  }

  if (/analyze only|analysis only|analyze https?:\/\/|analyze this site|inspect this site|stop after site analysis|review current tracking signals/.test(text)) {
    return 'analysis_only';
  }

  if (/resume|continue|existing run|artifact directory|site-analysis\.json|event-schema\.json|gtm-config\.json|gtm-context\.json|\.\/output\//.test(text)) {
    return 'resume_existing_run';
  }

  if (/set up|setup|from scratch|implement tracking|plan ga4|plan gtm/.test(text)) {
    return 'new_setup';
  }

  return 'new_setup';
}

function matchesRequirements(requirements = {}, context = {}) {
  return Object.entries(requirements).every(([key, value]) => context[key] === value);
}

function evaluateRouting(contract, fixture) {
  const context = fixture.context || {};
  const intent = inferIntent(fixture.input);
  const artifact = detectArtifact(fixture.input);

  if (
    context.platformConfirmed === 'shopify'
    && context.sharedEarlyStagesComplete === true
    && context.shopifyBranchRequested === true
  ) {
    const phase = contract.branchOverlays.shopify.phase;
    return {
      intent,
      entryCommand: null,
      phase,
      stopBoundary: contract.phases[phase].stopBoundary,
    };
  }

  if (artifact) {
    for (const route of contract.artifactRoutes) {
      if (route.artifact !== artifact) {
        continue;
      }

      if (!matchesRequirements(route.requires, context)) {
        continue;
      }

      return {
        intent,
        entryCommand: null,
        phase: route.phase,
        stopBoundary: contract.phases[route.phase].stopBoundary,
      };
    }
  }

  if (context.artifactIsDirectory === true) {
    return {
      intent,
      entryCommand: contract.entryIntents.resume_existing_run.preferredEntryCommand,
      phase: null,
      stopBoundary: null,
    };
  }

  const intentContract = contract.entryIntents[intent];
  return {
    intent,
    entryCommand: intentContract.preferredEntryCommand,
    phase: intentContract.defaultPhase,
    stopBoundary: intentContract.defaultPhase ? contract.phases[intentContract.defaultPhase].stopBoundary : null,
  };
}

function matchesRuleClause(clause = {}, context = {}) {
  return Object.entries(clause).every(([key, value]) => context[key] === value);
}

function evaluateStopRule(contract, fixture) {
  for (const rule of contract.stopRules || []) {
    const commandMatch = rule.command === fixture.command || rule.commands?.includes(fixture.command);
    if (!commandMatch) {
      continue;
    }

    const blockedByAll = rule.blockWhen ? matchesRuleClause(rule.blockWhen, fixture.context || {}) : true;
    const blockedByAny = rule.blockWhenAny
      ? rule.blockWhenAny.some(clause => matchesRuleClause(clause, fixture.context || {}))
      : true;
    const blocked = blockedByAll && blockedByAny;

    if (!blocked) {
      continue;
    }

    if (rule.allowOverride && (((fixture.context || {}).overrideUsed === true) || ((fixture.context || {}).userExplicitOverride === true))) {
      continue;
    }

    return {
      blocked: true,
      ruleId: rule.id,
    };
  }

  return {
    blocked: false,
    ruleId: null,
  };
}

function evaluateIntakePolicy(contract, fixture) {
  for (const policy of contract.intakePolicies || []) {
    if (!matchesRequirements(policy.when, fixture.context || {})) {
      continue;
    }

    return {
      action: policy.action,
      intent: policy.intent || null,
    };
  }

  return {
    action: 'route',
    intent: inferIntent(fixture.input),
  };
}

test('skill contract stays aligned with manifest, phase skills, and public docs', () => {
  const contract = readJson('skills/contract.json');
  const manifest = readJson(contract.sourceManifest);
  const docsSkillMap = readText('docs/skills.md');
  const runtimeSkillMap = readText('references/skill-map.md');
  const telemetryConsentRef = readText('references/telemetry-consent.md');
  const rootSkill = readText('SKILL.md');
  const cliCommands = parseCliCommands();

  assert.equal(contract.familyName, contract.umbrellaSkill, 'Contract family name should match the umbrella skill name.');

  const phaseBundles = manifest.bundles.filter(bundle => bundle.kind === 'phase');
  assert.deepEqual(
    Object.keys(contract.phases).sort(),
    phaseBundles.map(bundle => bundle.name).sort(),
    'Contract phases should match shipped phase bundles.',
  );

  for (const [intentName, intentContract] of Object.entries(contract.entryIntents)) {
    assert.match(rootSkill, new RegExp(`\\\`${intentName}\\\``), `Root skill should mention entry intent ${intentName}.`);
    assert.ok(
      intentContract.preferredEntryCommand === null || cliCommands.has(intentContract.preferredEntryCommand),
      `Entry intent ${intentName} should point to a real CLI command.`,
    );
    if (intentContract.defaultPhase) {
      assert.ok(contract.phases[intentContract.defaultPhase], `Entry intent ${intentName} should point to a real phase.`);
    }
  }

  for (const route of contract.artifactRoutes) {
    assert.ok(contract.phases[route.phase], `Artifact route ${route.id} should point to a real phase.`);
  }

  for (const bundle of phaseBundles) {
    const phaseContract = contract.phases[bundle.name];
    const skillContent = readText(bundle.skillFile);

    assert.equal(phaseContract.skillFile, bundle.skillFile, `${bundle.name} contract should point to the shipped skill file.`);
    assert.match(docsSkillMap, new RegExp(`\\\`${bundle.name}\\\``), `docs/skills.md should mention ${bundle.name}.`);
    assert.match(runtimeSkillMap, new RegExp(`\\\`${bundle.name}\\\``), `references/skill-map.md should mention ${bundle.name}.`);
    assert.match(rootSkill, new RegExp(`\\\`${bundle.name}\\\``), `Root skill should mention ${bundle.name}.`);

    for (const commandName of phaseContract.ownedCommands) {
      assert.ok(cliCommands.has(commandName), `${bundle.name} should only own real CLI commands.`);
      assert.match(skillContent, new RegExp(`\\./event-tracking ${commandName}\\b`), `${bundle.skillFile} should mention owned command ${commandName}.`);
    }

    for (const artifactName of phaseContract.requiredOutputs) {
      assert.match(skillContent, new RegExp(`<artifact-dir>/${artifactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${bundle.skillFile} should mention required output ${artifactName}.`);
    }

    for (const artifactName of phaseContract.optionalOutputs) {
      assert.match(skillContent, new RegExp(`<artifact-dir>/${artifactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${bundle.skillFile} should mention optional output ${artifactName}.`);
    }

    if (phaseContract.defaultNextCommand) {
      assert.match(skillContent, new RegExp(`\\./event-tracking ${phaseContract.defaultNextCommand}\\b`), `${bundle.skillFile} should mention default next command ${phaseContract.defaultNextCommand}.`);
    }
  }

  assert.match(telemetryConsentRef, /Required Asking Style/, 'Telemetry consent reference should define the required asking style.');
  assert.match(telemetryConsentRef, /Required Behaviors/, 'Telemetry consent reference should define required behaviors.');
  assert.match(telemetryConsentRef, /Prohibited Behaviors/, 'Telemetry consent reference should define prohibited behaviors.');
});

test('discovery skill inherits telemetry consent wording from the shared reference', () => {
  const discoverySkill = readText('skills/tracking-discover/SKILL.md');

  assert.match(
    discoverySkill,
    /\[\.\.\/\.\.\/references\/telemetry-consent\.md\]\(\.\.\/\.\.\/references\/telemetry-consent\.md\)/,
    'Discovery skill should reference the shared telemetry consent contract.',
  );
  assert.doesNotMatch(
    discoverySkill,
    /stop and ask the user to choose `yes` or `no`\./i,
    'Discovery skill should no longer reduce telemetry consent to a bare yes/no instruction.',
  );
});

test('routing eval fixtures stay aligned with the skill contract', () => {
  const contract = readJson('skills/contract.json');
  const fixtures = readJson('tests/fixtures/skill-routing-evals.json');
  const cliCommands = parseCliCommands();

  for (const fixture of fixtures) {
    const actual = evaluateRouting(contract, fixture);

    assert.ok(contract.entryIntents[fixture.expectedIntent], `${fixture.name} should reference a real entry intent.`);
    if (fixture.expectedEntryCommand) {
      assert.ok(cliCommands.has(fixture.expectedEntryCommand), `${fixture.name} should reference a real CLI entry command.`);
    }
    if (fixture.expectedPhase) {
      assert.ok(contract.phases[fixture.expectedPhase], `${fixture.name} should reference a real phase.`);
    }

    assert.deepEqual(actual, {
      intent: fixture.expectedIntent,
      entryCommand: fixture.expectedEntryCommand,
      phase: fixture.expectedPhase,
      stopBoundary: fixture.expectedStopBoundary,
    }, fixture.name);
  }
});

test('contract keeps explicit checkpoint approval semantics for chat-driven runs', () => {
  const contract = readJson('skills/contract.json');
  const rootSkill = readText('SKILL.md');
  const groupingSkill = readText('skills/tracking-group/SKILL.md');
  const schemaSkill = readText('skills/tracking-schema/SKILL.md');

  assert.equal(
    contract.approvalSemantics?.broadWorkflowRequestsDoNotBypassCheckpoints,
    true,
    'Contract should explicitly state that broad workflow requests do not bypass approval checkpoints.',
  );

  const pageGroupsCheckpoint = contract.approvalSemantics?.checkpoints?.find(item => item.checkpoint === 'pageGroups');
  const schemaCheckpoint = contract.approvalSemantics?.checkpoints?.find(item => item.checkpoint === 'eventSchema');

  assert.equal(
    pageGroupsCheckpoint?.allowAutoYesWithoutCurrentTurnExplicitApproval,
    false,
    'Page-group approval should never be auto-recorded from broad workflow scope alone.',
  );
  assert.equal(
    schemaCheckpoint?.allowAutoYesWithoutCurrentTurnExplicitApproval,
    false,
    'Schema approval should never be auto-recorded from broad workflow scope alone.',
  );

  assert.match(
    rootSkill,
    /A broad request such as "full workflow", "全流程", "end-to-end", or "continue all the way" is scope authorization only\./,
    'Root skill should explicitly forbid treating broad workflow requests as checkpoint approval.',
  );
  assert.match(
    groupingSkill,
    /A broad request such as "full workflow" or "全流程" does not count as page-group approval\./,
    'Grouping skill should explicitly keep page-group approval separate from broad workflow scope.',
  );
  assert.match(
    schemaSkill,
    /a broad request such as "full workflow" or "全流程" does not count as schema approval/,
    'Schema skill should explicitly keep schema approval separate from broad workflow scope.',
  );
});

test('approval semantics fixtures stay aligned with the contract red lines', () => {
  const contract = readJson('skills/contract.json');
  const fixtures = readJson('tests/fixtures/skill-approval-semantics-evals.json');

  for (const fixture of fixtures) {
    const checkpoint = contract.approvalSemantics?.checkpoints?.find(item => item.checkpoint === fixture.checkpoint);
    assert.ok(checkpoint, `${fixture.name} should reference a real approval checkpoint.`);

    const allowAutoApprove = checkpoint.allowAutoYesWithoutCurrentTurnExplicitApproval === true
      || checkpoint.allowAutoSelectionWithoutExplicitIds === true
      || checkpoint.allowAutoPublishWithoutCurrentTurnExplicitApproval === true;

    assert.equal(
      allowAutoApprove,
      fixture.expectedCanAutoApprove,
      `${fixture.name} should preserve the contract boundary that broad workflow scope is not approval.`,
    );
  }
});

test('stop-rule eval fixtures stay aligned with the skill contract', () => {
  const contract = readJson('skills/contract.json');
  const fixtures = readJson('tests/fixtures/skill-stop-rule-evals.json');
  const cliCommands = parseCliCommands();

  for (const rule of contract.stopRules || []) {
    if (rule.command) {
      assert.ok(cliCommands.has(rule.command), `Stop rule ${rule.id} should reference a real CLI command.`);
    }

    for (const commandName of rule.commands || []) {
      assert.ok(cliCommands.has(commandName), `Stop rule ${rule.id} should reference a real CLI command.`);
    }
  }

  for (const fixture of fixtures) {
    assert.ok(cliCommands.has(fixture.command), `${fixture.name} should reference a real CLI command.`);

    const actual = evaluateStopRule(contract, fixture);
    assert.deepEqual(actual, {
      blocked: fixture.expectedBlocked,
      ruleId: fixture.expectedRule,
    }, fixture.name);
  }
});

test('intake policy eval fixtures stay aligned with the skill contract', () => {
  const contract = readJson('skills/contract.json');
  const fixtures = readJson('tests/fixtures/skill-intake-evals.json');

  for (const fixture of fixtures) {
    const actual = evaluateIntakePolicy(contract, fixture);
    assert.deepEqual(actual, {
      action: fixture.expectedAction,
      intent: fixture.expectedIntent,
    }, fixture.name);
  }
});

test('closeout shape fixtures stay aligned with the skill contract', () => {
  const contract = readJson('skills/contract.json');
  const fixtures = readJson('tests/fixtures/skill-closeout-evals.json');
  const docsSkillMap = readText('docs/skills.md');

  for (const fixture of fixtures) {
    const phase = contract.phases[fixture.phase];
    assert.ok(phase, `${fixture.phase} should exist in the skill contract.`);
    assert.deepEqual(phase.closeoutShape, fixture.expectedShape, `${fixture.phase} closeout shape should match fixture.`);

    if (fixture.phase === 'tracking-schema') {
      assert.match(docsSkillMap, /event-plan review/i);
      assert.match(docsSkillMap, /one bounded part of the workflow/i);
    }

    if (fixture.phase === 'tracking-verify') {
      assert.match(docsSkillMap, /preview QA/i);
      assert.match(docsSkillMap, /publish readiness/i);
      assert.match(docsSkillMap, /answer-first summaries/i);
    }
  }
});
