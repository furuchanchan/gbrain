/**
 * #5892 — the AI SDK's one-time warning banner goes to stdout via
 * console.info, so `gbrain query --json` emitted a non-JSON first line
 * whenever a claude-cli (LanguageModelV2) model ran. The CLI installs
 * globalThis.AI_SDK_LOG_WARNINGS as a function so the SDK hands the
 * warnings to us; we forward them to stderr and nothing reaches stdout.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { installAiSdkWarningLogger } from '../src/core/console-prefix.ts';

const KEY = 'AI_SDK_LOG_WARNINGS';

let stderrLines: string[];
let stdoutLines: string[];
let origError: typeof console.error;
let origLog: typeof console.log;
let origInfo: typeof console.info;
let origGlobal: unknown;

beforeEach(() => {
  origGlobal = (globalThis as Record<string, unknown>)[KEY];
  delete (globalThis as Record<string, unknown>)[KEY];
  stderrLines = [];
  stdoutLines = [];
  origError = console.error;
  origLog = console.log;
  origInfo = console.info;
  console.error = (...args: unknown[]) => { stderrLines.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { stdoutLines.push(args.map(String).join(' ')); };
  console.info = (...args: unknown[]) => { stdoutLines.push(args.map(String).join(' ')); };
});

afterEach(() => {
  console.error = origError;
  console.log = origLog;
  console.info = origInfo;
  if (origGlobal === undefined) delete (globalThis as Record<string, unknown>)[KEY];
  else (globalThis as Record<string, unknown>)[KEY] = origGlobal;
});

describe('installAiSdkWarningLogger (#5892)', () => {
  test('installs a function logger when unset', () => {
    installAiSdkWarningLogger();
    expect(typeof (globalThis as Record<string, unknown>)[KEY]).toBe('function');
  });

  test('warnings go to stderr; nothing reaches stdout (no banner)', () => {
    installAiSdkWarningLogger();
    const logger = (globalThis as Record<string, unknown>)[KEY] as (o: unknown) => void;
    logger({
      warnings: [{ type: 'compatibility', feature: 'LanguageModelV2', details: 'wrapped' }],
      provider: 'claude-cli',
      model: 'claude-cli:sonnet',
    });
    expect(stdoutLines.join('')).toBe('');
    const err = stderrLines.join('');
    expect(err).toContain('AI SDK Warning');
    expect(err).toContain('compatibility mode');
    expect(err).toContain('LanguageModelV2');
  });

  test('an operator-set false (opt-out) is never clobbered', () => {
    (globalThis as Record<string, unknown>)[KEY] = false;
    installAiSdkWarningLogger();
    expect((globalThis as Record<string, unknown>)[KEY]).toBe(false);
  });

  test('an operator-set custom logger is never clobbered', () => {
    const custom = () => {};
    (globalThis as Record<string, unknown>)[KEY] = custom;
    installAiSdkWarningLogger();
    expect((globalThis as Record<string, unknown>)[KEY]).toBe(custom);
  });
});
