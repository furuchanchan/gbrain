import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';

/**
 * #5756 — operator-supplied extract_atoms system prompt.
 *
 * The phase applies one hardcoded virality-shaped prompt to every
 * extractable page. On pages whose value is their exact wording
 * (statutes, contracts, standards, policies) that objective rewrites
 * qualifiers into defects — measured 7/44 broken atoms on the reporter's
 * legal corpus vs 9/9 correct on analytical prose.
 *
 * `cycle.extract_atoms.prompt_file` names a UTF-8 file whose entire
 * contents REPLACE the built-in prompt (the operator owns the atoms JSON
 * contract — title/atom_type/body — the response schema still enforces
 * it). `~` expands to the home directory; a relative path resolves
 * against `brainDir` (the caller's brain root) or the process cwd.
 *
 * Fail-open with a loud warn: an unreadable or empty file falls back to
 * the built-in prompt rather than aborting the whole cycle — the warn
 * (stderr + the `prompt_source` result detail) is what tells the
 * operator their adaptation silently stopped applying.
 */
export interface ResolvedAtomsPrompt {
  /** The configured file's contents, or null to use the built-in prompt. */
  prompt: string | null;
  /** Where the effective prompt came from — surfaced in result details. */
  source: 'default' | 'file';
  /** The configured path when one was read successfully (for printouts). */
  path?: string;
}

const PROMPT_FILE_CONFIG_KEY = 'cycle.extract_atoms.prompt_file';
/** A prompt larger than this is a misconfiguration, not a system prompt. */
const MAX_PROMPT_FILE_BYTES = 256 * 1024;

export async function resolveExtractAtomsPrompt(
  engine: BrainEngine,
  brainDir?: string,
): Promise<ResolvedAtomsPrompt> {
  let configured: string | null = null;
  try {
    configured = await engine.getConfig?.(PROMPT_FILE_CONFIG_KEY) ?? null;
  } catch {
    configured = null;
  }
  const trimmed = configured?.trim() ?? '';
  if (trimmed === '') return { prompt: null, source: 'default' };

  const expanded = trimmed.startsWith('~')
    ? trimmed.replace(/^~(?=$|[\\/])/, homedir())
    : trimmed;
  const path = isAbsolute(expanded)
    ? expanded
    : resolve(brainDir ?? process.cwd(), expanded);

  const warn = (msg: string) => process.stderr.write(
    `[extract_atoms] WARN: ignoring ${PROMPT_FILE_CONFIG_KEY}=${JSON.stringify(trimmed)} — ${msg}; using the built-in prompt\n`,
  );

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    warn(`file unreadable (${err instanceof Error ? err.message : String(err)})`);
    return { prompt: null, source: 'default' };
  }
  if (text.length > MAX_PROMPT_FILE_BYTES) {
    warn(`file exceeds ${MAX_PROMPT_FILE_BYTES} bytes`);
    return { prompt: null, source: 'default' };
  }
  if (text.trim() === '') {
    warn('file is empty');
    return { prompt: null, source: 'default' };
  }
  return { prompt: text, source: 'file', path };
}
