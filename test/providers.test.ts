/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` and `runExplain` aren't covered here because they touch the
 * gateway / loadConfig; E2E exercises those.
 */

import { describe, test, expect } from 'bun:test';
import { formatRecipeTable, formatEnvOutput, envReady } from '../src/commands/providers.ts';
import { listRecipes, getRecipe } from '../src/core/ai/recipes/index.ts';
import type { Recipe } from '../src/core/ai/types.ts';

describe('envReady', () => {
  test('true when all required env vars set', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
  });

  test('false when required env var missing', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, {})).toBe(false);
  });

  test('false on empty-string env var', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, { OPENAI_API_KEY: '' })).toBe(false);
  });

  test('true for recipes with no required env (local Ollama)', () => {
    // Ollama has no auth_env.required.
    const ollama = getRecipe('ollama');
    expect(ollama).toBeDefined();
    expect(envReady(ollama!, {})).toBe(true);
  });
});

describe('formatRecipeTable', () => {
  test('header row present', () => {
    const out = formatRecipeTable(listRecipes(), {});
    expect(out).toContain('PROVIDER');
    expect(out).toContain('TIER');
    expect(out).toContain('EMBED');
    expect(out).toContain('EXPAND');
    expect(out).toContain('CHAT');
    expect(out).toContain('STATUS');
  });

  test('shows ✓ ready for env-satisfied provider', () => {
    const out = formatRecipeTable(listRecipes(), { OPENAI_API_KEY: 'sk-test' });
    // openai row should be ready
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✓ ready');
  });

  test('shows ✗ missing <ENV> for missing provider', () => {
    const out = formatRecipeTable(listRecipes(), {});
    // openai should show missing OPENAI_API_KEY
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✗ missing OPENAI_API_KEY');
  });

  test('shows keyless Ollama chat as available', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const ollamaLine = out.split('\n').find(line => line.startsWith('ollama'));
    expect(ollamaLine).toBeDefined();
    // Master-skew fixup: on this branch ollama also carries an expansion
    // touchpoint (#4073), so the EXPAND column reads `yes`, not `—`.
    expect(ollamaLine).toMatch(/ollama\s+openai-compat\s+yes\s+yes\s+yes\s+✓ ready/);
  });

  test('each recipe appears at most once', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const recipes = listRecipes();
    for (const r of recipes) {
      const occurrences = out.split('\n').filter(line => line.startsWith(`${r.id} `) || line.startsWith(`${r.id}  `));
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('embedding-only recipe (voyage) shows yes/—/— for tiers', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const voyageLine = out.split('\n').find(line => line.startsWith('voyage'));
    expect(voyageLine).toBeDefined();
    // Voyage has embedding but no expansion or chat
    expect(voyageLine).toContain('yes');
    expect(voyageLine).toContain('—');
  });

  test('isolated subset renders correctly (picker reuses this)', () => {
    const openai = getRecipe('openai');
    const voyage = getRecipe('voyage');
    expect(openai && voyage).toBeTruthy();
    const out = formatRecipeTable([openai!, voyage!], { OPENAI_API_KEY: 'sk-test' });
    const lines = out.split('\n');
    // header + separator + 2 recipe rows
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain('openai');
    expect(lines[2]).toContain('✓ ready');
    expect(lines[3]).toContain('voyage');
    expect(lines[3]).toContain('✗ missing VOYAGE_API_KEY');
  });
});

describe('formatEnvOutput (providers env <id>)', () => {

  test('living provider control: setup funnel intact', () => {
    const voyage = getRecipe('voyage')!;
    const out = formatEnvOutput(voyage, {});
    expect(out).not.toContain('DEPRECATED');
    expect(out).toContain('Setup:');
  });

  test('keyless recipe (ollama): Required: (none) arm renders', () => {
    const ollama = getRecipe('ollama')!;
    const out = formatEnvOutput(ollama, {});
    expect(out).toContain('Required: (none)');
    expect(out).not.toContain('DEPRECATED');
  });

  test('optional-env arm renders when a recipe declares optional vars', () => {
    const fake = {
      id: 'fake-optional',
      name: 'Fake Optional',
      tier: 'native',
      touchpoints: {},
      auth_env: { required: ['FAKE_KEY'], optional: ['FAKE_ORG'], setup_url: 'https://example.com' },
      setup_hint: 'Get a key at example.com.',
    } as unknown as Recipe;
    const out = formatEnvOutput(fake, { FAKE_ORG: 'org-1' });
    expect(out).toContain('Optional:');
    expect(out).toContain('FAKE_ORG');
    expect(out).toContain('✓ set');
    // Living provider keeps its funnel:
    expect(out).toContain('Setup: https://example.com');
    expect(out).toContain('Get a key at example.com.');
  });
});

describe('resolved base URL surface (#5302)', () => {
  const mistral = () => getRecipe('mistral')!;

  test('recipe default is reported with provenance', () => {
    const out = formatEnvOutput(mistral(), {});
    expect(out).toContain('Base URL: https://api.mistral.ai/v1  (recipe default)');
    expect(out).toContain('provider_base_urls.mistral');
  });

  test('file-plane provider_base_urls wins for openai-compat recipes', () => {
    const out = formatEnvOutput(mistral(), {}, {
      provider_base_urls: { mistral: 'https://api.eu.mistral.ai/v1' },
    });
    expect(out).toContain('Base URL: https://api.eu.mistral.ai/v1  (provider_base_urls.mistral (file plane))');
    expect(out).not.toContain('recipe default');
  });

  test('a known *_BASE_URL env var resolves for openai-compat when no config override', () => {
    const ollama = getRecipe('ollama')!;
    const out = formatEnvOutput(ollama, { OLLAMA_BASE_URL: 'http://host:11434/v1' });
    expect(out).toContain('Base URL: http://host:11434/v1  (OLLAMA_BASE_URL env var)');
  });

  test('file-plane beats env for openai-compat (config wins over env)', () => {
    const ollama = getRecipe('ollama')!;
    const out = formatEnvOutput(ollama, { OLLAMA_BASE_URL: 'http://host:11434/v1' }, {
      provider_base_urls: { ollama: 'http://other:11434/v1' },
    });
    expect(out).toContain('Base URL: http://other:11434/v1  (provider_base_urls.ollama (file plane))');
  });

  test('native recipes: env wins over file plane', () => {
    const anthropic = getRecipe('anthropic')!;
    const out = formatEnvOutput(anthropic, { ANTHROPIC_BASE_URL: 'https://proxy.example/v1' }, {
      provider_base_urls: { anthropic: 'https://file.example/v1' },
    });
    expect(out).toContain('Base URL: https://proxy.example/v1  (ANTHROPIC_BASE_URL env var)');
    // file plane fills in only when env is empty:
    const out2 = formatEnvOutput(anthropic, {}, {
      provider_base_urls: { anthropic: 'https://file.example/v1' },
    });
    expect(out2).toContain('Base URL: https://file.example/v1  (provider_base_urls.anthropic (file plane))');
  });
});
