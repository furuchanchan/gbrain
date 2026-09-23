/**
 * E2E plugin-shape test for `src/openclaw-context-engine.ts`.
 *
 * The 21-test unit suite at `test/context-engine.test.ts` exercises
 * `createGBrainContextEngine` directly — that's the ENGINE, not the PLUGIN.
 * This file tests the plugin discovery + registration path that OpenClaw
 * will actually walk at runtime.
 *
 * Codex outside-voice F1: closes the "we ship a plugin we don't test as a
 * plugin" gap. The brittle SDK-shim approach Codex flagged is avoided —
 * Layer 2 dropped the unnecessary `definePluginEntry` import so the plugin
 * entry has zero build-time dependencies on the OpenClaw SDK. The remaining
 * SDK call (the lazy `buildMemorySystemPromptAddition` resolution inside
 * `assemble()`) is intercepted via `mock.module()` because Bun mocks DO
 * intercept dynamic imports.
 */

import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Intercept the lazy SDK import in core/context-engine so the engine sees a
// mock memory-addition function instead of falling through to the no-runtime
// fallback. Bun's mock.module() runs at module evaluation in source order,
// before the dynamic import inside ensureSdkLoaded() fires.
mock.module('openclaw/plugin-sdk/core', () => ({
  delegateCompactionToRuntime: async () => ({ ok: true, compacted: true, reason: 'mock-runtime' }),
  buildMemorySystemPromptAddition: () => '[mock memory addition]',
}));

import pluginEntry from '../../src/openclaw-context-engine.ts';
import { ENGINE_ID, __resetSdkLoadStateForTests } from '../../src/core/context-engine.ts';

interface PluginEntryShape {
  id: string;
  name: string;
  description: string;
  register: (api: unknown) => void;
}

describe('openclaw-context-engine plugin entry', () => {
  it('default export has the expected plugin-entry shape', () => {
    const entry = pluginEntry as PluginEntryShape;
    expect(entry).toBeDefined();
    expect(entry.id).toBe('gbrain-context-engine');
    expect(entry.name).toBe('GBrain Context Engine');
    expect(typeof entry.description).toBe('string');
    expect(entry.description.length).toBeGreaterThan(0);
    expect(typeof entry.register).toBe('function');
  });

  it('register() wires registerContextEngine with ENGINE_ID and a factory', () => {
    type RegisterCall = { id: string; factory: (ctx: { workspaceDir: string }) => unknown };
    const calls: RegisterCall[] = [];
    const stubApi = {
      registerContextEngine: (id: string, factory: RegisterCall['factory']) => {
        calls.push({ id, factory });
      },
    };

    (pluginEntry as PluginEntryShape).register(stubApi);

    // OpenClaw 2026.9+ resolves the contextEngine slot as both a plugin id
    // and an engine id, so the engine registers under both names (#5343).
    expect(calls).toHaveLength(2);
    expect(calls[0].id).toBe(ENGINE_ID);
    expect(calls[1].id).toBe('gbrain-context-engine');
    expect(typeof calls[0].factory).toBe('function');
    expect(typeof calls[1].factory).toBe('function');
  });

  it('the plugin-id registration reports a matching engine info.id', () => {
    type RegisterCall = { id: string; factory: (ctx: { workspaceDir: string }) => any };
    const calls: RegisterCall[] = [];
    (pluginEntry as PluginEntryShape).register({
      registerContextEngine: (id: string, factory: RegisterCall['factory']) => {
        calls.push({ id, factory });
      },
    });
    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-plugin-id-'));
    try {
      for (const call of calls) {
        expect(call.factory({ workspaceDir: tmp }).info.id).toBe(call.id);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('factory returns a working ContextEngine bound to the workspace', async () => {
    // Reset lazy-load state so this test exercises the mocked SDK path
    // independently of earlier-in-process state.
    __resetSdkLoadStateForTests();

    type RegisterCall = { id: string; factory: (ctx: { workspaceDir: string }) => any };
    const calls: RegisterCall[] = [];
    (pluginEntry as PluginEntryShape).register({
      registerContextEngine: (id: string, factory: RegisterCall['factory']) => {
        calls.push({ id, factory });
      },
    });

    const tmp = mkdtempSync(join(tmpdir(), 'gbrain-plugin-e2e-'));
    try {
      mkdirSync(join(tmp, 'memory'), { recursive: true });
      writeFileSync(join(tmp, 'memory', 'heartbeat-state.json'), '{}');
      writeFileSync(join(tmp, 'memory', 'upcoming-flights.json'), '{}');

      const engine = calls[0].factory({ workspaceDir: tmp });

      expect(engine).toBeDefined();
      expect(engine.info.id).toBe(ENGINE_ID);
      expect(engine.info.ownsCompaction).toBe(false);

      // First method call exercises the full assemble path through the
      // factory-built engine — same code the OpenClaw runtime will hit.
      const result = await engine.assemble({ sessionId: 'plug-e2e', messages: [] });
      expect(result.systemPromptAddition).toContain('Live Context');
      // The mocked memory-addition SDK call lands in the prompt too.
      expect(result.systemPromptAddition).toContain('[mock memory addition]');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
