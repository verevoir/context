import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ConceptNetwork,
  createConceptNetwork,
  normaliseKey,
  NormalisedKeyMatcher,
  StructuralOnlyDetector,
  type ClaimRecord,
  type TopicMatcher,
  type TensionDetector,
} from '../../src/concept-network/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let storeRoot: string;
let net: ConceptNetwork;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cn-test-'));
}

function makeClaim(
  overrides: Partial<Omit<ClaimRecord, 'conceptKey'>> & { text: string }
): Omit<ClaimRecord, 'conceptKey'> {
  return {
    id: overrides.id ?? `claim-${Math.random().toString(36).slice(2)}`,
    text: overrides.text,
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00Z',
    sourceId: overrides.sourceId ?? 'source-a',
    supersededBy: overrides.supersededBy,
  };
}

beforeEach(() => {
  storeRoot = tmpRoot();
  net = createConceptNetwork('proj-1', { storeRoot });
});

afterEach(() => {
  fs.rmSync(storeRoot, { recursive: true, force: true });
});

// ── normaliseKey ─────────────────────────────────────────────────────────────

describe('normaliseKey', () => {
  it('lowercases and trims', () => {
    expect(normaliseKey('  Auth Token  ')).toBe('auth token');
  });

  it('collapses internal whitespace', () => {
    expect(normaliseKey('rate   limiting')).toBe('rate limiting');
  });

  it('treats "Rate Limiting" and "rate limiting" as the same key', () => {
    expect(normaliseKey('Rate Limiting')).toBe(normaliseKey('rate limiting'));
  });
});

// ── addClaim — validation ─────────────────────────────────────────────────────

describe('addClaim — input validation', () => {
  it('rejects a claim with an empty id', () => {
    expect(() => net.addClaim(makeClaim({ id: '', text: 'foo' }))).toThrow('claim.id');
  });

  it('rejects a claim with empty text', () => {
    expect(() => net.addClaim(makeClaim({ id: 'c1', text: '' }))).toThrow('claim.text');
  });

  it('rejects a claim with no timestamp', () => {
    expect(() => net.addClaim({ id: 'c1', text: 'foo', timestamp: '', sourceId: 'src' })).toThrow(
      'claim.timestamp'
    );
  });

  it('rejects a claim with an empty sourceId', () => {
    expect(() =>
      net.addClaim({ id: 'c1', text: 'foo', timestamp: '2026-01-01T00:00:00Z', sourceId: '' })
    ).toThrow('claim.sourceId');
  });
});

// ── addClaim — store round-trip ───────────────────────────────────────────────

