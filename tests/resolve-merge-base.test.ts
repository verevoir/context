import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL('../.github/antagonistic-review/resolve-merge-base.sh', import.meta.url)
);

// Start from process.env (PATH etc.), but strip any repo-pointing git vars the
// runner environment might carry — they would redirect the fixture's git operations.
const {
  GIT_DIR: _d,
  GIT_WORK_TREE: _w,
  GIT_INDEX_FILE: _i,
  GIT_OBJECT_DIRECTORY: _o,
  ...cleanEnv
} = process.env;
const GIT_ENV = {
  ...cleanEnv,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: GIT_ENV, timeout: 20000 });
  return stdout.trim();
}

/** A clone of a local bare origin whose history is the wrong-diff shape the script
 * exists for: feature branched at A, then the base advanced to B. Returns the shas
 * so each test picks the (BASE_REF, BASE_SHA, HEAD_SHA) triple it needs. */
async function repoFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'rmb-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  await run('git', ['init', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  await run('git', ['clone', origin, work], { env: GIT_ENV });
  await writeFile(join(work, 'f'), 'a\n');
  await git(work, 'add', 'f');
  await git(work, 'commit', '-m', 'A');
  const a = await git(work, 'rev-parse', 'HEAD');
  await git(work, 'push', 'origin', 'main');
  await git(work, 'checkout', '-b', 'feature');
  await writeFile(join(work, 'f'), 'a\nfeature\n');
  await git(work, 'commit', '-am', 'C');
  const head = await git(work, 'rev-parse', 'HEAD');
  await git(work, 'checkout', 'main');
  await writeFile(join(work, 'g'), 'b\n');
  await git(work, 'add', 'g');
  await git(work, 'commit', '-m', 'B');
  const b = await git(work, 'rev-parse', 'HEAD');
  await git(work, 'push', 'origin', 'main');
  return { dir, work, a, b, head };
}

async function resolve(
  work: string,
  env: { BASE_REF: string; BASE_SHA: string; HEAD_SHA: string }
): Promise<{ code: number; stdout: string; exported: string }> {
  const githubEnv = join(work, 'github-env');
  await writeFile(githubEnv, '');
  try {
    const { stdout } = await run('bash', [SCRIPT], {
      cwd: work,
      env: { ...GIT_ENV, ...env, GITHUB_ENV: githubEnv },
      timeout: 20000,
    });
    return { code: 0, stdout, exported: await readFile(githubEnv, 'utf8') };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; killed?: boolean; signal?: string };
    // Same discipline as the aggregate harness: a killed subprocess is a hang, not a verdict.
    if (err.killed || err.signal) {
      throw new Error(
        `resolve-merge-base.sh was killed (${err.signal ?? 'timeout'}) — hung, not failed`
      );
    }
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? '',
      exported: await readFile(githubEnv, 'utf8'),
    };
  }
}

describe('resolve-merge-base.sh — the diff range the panel reviews', () => {
  it('resolves against the LIVE base ref, not the frozen event sha', async () => {
    const { dir, work, a, head } = await repoFixture();
    try {
      // BASE_SHA is deliberately set to HEAD: a script that consulted the frozen sha
      // first would compute merge-base(HEAD, HEAD) = HEAD and fail "Nothing to
      // review". Passing proves the live base ref wins.
      const { code, exported } = await resolve(work, {
        BASE_REF: 'main',
        BASE_SHA: head,
        HEAD_SHA: head,
      });
      expect(code).toBe(0);
      expect(exported).toContain(`MERGE_BASE=${a}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the frozen event sha when the base ref is not fetchable', async () => {
    const { dir, work, a, head } = await repoFixture();
    try {
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'deleted-branch',
        BASE_SHA: a,
        HEAD_SHA: head,
      });
      expect(code).toBe(0);
      expect(stdout).toContain('falling back to the frozen event sha');
      expect(exported).toContain(`MERGE_BASE=${a}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the frozen sha when the base ref fetches but shares no history with HEAD', async () => {
    const { dir, work, a, head } = await repoFixture();
    try {
      // an orphan branch on origin: the fetch succeeds, but merge-base(origin/orphan,
      // HEAD) exits non-zero — the FIRST sub-expression's failure, distinct from the
      // unfetchable-ref case
      await git(work, 'checkout', '--orphan', 'orphan');
      await git(work, 'rm', '-rf', '.');
      await writeFile(join(work, 'o'), 'o\n');
      await git(work, 'add', 'o');
      await git(work, 'commit', '-m', 'O');
      await git(work, 'push', 'origin', 'orphan');
      await git(work, 'checkout', 'main');
      const { code, exported } = await resolve(work, {
        BASE_REF: 'orphan',
        BASE_SHA: a,
        HEAD_SHA: head,
      });
      expect(code).toBe(0);
      expect(exported).toContain(`MERGE_BASE=${a}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed via the fallback path when the frozen sha IS the head (empty diff)', async () => {
    const { dir, work, head } = await repoFixture();
    try {
      // unfetchable ref forces the frozen-sha fallback, and BASE_SHA == HEAD_SHA makes
      // the merge base HEAD itself — the vacuous-pass guard must fire on this path too
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'deleted-branch',
        BASE_SHA: head,
        HEAD_SHA: head,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain('Nothing to review');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when neither the live ref nor the frozen sha yields a merge base', async () => {
    const { dir, work, head } = await repoFixture();
    try {
      const bogus = '0123456789abcdef0123456789abcdef01234567';
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'deleted-branch',
        BASE_SHA: bogus,
        HEAD_SHA: head,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain('No merge base');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when HEAD is already contained in the live base ref (empty diff)', async () => {
    const { dir, work, a, b } = await repoFixture();
    try {
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'main',
        BASE_SHA: a,
        HEAD_SHA: b,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain('Nothing to review');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
