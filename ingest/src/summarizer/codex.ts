// Local Codex CLI writer. Licensed source text is passed on stdin; the process runs
// read-only in an OS temp directory and its final message is parsed as a draft.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, ProviderError } from './gemini.ts';
import { parseJsonLoose } from './groq.ts';
import type { Summarizer, SummarizeInput, SummaryDraft } from '../types.ts';

type Spawn = typeof nodeSpawn;
let active = 0;
const MAX_ACTIVE = 2;

export function createCodexSummarizer(opts: { exe: string; spawnImpl?: Spawn; timeoutMs?: number }): Summarizer {
  const spawn = opts.spawnImpl ?? nodeSpawn;
  return {
    name: 'codex', usesAi: true, model: 'codex-cli', dailyCap: 600, minIntervalMs: 0,
    async summarize(input: SummarizeInput): Promise<SummaryDraft> {
      if (active >= MAX_ACTIVE) throw new ProviderError('codex: concurrency limit reached');
      active++;
      const dir = await mkdtemp(join(tmpdir(), 'element-codex-'));
      const output = join(dir, 'last-message.txt');
      try {
        const prompt = `${buildPrompt(input)}\nReturn ONLY the JSON object.`;
        await new Promise<void>((resolve, reject) => {
          const child = spawn(opts.exe, ['exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-o', output, '-'], {
            cwd: dir, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
          });
          let stderr = '';
          const timer = setTimeout(() => { child.kill(); reject(new ProviderError('codex: timed out')); }, opts.timeoutMs ?? 120_000);
          child.stderr?.on('data', (b: Buffer) => { stderr += b.toString(); });
          child.on('error', (e) => { clearTimeout(timer); reject(new ProviderError(`codex: ${e.message}`)); });
          child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new ProviderError(`codex: exit ${code}: ${stderr.slice(-300)}`)); });
          child.stdin?.end(prompt);
        });
        return parseJsonLoose(await readFile(output, 'utf8')) as SummaryDraft;
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw new ProviderError(`codex: ${(e as Error).message}`);
      } finally { active--; await rm(dir, { recursive: true, force: true }); }
    },
  };
}
