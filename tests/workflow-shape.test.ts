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
});
