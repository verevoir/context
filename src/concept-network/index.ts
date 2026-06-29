// @verevoir/context/concept-network — v1 concept-link accumulator.
//
// The observation trail for differential ingestion (ADR 014 §7 v1).
// Same primitive as @verevoir/context/code's code_graph, one domain over:
// concepts + relationships instead of symbols + relationships.
//
// **Sources of truth (ADR 014 §5)**
//   - Trail files are canonical for the observation trail. The JSON
//     index is a derived, rebuildable cache — never canonical state.
//   - The trail is NOT derivable from the curated project context;
//     it is rebuildable only by re-ingesting the raw sources.
//
// **Storage (ADR 014 §6)**
//   - Files first: concepts and claims land as JSONL on disk.
//   - JSON index: materialised on read, rebuilt from the trail.
//   - Per-project partitioned: every projectId gets its own sub-tree.
//
// **Seams (ADR 014 §7 — deferred layers)**
//   - `TopicMatcher`: baseline = normalised-key exact grouping.
//     Swap in a semantic / embedding impl to match differently-worded
//     mentions without touching the store. (STDIO-488 deferred)
//   - `TensionDetector`: baseline = structural-only (does a supersession
//     link record exist? no model judgment). Swap in a semantic impl that
//     decides whether a later framing *contradicts* an earlier one without
//     an acknowledged link. (STDIO-488 deferred)

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Seam interfaces — the two deferred layers plug in here
// ============================================================

/**
 * Maps a raw mention text to a canonical concept key.
 *
 * Baseline: normalised-key (lowercase, trim, collapse whitespace).
 * The seam for a future semantic/embedding implementation that can
 * group differently-worded mentions of the same concept.
 *
 * DEFERRED (STDIO-488): replace `NormalisedKeyMatcher` with a
 * semantic TopicMatcher to resolve concept identity by meaning
 * rather than exact normalised string.
 */
export interface TopicMatcher {
  /** Return the canonical key for `text`. Two texts with the same
   * key are the same concept. */
  keyFor(text: string): string;
}

/**
 * Decides whether a later framing of a concept constitutes an
 * unacknowledged tension with an earlier one.
 *
 * Baseline: structural-only — returns `false` (no judgment).
 * The seam for a future semantic/model implementation that reads
 * the claim texts and decides whether the later diverges from the
 * earlier without an acknowledged supersession link.
 *
 * DEFERRED (STDIO-488): replace `StructuralOnlyDetector` with a
 * semantic TensionDetector that calls a model to compare framings
 * and detect unacknowledged contradictions.
 */
export interface TensionDetector {
  /** Return `true` if `later` constitutes a tension with `earlier`
   * that has not been acknowledged. Structural baseline always returns
   * `false`; a semantic implementation may call a model. */
  isTension(earlier: ClaimRecord, later: ClaimRecord): boolean;
}

// ============================================================
// Baseline seam implementations
// ============================================================

/** Normalises a mention to a canonical key: lowercase, trimmed,
 * collapsed whitespace. Two mentions with the same normalised key
 * are grouped as the same concept. */
