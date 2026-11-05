import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shape regression tests for the antagonistic-review workflow. Its behaviour lives
// inline in the YAML rather than in an extractable script, so these pin the text
// shape that must hold — the same zero-dependency approach the other repos use.
const yml = readFileSync(
  fileURLToPath(new URL('../.github/workflows/antagonistic-review.yml', import.meta.url)),
  'utf8'
);
const flat = yml.replace(/\s+/g, ' ');

describe('antagonistic-review.yml — the guardrails corpus checkout', () => {
  it('runs the SHARED script from the pinned reviewer clone, not a local copy', () => {
    // The point of the shared script is that it is pinned with the reviewer and
    // tested once. A copy pasted back into this file, or read from the repo's own
    // tree, would be neither — and the tree one would also be PR-author supplied
    // on a pull_request_target run.
    expect(flat).toMatch(
      /run: bash "\/home\/runner\/\.antagonistic-review-mcp\/scripts\/checkout-corpus\.sh"/
    );
    expect(flat).not.toMatch(/run: bash \.?\/?scripts\/checkout-corpus\.sh/);
  });

  it('runs BEFORE the review step, which is the only ordering that works', () => {
    // The reviewer reads AIGENCY_GUARDRAILS_URL at start-up. A corpus that arrives
    // after it has begun is a corpus it never sees — and the failure is a lens that
    // provisions nothing and auto-REJECTs, which reads as a verdict on the change.
    const corpusAt = yml.indexOf('name: Check out the guardrails corpus');
    const reviewAt = yml.indexOf('name: Adversarial review against the provisioned practices');
    const mcpAt = yml.indexOf('name: Pre-build the reviewer MCP');
    expect(corpusAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(-1);
    // GUARD BEFORE COMPARE. `indexOf` returns -1 when the step is renamed, and
    // `expect(anyFoundPosition).toBeGreaterThan(-1)` is true for every position
    // there is — so without this line the ordering assertion below cannot fail
    // for the one change it exists to catch. Verified by mutation: rename the
    // step and this test fails; delete this line and the same rename passes.
    // The two guards above had it; this one did not.
    expect(mcpAt).toBeGreaterThan(-1);
    // After the MCP pre-build, because the script it runs lives in that clone.
    expect(corpusAt).toBeGreaterThan(mcpAt);
    expect(corpusAt).toBeLessThan(reviewAt);
  });

  it('passes the credential by environment, never in a URL or on argv', () => {
    expect(flat).toMatch(/CORPUS_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
    expect(flat).not.toMatch(/x-access-token:\$\{\{/);
  });

  it('keeps CORPUS_TOKEN OUT of the review step, where a lens with Bash would find it', () => {
    // The corpus step's comment names this as a deliberate property: the
    // credential is scoped to the fetch, and the directory deliberately left
    // behind for the lens to read must not contain a usable one. Nothing pinned
    // it — the test above only asserts the token IS passed by env somewhere, so
    // an edit that also propagated it into the review step's env would have
    // stayed green while handing every lens a live credential.
    const corpusAt = yml.indexOf('name: Check out the guardrails corpus');
    const reviewAt = yml.indexOf('name: Adversarial review against the provisioned practices');
    expect(corpusAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(-1);

    // Exactly one, and it sits inside the corpus step — a second occurrence
    // anywhere, or this one drifting past the review step's start, fails.
    const at = [...yml.matchAll(/^\s*CORPUS_TOKEN:/gm)].map((m) => m.index ?? -1);
    expect(at).toHaveLength(1);
    expect(at[0]).toBeGreaterThan(corpusAt);
    expect(at[0]).toBeLessThan(reviewAt);
  });

  it('points the reviewer at the SAME directory the checkout writes', () => {
    // Two literals that must agree. If they drift, the lens finds no corpus and
    // fails closed — safe, but it reads as a verdict on the change under review
    // rather than on this file, which is the failure mode the panel is worst at
    // making legible.
    const corpusDir = /CORPUS_DIR: (\S+)/.exec(flat)?.[1];
    const guardrailsUrl = /AIGENCY_GUARDRAILS_URL: (\S+)/.exec(flat)?.[1];
    expect(corpusDir).toBeDefined();
    expect(guardrailsUrl).toBe(corpusDir);
  });

  it('keeps every job envelope above the sum of its step timeouts', () => {
    // This repo is why the check exists in this form. Its review job carried a 30m
    // envelope over 43m of steps, justified by a comment that added up "the four
    // biggest" and waved off the rest as fitting "inside the slack". The backstop
    // was the first thing that would have fired, and it names no step. (STDIO-664.)
    const jobs = [...yml.matchAll(/^ {2}([a-z][\w-]*):$/gm)];
    const checked: string[] = [];

    for (const [index, job] of jobs.entries()) {
      const body = yml.slice(job.index, jobs[index + 1]?.index ?? yml.length);
      const envelope = /^ {4}timeout-minutes: (\d+)/m.exec(body);
      const steps = [...body.matchAll(/^ {8}timeout-minutes: (\d+)/gm)].map((m) => Number(m[1]));
      const named = [...body.matchAll(/^ {6}- name:/gm)].length;
      // Fail OPEN on what it cannot decide: a job with no envelope, or one step
      // left unbounded, is not a finding — it is a case with no verdict available.
      if (!envelope || steps.length !== named) continue;

      const sum = steps.reduce((total, step) => total + step, 0);
      expect(
        Number(envelope[1]),
        `job '${job[1]}' envelope must exceed its ${sum}m of steps`
      ).toBeGreaterThan(sum);
      checked.push(job[1]);
    }

    // Otherwise a rename that stops the parse matching leaves this passing vacuously.
    expect(checked).toContain('review');
  });

  it("states the review job's step-timeout budget as a sum that is right", () => {
    // The comment above the review job's envelope is the itemised budget the
    // envelope is checked against by eye. It drifted once already: a step was
    // added without its minutes. Pin that its terms add up to its stated total,
    // that the total is the real sum of the job's step timeouts, and that the
    // envelope sits above it.
    const job = /^ {2}review:$/m.exec(yml);
    expect(job).not.toBeNull();
    const rest = yml.slice(job!.index + 1);
    const next = /^ {2}[a-z][\w-]*:$/m.exec(rest);
    const body = rest.slice(0, next?.index ?? rest.length);

    const comment = [...body.matchAll(/^ {4}# {3}(.*)$/gm)].map((m) => m[1]).join(' ');
    const stated = /= (\d+)m/.exec(comment);
    expect(stated, 'the budget comment names its total').not.toBeNull();
    const terms = [...comment.slice(0, stated!.index).matchAll(/ (\d+)(?= \+| $)/g)].map((m) =>
      Number(m[1])
    );
    expect(terms.length).toBeGreaterThan(0);
    const termSum = terms.reduce((total, n) => total + n, 0);
    expect(termSum, 'the comment terms add up to its total').toBe(Number(stated![1]));

    const steps = [...body.matchAll(/^ {8}timeout-minutes: (\d+)/gm)].map((m) => Number(m[1]));
    expect(steps.length).toBe(terms.length);
    const stepSum = steps.reduce((total, n) => total + n, 0);
    expect(stepSum, "the stated total is the real sum of the job's step timeouts").toBe(termSum);

    const envelope = /^ {4}timeout-minutes: (\d+)/m.exec(body);
    expect(envelope).not.toBeNull();
    expect(Number(envelope![1])).toBeGreaterThan(stepSum);
  });
});

describe('antagonistic-review.yml — the reviewer pin-lag warning', () => {
  // Advisory only. It must stay cheap (one bounded git request, no REST calls
  // against the App installation's shared 5000/hr budget, STDIO-663) and must
  // never fail the review it runs inside.
  const start = yml.indexOf('- name: Warn when the reviewer pin lags a capabilities release');
  const end = start === -1 ? -1 : yml.indexOf('\n      - name:', start + 1);
  const step = start === -1 ? '' : yml.slice(start, end === -1 ? yml.length : end);
  const run = step.slice(step.indexOf('run: |') + 'run: |'.length);

  it('exists, so the assertions below are not vacuous', () => {
    expect(start).toBeGreaterThan(-1);
    expect(step.indexOf('run: |')).toBeGreaterThan(-1);
    expect(run.trim().length).toBeGreaterThan(0);
  });

  it('makes no REST calls', () => {
    expect(step).not.toMatch(/\bgh api\b/);
    expect(step).not.toMatch(/\bcurl\b/);
    expect(step).not.toMatch(/GH_TOKEN/);
  });

  it('makes one ls-remote, bounded by timeout 30', () => {
    const calls = [...run.matchAll(/\bls-remote\b/g)];
    expect(calls).toHaveLength(1);
    expect(run).toMatch(/timeout 30 git -C "\$D" ls-remote --tags origin/);
  });

  it('does not pass --refs, which would hide the peeled commit of an annotated tag', () => {
    expect(run).not.toMatch(/--refs/);
  });

  it('is fail-soft: continue-on-error, a 1-minute timeout, set +e', () => {
    expect(step).toMatch(/^ {8}continue-on-error: true$/m);
    expect(step).toMatch(/^ {8}timeout-minutes: 1$/m);
    expect(run.trimStart().startsWith('set +e')).toBe(true);
  });

  it('exits 0 on every path', () => {
    // A bare `exit` (no code) is captured as undefined and fails: it would
    // return the last command's status, which under `set +e` can be non-zero.
    const exits = [...run.matchAll(/\bexit\b(?:[ \t]+([^\s;]+))?/g)].map((m) => m[1]);
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.every((code) => code === '0')).toBe(true);
    expect(run.trimEnd().endsWith('exit 0')).toBe(true);
  });
});