describe('addClaim — store round-trip', () => {
  it('returns a ClaimRecord with a conceptKey derived from the text', () => {
    const record = net.addClaim(makeClaim({ text: 'Rate Limiting', id: 'c1' }));
    expect(record.conceptKey).toBe('rate limiting');
    expect(record.text).toBe('Rate Limiting');
    expect(record.id).toBe('c1');
  });

  it('persists the claim to the JSONL trail', () => {
    net.addClaim(makeClaim({ text: 'auth token', id: 'c1' }));
    const claimsPath = path.join(storeRoot, 'proj-1', 'claims.jsonl');
    expect(fs.existsSync(claimsPath)).toBe(true);
    const lines = fs.readFileSync(claimsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as ClaimRecord;
    expect(parsed.id).toBe('c1');
    expect(parsed.conceptKey).toBe('auth token');
  });

  it('appends subsequent claims to the same file', () => {
    net.addClaim(makeClaim({ text: 'auth token', id: 'c1' }));
    net.addClaim(makeClaim({ text: 'rate limiting', id: 'c2' }));
    const claimsPath = path.join(storeRoot, 'proj-1', 'claims.jsonl');
    const lines = fs.readFileSync(claimsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('provenance and timestamp are mandatory and present on the persisted record', () => {
    const record = net.addClaim({
      id: 'c1',
      text: 'deployment strategy',
      timestamp: '2026-03-15T10:00:00Z',
      sourceId: 'meeting-2026-03-15',
    });
    expect(record.sourceId).toBe('meeting-2026-03-15');
    expect(record.timestamp).toBe('2026-03-15T10:00:00Z');
    // Verify it survives round-trip through the file.
    const claimsPath = path.join(storeRoot, 'proj-1', 'claims.jsonl');
    const parsed = JSON.parse(fs.readFileSync(claimsPath, 'utf8').trim()) as ClaimRecord;
    expect(parsed.sourceId).toBe('meeting-2026-03-15');
    expect(parsed.timestamp).toBe('2026-03-15T10:00:00Z');
  });
});

// ── materialise — graph from trail ───────────────────────────────────────────

describe('materialise — graph from trail', () => {
  it('returns an empty graph when no claims have been added', () => {
    const g = net.materialise();
    expect(g.nodes.size).toBe(0);
    expect(g.claims.size).toBe(0);
  });

  it('creates a concept node for each distinct normalised key', () => {
    net.addClaim(makeClaim({ text: 'Rate Limiting', id: 'c1' }));
    net.addClaim(makeClaim({ text: 'rate limiting', id: 'c2' }));
    net.addClaim(makeClaim({ text: 'Auth Token', id: 'c3' }));
    const g = net.materialise();
    expect(g.nodes.size).toBe(2);
    expect(g.nodes.has('rate limiting')).toBe(true);
    expect(g.nodes.has('auth token')).toBe(true);
  });

  it('groups claims with the same normalised key under one node', () => {
    net.addClaim(makeClaim({ text: 'Rate Limiting', id: 'c1' }));
    net.addClaim(makeClaim({ text: 'rate limiting', id: 'c2' }));
    const g = net.materialise();
    expect(g.nodes.get('rate limiting')?.claimIds).toEqual(['c1', 'c2']);
  });
});

// ── index rebuild ─────────────────────────────────────────────────────────────

describe('index rebuild from trail', () => {
  it('produces an identical graph after the index is deleted and rebuilt', () => {
    net.addClaim(makeClaim({ text: 'Rate Limiting', id: 'c1', sourceId: 'src-a' }));
    net.addClaim(makeClaim({ text: 'rate limiting', id: 'c2', sourceId: 'src-b' }));
    net.addClaim(makeClaim({ text: 'Auth Token', id: 'c3', sourceId: 'src-a' }));
    net.addLink({
      id: 'l1',
      fromText: 'auth token',
      toText: 'rate limiting',
      label: 'related',
      timestamp: '2026-01-01T01:00:00Z',
      sourceId: 'src-a',
    });

    const graphBefore = net.materialise();

    // Delete the index explicitly to force rebuild.
    const indexPath = path.join(storeRoot, 'proj-1', 'index.json');
    fs.unlinkSync(indexPath);
    expect(fs.existsSync(indexPath)).toBe(false);

    const graphAfter = net.rebuildFromTrail();

    // Nodes and their claim lists must match.
    expect(graphAfter.nodes.size).toBe(graphBefore.nodes.size);
    for (const [key, nodeAfter] of graphAfter.nodes) {
      const nodeBefore = graphBefore.nodes.get(key)!;
      expect(nodeAfter.claimIds).toEqual(nodeBefore.claimIds);
    }
    // Links must match.
    expect(graphAfter.links.size).toBe(graphBefore.links.size);
    // Source sets must match.
    for (const [key, srcsAfter] of graphAfter.sourcesByKey) {
      const srcsBefore = graphBefore.sourcesByKey.get(key)!;
      expect([...srcsAfter].sort()).toEqual([...srcsBefore].sort());
    }
  });

  it('writes a new index.json after rebuildFromTrail', () => {
    net.addClaim(makeClaim({ text: 'foo', id: 'c1' }));
    // materialise() builds and writes the index (addClaim drops it to
    // keep the file as the source of truth — the index is a read cache).
    const indexPath = path.join(storeRoot, 'proj-1', 'index.json');
    net.materialise(); // triggers writeIndex
    expect(fs.existsSync(indexPath)).toBe(true);

    // Delete the index and verify rebuildFromTrail recreates it.
    fs.unlinkSync(indexPath);
    net.rebuildFromTrail();
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  it('serves from the index cache on the second materialise call', () => {
    net.addClaim(makeClaim({ text: 'caching', id: 'c1' }));
    const g1 = net.materialise();
    // The index is now present; materialise() should load it (same graph).
    const g2 = net.materialise();
    expect(g2.nodes.size).toBe(g1.nodes.size);
    expect([...g2.claims.keys()]).toEqual([...g1.claims.keys()]);
  });
});

// ── recurrence counting ───────────────────────────────────────────────────────

describe('recurrence — counting and source-independence weighting', () => {
  it('counts the mentions and independent sources for each concept', () => {
    net.addClaim(makeClaim({ text: 'auth token', id: 'c1', sourceId: 'src-a' }));
    net.addClaim(makeClaim({ text: 'auth token', id: 'c2', sourceId: 'src-b' }));
    net.addClaim(makeClaim({ text: 'auth token', id: 'c3', sourceId: 'src-a' })); // same as c1
    net.addClaim(makeClaim({ text: 'rate limiting', id: 'c4', sourceId: 'src-a' }));

    const results = net.recurrence();
    const authEntry = results.find((r) => r.key === 'auth token')!;
    const rateEntry = results.find((r) => r.key === 'rate limiting')!;

    expect(authEntry.mentionCount).toBe(3);
    expect(authEntry.independentSourceCount).toBe(2); // src-a and src-b
    expect(rateEntry.mentionCount).toBe(1);
    expect(rateEntry.independentSourceCount).toBe(1);
  });

  it('sorts results by independent source count descending', () => {
    net.addClaim(makeClaim({ text: 'one source concept', id: 'c1', sourceId: 'src-a' }));
    net.addClaim(makeClaim({ text: 'one source concept', id: 'c2', sourceId: 'src-a' }));
    net.addClaim(makeClaim({ text: 'multi source concept', id: 'c3', sourceId: 'src-a' }));
    net.addClaim(makeClaim({ text: 'multi source concept', id: 'c4', sourceId: 'src-b' }));

    const results = net.recurrence();
    expect(results[0].key).toBe('multi source concept');
    expect(results[0].independentSourceCount).toBe(2);
    expect(results[1].key).toBe('one source concept');
    expect(results[1].independentSourceCount).toBe(1);
  });

  it('weights by source independence: many same-source mentions < fewer independent sources', () => {
    // 5 mentions from 1 source should rank below 2 mentions from 2 sources.
    for (let i = 0; i < 5; i++) {
      net.addClaim(
        makeClaim({ text: 'high volume low independence', id: `hv-${i}`, sourceId: 'src-only' })
      );
    }
    net.addClaim(
      makeClaim({ text: 'low volume high independence', id: 'lv-1', sourceId: 'src-a' })
    );
    net.addClaim(
      makeClaim({ text: 'low volume high independence', id: 'lv-2', sourceId: 'src-b' })
    );

    const results = net.recurrence();
    const highIndep = results.find((r) => r.key === 'low volume high independence')!;
    const lowIndep = results.find((r) => r.key === 'high volume low independence')!;

    expect(highIndep.independentSourceCount).toBe(2);
    expect(lowIndep.independentSourceCount).toBe(1);
    // Sorted by independentSourceCount descending, highIndep must come first.
    expect(results.indexOf(highIndep)).toBeLessThan(results.indexOf(lowIndep));
  });
});

// ── temporal trail ───────────────────────────────────────────────────────────

describe('temporalTrail — time ordering', () => {
  it('returns claims in ascending timestamp order regardless of insertion order', () => {
    net.addClaim(makeClaim({ text: 'api design', id: 'c3', timestamp: '2026-03-01T00:00:00Z' }));
    net.addClaim(makeClaim({ text: 'api design', id: 'c1', timestamp: '2026-01-01T00:00:00Z' }));
    net.addClaim(makeClaim({ text: 'api design', id: 'c2', timestamp: '2026-02-01T00:00:00Z' }));

    const trail = net.temporalTrail('api design');
    const ids = trail.claimsInOrder.map((c) => c.id);
    expect(ids).toEqual(['c1', 'c2', 'c3']);
  });

  it('returns an empty trail for an unknown concept key', () => {
    const trail = net.temporalTrail('nonexistent');
    expect(trail.claimsInOrder).toHaveLength(0);
    expect(trail.acknowledgedSupersessions).toHaveLength(0);
  });
});

// ── supersession check ────────────────────────────────────────────────────────

describe('supersessionExists — structural check', () => {
  it('detects an acknowledged supersession via the supersededBy field on the earlier claim', () => {
    const c1 = net.addClaim(
      makeClaim({
        text: 'old framing',
        id: 'c1',
        timestamp: '2026-01-01T00:00:00Z',
        supersededBy: 'c2',
      })
    );
    const c2 = net.addClaim(
      makeClaim({ text: 'old framing', id: 'c2', timestamp: '2026-02-01T00:00:00Z' })
    );

    const g = net.materialise();
    expect(net.supersessionExists(c1, c2, g)).toBe(true);
  });

  it('detects an acknowledged supersession via a ConceptLink labelled "supersedes" (direction-agnostic)', () => {
    const c1 = net.addClaim(
      makeClaim({ text: 'v1 architecture', id: 'c1', timestamp: '2026-01-01T00:00:00Z' })
    );
    const c2 = net.addClaim(
      makeClaim({ text: 'v2 architecture', id: 'c2', timestamp: '2026-03-01T00:00:00Z' })
    );
    // "v2 supersedes v1" — link direction is from=v2 to=v1 here, but the
    // structural check accepts any direction between the two keys.
    net.addLink({
      id: 'l1',
      fromText: 'v2 architecture',
      toText: 'v1 architecture',
      label: 'supersedes',
      timestamp: '2026-03-01T01:00:00Z',
      sourceId: 'adr-007',
    });

    const g = net.materialise();
    // A 'supersedes' link between the two concept keys counts as acknowledged
    // regardless of direction — the connection exists; that is enough.
    expect(net.supersessionExists(c1, c2, g)).toBe(true);
  });

  it('reports no supersession when neither a supersededBy field nor a supersedes link exists', () => {
    const c1 = net.addClaim(
      makeClaim({ text: 'api versioning', id: 'c1', timestamp: '2026-01-01T00:00:00Z' })
    );
    const c2 = net.addClaim(
      makeClaim({ text: 'api versioning', id: 'c2', timestamp: '2026-06-01T00:00:00Z' })
    );

    const g = net.materialise();
    expect(net.supersessionExists(c1, c2, g)).toBe(false);
  });

  it('temporalTrail surfaces acknowledged supersessions in the trail', () => {
    net.addClaim(
      makeClaim({
        text: 'deploy strategy',
        id: 'c1',
        timestamp: '2026-01-01T00:00:00Z',
        supersededBy: 'c2',
      })
    );
    net.addClaim(
      makeClaim({ text: 'deploy strategy', id: 'c2', timestamp: '2026-06-01T00:00:00Z' })
    );

    const trail = net.temporalTrail('deploy strategy');
    expect(trail.acknowledgedSupersessions).toHaveLength(1);
    expect(trail.acknowledgedSupersessions[0].earlier.id).toBe('c1');
    expect(trail.acknowledgedSupersessions[0].later.id).toBe('c2');
  });
});

// ── StructuralOnlyDetector — baseline TensionDetector ────────────────────────

describe('StructuralOnlyDetector — baseline', () => {
  it('never reports a tension between any two claims', () => {
    const c1 = net.addClaim(
      makeClaim({ text: 'security approach', id: 'c1', timestamp: '2026-01-01T00:00:00Z' })
    );
    const c2 = net.addClaim(
      makeClaim({ text: 'security approach', id: 'c2', timestamp: '2026-06-01T00:00:00Z' })
    );
    expect(StructuralOnlyDetector.isTension(c1, c2)).toBe(false);
  });

  it('temporalTrail has no detectedTensions with the baseline detector', () => {
    net.addClaim(makeClaim({ text: 'auth model', id: 'c1', timestamp: '2026-01-01T00:00:00Z' }));
    net.addClaim(makeClaim({ text: 'auth model', id: 'c2', timestamp: '2026-06-01T00:00:00Z' }));
    const trail = net.temporalTrail('auth model');
    expect(trail.detectedTensions).toHaveLength(0);
  });
});

// ── TopicMatcher seam ─────────────────────────────────────────────────────────

describe('TopicMatcher seam — custom matcher', () => {
  it('uses the injected matcher to group mentions into concepts', () => {
    const alwaysFoo: TopicMatcher = { keyFor: () => 'foo' };
    const n = createConceptNetwork('proj-2', { storeRoot, topicMatcher: alwaysFoo });
    n.addClaim(makeClaim({ text: 'anything at all', id: 'c1' }));
    n.addClaim(makeClaim({ text: 'something else', id: 'c2' }));
    const g = n.materialise();
    expect(g.nodes.size).toBe(1);
    expect(g.nodes.has('foo')).toBe(true);
  });
});

// ── TensionDetector seam ──────────────────────────────────────────────────────

describe('TensionDetector seam — custom detector', () => {
  it('surfaces tensions flagged by the injected detector in the temporal trail', () => {
    // A detector that flags every pair as a tension.
    const alwaysTension: TensionDetector = { isTension: () => true };
    const n = createConceptNetwork('proj-3', { storeRoot, tensionDetector: alwaysTension });
    n.addClaim(makeClaim({ text: 'logging policy', id: 'c1', timestamp: '2026-01-01T00:00:00Z' }));
    n.addClaim(makeClaim({ text: 'logging policy', id: 'c2', timestamp: '2026-06-01T00:00:00Z' }));

    const trail = n.temporalTrail('logging policy');
    // No supersession record → falls through to detector → tension.
    expect(trail.detectedTensions).toHaveLength(1);
    expect(trail.detectedTensions[0].earlier.id).toBe('c1');
    expect(trail.detectedTensions[0].later.id).toBe('c2');
  });

  it('does not surface a tension when an acknowledged supersession exists, even with an aggressive detector', () => {
    const alwaysTension: TensionDetector = { isTension: () => true };
    const n = createConceptNetwork('proj-4', { storeRoot, tensionDetector: alwaysTension });
    n.addClaim(
      makeClaim({
        text: 'logging policy',
        id: 'c1',
        timestamp: '2026-01-01T00:00:00Z',
        supersededBy: 'c2',
      })
    );
    n.addClaim(makeClaim({ text: 'logging policy', id: 'c2', timestamp: '2026-06-01T00:00:00Z' }));

    const trail = n.temporalTrail('logging policy');
    // Supersession takes priority; the detector is not reached for this pair.
    expect(trail.acknowledgedSupersessions).toHaveLength(1);
    expect(trail.detectedTensions).toHaveLength(0);
  });
});

// ── addLink ───────────────────────────────────────────────────────────────────

describe('addLink', () => {
  it('persists a link between two concept keys resolved from texts', () => {
    net.addLink({
      id: 'l1',
      fromText: 'Auth Token',
      toText: 'Rate Limiting',
      label: 'related',
      timestamp: '2026-01-01T00:00:00Z',
      sourceId: 'src-a',
    });
    const g = net.materialise();
    const link = g.links.get('l1')!;
    expect(link).toBeDefined();
    expect(link.from).toBe('auth token');
    expect(link.to).toBe('rate limiting');
    expect(link.label).toBe('related');
  });

  it('rejects a link with an empty id', () => {
    expect(() =>
      net.addLink({
        id: '',
        fromText: 'a',
        toText: 'b',
        timestamp: '2026-01-01T00:00:00Z',
        sourceId: 'src',
      })
    ).toThrow('link.id');
  });
});

// ── per-project partitioning ──────────────────────────────────────────────────

describe('per-project partitioning', () => {
  it('two ConceptNetworks with different projectIds do not share data', () => {
    const netA = createConceptNetwork('proj-alpha', { storeRoot });
    const netB = createConceptNetwork('proj-beta', { storeRoot });

    netA.addClaim(makeClaim({ text: 'concept in alpha', id: 'ca1' }));
    netB.addClaim(makeClaim({ text: 'concept in beta', id: 'cb1' }));

    const gA = netA.materialise();
    const gB = netB.materialise();

    expect(gA.nodes.has('concept in alpha')).toBe(true);
    expect(gA.nodes.has('concept in beta')).toBe(false);
    expect(gB.nodes.has('concept in beta')).toBe(true);
    expect(gB.nodes.has('concept in alpha')).toBe(false);
  });
});

// ── NormalisedKeyMatcher exported singleton ───────────────────────────────────

describe('NormalisedKeyMatcher', () => {
  it('exported singleton produces the same output as normaliseKey', () => {
    const texts = ['Rate Limiting', '  rate   limiting ', 'RATE LIMITING'];
    for (const t of texts) {
      expect(NormalisedKeyMatcher.keyFor(t)).toBe(normaliseKey(t));
    }
  });
});

// ── projectId validation ──────────────────────────────────────────────────────

describe('ConceptNetwork — constructor validation', () => {
  it('rejects an empty projectId', () => {
    expect(() => new ConceptNetwork('', { storeRoot })).toThrow('projectId');
  });

  it('rejects a whitespace-only projectId', () => {
    expect(() => new ConceptNetwork('   ', { storeRoot })).toThrow('projectId');
  });
});