export function normaliseKey(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Baseline TopicMatcher: normalised-key exact grouping.
 * No model call, no embeddings — deterministic, O(1). */
export const NormalisedKeyMatcher: TopicMatcher = {
  keyFor: normaliseKey,
};

/** Baseline TensionDetector: structural only.
 * Reports no tension without a connecting supersession record — never
 * calls a model. See `ConceptNetwork.supersessionExists` for the
 * structural check. */
export const StructuralOnlyDetector: TensionDetector = {
  isTension(_earlier: ClaimRecord, _later: ClaimRecord): boolean {
    return false;
  },
};

// ============================================================
// Core record types — the observation trail
// ============================================================

/** A mention of a concept in one source document.  The trail is the
 * ordered sequence of ClaimRecords; they are never mutated. */
export interface ClaimRecord {
  /** Unique id for this claim. `crypto.randomUUID()` or a deterministic
   * content hash — callers choose, the store persists what is given. */
  id: string;
  /** The canonical concept key (as produced by the active TopicMatcher). */
  conceptKey: string;
  /** The verbatim mention text, as it appeared in the source. */
  text: string;
  /** ISO-8601 timestamp of when this claim was observed. Mandatory.
   * The temporal trail depends on it. */
  timestamp: string;
  /** Human- or machine-readable identifier of the source this claim
   * came from (file path, URL, transcript id, meeting title, …).
   * Mandatory for source-independence weighting. */
  sourceId: string;
  /** Optional: the id of a later ClaimRecord that supersedes this one.
   * A connecting record makes temporal evolution *acknowledged*
   * (per ADR 014 §4 — temporal tension). */
  supersededBy?: string;
}

/** A concept node — the aggregated view of all claims with the same key. */
export interface ConceptNode {
  /** Canonical key (the normalised form). */
  key: string;
  /** All claim ids for this concept, in ascending timestamp order. */
  claimIds: string[];
}

/** A directed link between two concepts: `from` → `to`. */
export interface ConceptLink {
  id: string;
  from: string; // conceptKey
  to: string; // conceptKey
  /** Optional label describing the relationship (e.g. 'supersedes', 'related'). */
  label?: string;
  timestamp: string;
  sourceId: string;
}

// ============================================================
// Materialised graph
// ============================================================

/** The in-memory graph materialised from the trail.  Derived +
 * rebuildable from the trail files; never canonical state. */
export interface ConceptGraph {
  /** All claims, keyed by id. */
  claims: Map<string, ClaimRecord>;
  /** Concept nodes, keyed by conceptKey. */
  nodes: Map<string, ConceptNode>;
  /** All concept links, keyed by id. */
  links: Map<string, ConceptLink>;
  /** Source IDs that have contributed at least one claim, keyed by conceptKey.
   * Drives source-independence weighting: a concept mentioned by N
   * independent sources has richer signal than one mentioned N times in
   * the same source. */
  sourcesByKey: Map<string, Set<string>>;
}

// ============================================================
// Recurrence result
// ============================================================

/** Recurrence data for one concept key. */
export interface RecurrenceResult {
  key: string;
  /** Raw number of claims (mentions). */
  mentionCount: number;
  /** Number of *independent* sources mentioning this concept.
   * This is the signal weight: 10 mentions from 1 source < 3 mentions
   * from 3 independent sources. */
  independentSourceCount: number;
}

// ============================================================
// Temporal trail + supersession result
// ============================================================

/** Temporal view of a concept: claims in time order, with any
 * supersession links resolved. */
export interface TemporalTrail {
  key: string;
  /** Claims ordered by timestamp ascending (oldest first). */
  claimsInOrder: ClaimRecord[];
  /** Pairs where the later framing is connected to an earlier one by a
   * supersession record — *acknowledged* evolution. */
  acknowledgedSupersessions: Array<{ earlier: ClaimRecord; later: ClaimRecord }>;
  /** Pairs where the TensionDetector flagged a potential unacknowledged
   * tension between an earlier and a later claim. With the baseline
   * StructuralOnlyDetector this is always empty. */
  detectedTensions: Array<{ earlier: ClaimRecord; later: ClaimRecord }>;
}

// ============================================================
// Store — file layout
// ============================================================

//   <storeRoot>/
//     <projectId>/
//       claims.jsonl        ← one JSON object per line, append-only
//       links.jsonl         ← one JSON object per line, append-only
//       index.json          ← derived cache, rebuildable from the JSONL files

const CLAIMS_FILE = 'claims.jsonl';
const LINKS_FILE = 'links.jsonl';
const INDEX_FILE = 'index.json';

interface IndexSnapshot {
  /** Bump when the shape changes so a stale index is detected. */
  v: number;
  nodes: Array<{ key: string; claimIds: string[] }>;
  links: Array<ConceptLink>;
}

const INDEX_VERSION = 1;

// ============================================================
// ConceptNetwork — the accumulator
// ============================================================

export interface ConceptNetworkOptions {
  /** Root directory for trail files. Each project gets a sub-dir. */
  storeRoot: string;
  /** Override the topic matcher. Default: NormalisedKeyMatcher. */
  topicMatcher?: TopicMatcher;
  /** Override the tension detector. Default: StructuralOnlyDetector. */
  tensionDetector?: TensionDetector;
}

/** The concept-link accumulator.  One instance per project is the
 * expected usage; the `projectId` scopes all reads and writes to a
 * sub-directory of `storeRoot`. */
export class ConceptNetwork {
  private readonly projectDir: string;
  private readonly claimsPath: string;
  private readonly linksPath: string;
  private readonly indexPath: string;
  private readonly matcher: TopicMatcher;
  private readonly detector: TensionDetector;

  constructor(projectId: string, options: ConceptNetworkOptions) {
    if (!projectId || projectId.trim() === '') throw new Error('projectId must be non-empty');
    this.projectDir = path.join(options.storeRoot, projectId);
    this.claimsPath = path.join(this.projectDir, CLAIMS_FILE);
    this.linksPath = path.join(this.projectDir, LINKS_FILE);
    this.indexPath = path.join(this.projectDir, INDEX_FILE);
    this.matcher = options.topicMatcher ?? NormalisedKeyMatcher;
    this.detector = options.tensionDetector ?? StructuralOnlyDetector;
    fs.mkdirSync(this.projectDir, { recursive: true });
  }

  // ── Write side ───────────────────────────────────────────────

  /** Record a new claim (mention) of a concept.
   * The `conceptKey` is derived from `text` via the active TopicMatcher. */
  addClaim(claim: Omit<ClaimRecord, 'conceptKey'>): ClaimRecord {
    if (!claim.id || claim.id.trim() === '') throw new Error('claim.id must be non-empty');
    if (!claim.text || claim.text.trim() === '') throw new Error('claim.text must be non-empty');
    if (!claim.timestamp) throw new Error('claim.timestamp is required');
    if (!claim.sourceId || claim.sourceId.trim() === '')
      throw new Error('claim.sourceId must be non-empty');

    const conceptKey = this.matcher.keyFor(claim.text);
    const record: ClaimRecord = { ...claim, conceptKey };
    fs.appendFileSync(this.claimsPath, JSON.stringify(record) + '\n', 'utf8');
    // Drop the index so the next materialise() rebuilds from the fresh trail.
    this.dropIndex();
    return record;
  }

  /** Record a directed link between two concept texts (resolved to keys). */
  addLink(
    link: Omit<ConceptLink, 'from' | 'to'> & { fromText: string; toText: string }
  ): ConceptLink {
    if (!link.id || link.id.trim() === '') throw new Error('link.id must be non-empty');
    if (!link.timestamp) throw new Error('link.timestamp is required');
    if (!link.sourceId || link.sourceId.trim() === '')
      throw new Error('link.sourceId must be non-empty');

    const from = this.matcher.keyFor(link.fromText);
    const to = this.matcher.keyFor(link.toText);
    const record: ConceptLink = {
      id: link.id,
      from,
      to,
      label: link.label,
      timestamp: link.timestamp,
      sourceId: link.sourceId,
    };
    fs.appendFileSync(this.linksPath, JSON.stringify(record) + '\n', 'utf8');
    this.dropIndex();
    return record;
  }

  // ── Read side — materialise on read ─────────────────────────

  /** Build (or load from the index cache) the in-memory graph.
   *
   * The JSON index is a load cache — a perf shortcut, never canonical.
   * `materialise(true)` forces a rebuild from the trail files and
   * overwrites the index. `materialise()` loads the index if present;
   * if absent (deleted or never written) it rebuilds. */
  materialise(force = false): ConceptGraph {
    if (!force) {
      const cached = this.tryLoadIndex();
      if (cached) return cached;
    }
    return this.rebuildFromTrail();
  }

  /** Rebuild the graph from the JSONL trail files and write a fresh
   * index.  This is the source-of-truth path. */
  rebuildFromTrail(): ConceptGraph {
    const claims = new Map<string, ClaimRecord>();
    const nodes = new Map<string, ConceptNode>();
    const links = new Map<string, ConceptLink>();
    const sourcesByKey = new Map<string, Set<string>>();

    // ── Load claims ──
    if (fs.existsSync(this.claimsPath)) {
      const lines = fs.readFileSync(this.claimsPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = JSON.parse(trimmed) as ClaimRecord;
        claims.set(record.id, record);
        let node = nodes.get(record.conceptKey);
        if (!node) {
          node = { key: record.conceptKey, claimIds: [] };
          nodes.set(record.conceptKey, node);
        }
        node.claimIds.push(record.id);
        let srcs = sourcesByKey.get(record.conceptKey);
        if (!srcs) {
          srcs = new Set();
          sourcesByKey.set(record.conceptKey, srcs);
        }
        srcs.add(record.sourceId);
      }
    }

    // Sort each node's claimIds by timestamp ascending.
    for (const node of nodes.values()) {
      node.claimIds.sort((a, b) => {
        const ta = claims.get(a)?.timestamp ?? '';
        const tb = claims.get(b)?.timestamp ?? '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
    }

    // ── Load links ──
    if (fs.existsSync(this.linksPath)) {
      const lines = fs.readFileSync(this.linksPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = JSON.parse(trimmed) as ConceptLink;
        links.set(record.id, record);
      }
    }

    const graph: ConceptGraph = { claims, nodes, links, sourcesByKey };
    this.writeIndex(graph);
    return graph;
  }

  // ── Recurrence ───────────────────────────────────────────────

  /** Return recurrence data for all concepts, sorted by independent
   * source count descending (the signal weight per ADR 014 §4).
   *
   * Ten mentions from one source is one signal; three mentions from
   * three independent sources is three signals — source independence
   * is the weight, not raw mention count. */
  recurrence(graph?: ConceptGraph): RecurrenceResult[] {
    const g = graph ?? this.materialise();
    const results: RecurrenceResult[] = [];
    for (const [key, node] of g.nodes) {
      const mentionCount = node.claimIds.length;
      const independentSourceCount = g.sourcesByKey.get(key)?.size ?? 0;
      results.push({ key, mentionCount, independentSourceCount });
    }
    // Sort by independent source count (primary) then mention count (secondary).
    results.sort((a, b) =>
      b.independentSourceCount !== a.independentSourceCount
        ? b.independentSourceCount - a.independentSourceCount
        : b.mentionCount - a.mentionCount
    );
    return results;
  }

  // ── Temporal trail + supersession check ─────────────────────

  /** Return the temporal trail for `conceptKey`: claims in time order,
   * plus acknowledged supersession pairs and (with a non-structural
   * TensionDetector) detected unacknowledged tensions.
   *
   * Structural supersession check: a pair is *acknowledged* when the
   * earlier claim's `supersededBy` field points at the later claim's id,
   * OR when a ConceptLink with `label: 'supersedes'` connects the two
   * claims' source concepts in the same direction. The structural check
   * only tests *whether a connecting record exists* — it does not judge
   * whether the content diverges. */
  temporalTrail(conceptKey: string, graph?: ConceptGraph): TemporalTrail {
    const g = graph ?? this.materialise();
    const node = g.nodes.get(conceptKey);
    if (!node)
      return {
        key: conceptKey,
        claimsInOrder: [],
        acknowledgedSupersessions: [],
        detectedTensions: [],
      };

    const claimsInOrder = node.claimIds.map((id) => g.claims.get(id)!).filter(Boolean);

    const acknowledgedSupersessions: Array<{ earlier: ClaimRecord; later: ClaimRecord }> = [];
    const detectedTensions: Array<{ earlier: ClaimRecord; later: ClaimRecord }> = [];

    for (let i = 0; i < claimsInOrder.length; i++) {
      for (let j = i + 1; j < claimsInOrder.length; j++) {
        const earlier = claimsInOrder[i];
        const later = claimsInOrder[j];
        if (this.supersessionExists(earlier, later, g)) {
          acknowledgedSupersessions.push({ earlier, later });
        } else if (this.detector.isTension(earlier, later)) {
          detectedTensions.push({ earlier, later });
        }
      }
    }

    return { key: conceptKey, claimsInOrder, acknowledgedSupersessions, detectedTensions };
  }

  /** Structural-only supersession check: does a connecting record exist
   * between `earlier` and `later` in the trail?
   *
   * Two cases:
   *  1. `earlier.supersededBy === later.id` — the earlier claim was
   *     explicitly tagged at write time.
   *  2. A ConceptLink with `label: 'supersedes'` connects the same two
   *     concept keys (in either direction) — the existence of any such
   *     connecting record counts as acknowledgement of a relationship
   *     between the two framings, regardless of which concept the link
   *     names as `from`.
   *
   * This check is purely structural (does the record exist?) — it does
   * not read the claim texts or call a model. */
  supersessionExists(earlier: ClaimRecord, later: ClaimRecord, graph: ConceptGraph): boolean {
    if (earlier.supersededBy === later.id) return true;
    const keys = new Set([earlier.conceptKey, later.conceptKey]);
    for (const link of graph.links.values()) {
      if (link.label === 'supersedes' && keys.has(link.from) && keys.has(link.to)) {
        return true;
      }
    }
    return false;
  }

  // ── Index management ─────────────────────────────────────────

  private tryLoadIndex(): ConceptGraph | null {
    if (!fs.existsSync(this.indexPath)) return null;
    try {
      const snap = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as IndexSnapshot;
      if (!snap || snap.v !== INDEX_VERSION) return null;

      // The index contains nodes + links; we must still load claims from
      // the JSONL to populate the claims map (the index omits claim bodies
      // to keep it compact — nodes only hold ids).
      const claims = new Map<string, ClaimRecord>();
      const sourcesByKey = new Map<string, Set<string>>();

      if (fs.existsSync(this.claimsPath)) {
        const lines = fs.readFileSync(this.claimsPath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const record = JSON.parse(trimmed) as ClaimRecord;
          claims.set(record.id, record);
          let srcs = sourcesByKey.get(record.conceptKey);
          if (!srcs) {
            srcs = new Set();
            sourcesByKey.set(record.conceptKey, srcs);
          }
          srcs.add(record.sourceId);
        }
      }

      const nodes = new Map<string, ConceptNode>(snap.nodes.map((n) => [n.key, { ...n }]));
      const links = new Map<string, ConceptLink>(snap.links.map((l) => [l.id, l]));

      return { claims, nodes, links, sourcesByKey };
    } catch {
      // Corrupted or mismatched index — fall through to rebuild.
      return null;
    }
  }

  private writeIndex(graph: ConceptGraph): void {
    const snap: IndexSnapshot = {
      v: INDEX_VERSION,
      nodes: [...graph.nodes.values()].map((n) => ({ key: n.key, claimIds: [...n.claimIds] })),
      links: [...graph.links.values()],
    };
    fs.writeFileSync(this.indexPath, JSON.stringify(snap, null, 2), 'utf8');
  }

  private dropIndex(): void {
    if (fs.existsSync(this.indexPath)) {
      fs.unlinkSync(this.indexPath);
    }
  }
}

// ============================================================
// Factory — convenience constructor
// ============================================================

/** Create a ConceptNetwork for `projectId` rooted at `storeRoot`.
 * Accepts optional seam overrides for the two deferred layers. */
export function createConceptNetwork(
  projectId: string,
  options: ConceptNetworkOptions
): ConceptNetwork {
  return new ConceptNetwork(projectId, options);
}
