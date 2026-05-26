import { describe, it, expect } from 'vitest';
import { createContextStore, wrapWorkflowWithCache } from '../src/index.js';
import type { WorkflowAdapter, Card, Column } from '@verevoir/workflows';

/** STDIO-43: `wrapWorkflowWithCache` is the workflow twin of
 * `wrapWithCache` — board reads go through the same `ContextStore`, so
 * `getCard` gets read-through-with-validation, list reads get TTL
 * caching, writes invalidate, and (the headline) board state parks +
 * restores for free via the store's `serialize()` (STDIO-92). */

const BOARD = 'https://www.notion.so/board-123';
const ENV = { token: 't' };
const TTL = 10_000;

function makeCard(id: string, over: Partial<Card> = {}): Card {
  return {
    id,
    title: `Card ${id}`,
    body: '',
    columnId: 'col-1',
    assigneeIds: [],
    labels: [],
    lastActivity: '2026-05-26T00:00:00.000Z',
    ...over,
  };
}

/** A fake adapter with per-method call counters and mutable backing
 * state, so tests can assert what was (and wasn't) fetched. */
function makeAdapter(initial: { cards?: Card[]; columns?: Column[] } = {}) {
  const calls = {
    listColumns: 0,
    listCards: 0,
    getCard: 0,
    isCardFresh: 0,
    createCard: 0,
    updateCard: 0,
    moveCard: 0,
    listComments: 0,
    addComment: 0,
    listCustomFields: 0,
  };
  const cards = new Map<string, Card>((initial.cards ?? []).map((c) => [c.id, c]));
  let columns: Column[] = initial.columns ?? [{ id: 'col-1', name: 'Todo' }];
  let freshAnswer = true;
  let created = 0;

  const adapter: WorkflowAdapter = {
    async listColumns() {
      calls.listColumns++;
      return columns;
    },
    async listCards() {
      calls.listCards++;
      return [...cards.values()];
    },
    async getCard(_e, _b, id) {
      calls.getCard++;
      const c = cards.get(id);
      if (!c) throw new Error(`no card ${id}`);
      return c;
    },
    async isCardFresh() {
      calls.isCardFresh++;
      return freshAnswer;
    },
    async createCard(_e, _b, columnId, fields) {
      calls.createCard++;
      const c = makeCard(`new-${++created}`, { title: fields.title, columnId });
      cards.set(c.id, c);
      return c;
    },
    async updateCard() {
      calls.updateCard++;
    },
    async moveCard() {
      calls.moveCard++;
    },
    async listComments() {
      calls.listComments++;
      return [];
    },
    async addComment() {
      calls.addComment++;
    },
    async listCustomFields() {
      calls.listCustomFields++;
      return [];
    },
  };

  return {
    adapter,
    calls,
    setCard: (c: Card) => cards.set(c.id, c),
    setColumns: (c: Column[]) => {
      columns = c;
    },
    setFresh: (v: boolean) => {
      freshAnswer = v;
    },
  };
}

/** An adapter that throws on every call — proves a read was served
 * from cache and never touched the source. */
const throwingAdapter: WorkflowAdapter = new Proxy({} as WorkflowAdapter, {
  get() {
    return async () => {
      throw new Error('source must not be touched');
    };
  },
});

describe('wrapWorkflowWithCache — getCard read-through-with-validation', () => {
  it('serves a second read from cache within the grace window (no source call)', async () => {
    const { adapter, calls } = makeAdapter({ cards: [makeCard('c1')] });
    let clock = 1000;
    const wf = wrapWorkflowWithCache(adapter, {
      store: createContextStore(),
      now: () => clock,
      validationTtlMs: TTL,
    });

    await wf.getCard(ENV, BOARD, 'c1');
    clock += 5_000; // still inside the window
    await wf.getCard(ENV, BOARD, 'c1');

    expect(calls.getCard).toBe(1);
    expect(calls.isCardFresh).toBe(0);
  });

  it('past the window, validates via isCardFresh and serves cache when still fresh', async () => {
    const ad = makeAdapter({ cards: [makeCard('c1')] });
    let clock = 1000;
    const wf = wrapWorkflowWithCache(ad.adapter, {
      store: createContextStore(),
      now: () => clock,
      validationTtlMs: TTL,
    });

    await wf.getCard(ENV, BOARD, 'c1');
    clock += TTL + 1; // past the window
    ad.setFresh(true);
    await wf.getCard(ENV, BOARD, 'c1');

    expect(ad.calls.isCardFresh).toBe(1);
    expect(ad.calls.getCard).toBe(1); // served from cache, not re-fetched
  });

  it('past the window, re-fetches when the card has moved (isCardFresh false)', async () => {
    const ad = makeAdapter({ cards: [makeCard('c1', { title: 'old' })] });
    let clock = 1000;
    const wf = wrapWorkflowWithCache(ad.adapter, {
      store: createContextStore(),
      now: () => clock,
      validationTtlMs: TTL,
    });

    await wf.getCard(ENV, BOARD, 'c1');
    clock += TTL + 1;
    ad.setFresh(false);
    ad.setCard(makeCard('c1', { title: 'new' }));
    const card = await wf.getCard(ENV, BOARD, 'c1');

    expect(ad.calls.getCard).toBe(2);
    expect(card.title).toBe('new');
  });
});

describe('wrapWorkflowWithCache — list reads (TTL caching)', () => {
  it('caches listColumns within the window and re-fetches past it', async () => {
    const ad = makeAdapter({ columns: [{ id: 'col-1', name: 'Todo' }] });
    let clock = 1000;
    const wf = wrapWorkflowWithCache(ad.adapter, {
      store: createContextStore(),
      now: () => clock,
      validationTtlMs: TTL,
    });

    await wf.listColumns(ENV, BOARD);
    await wf.listColumns(ENV, BOARD);
    expect(ad.calls.listColumns).toBe(1);

    clock += TTL + 1;
    ad.setColumns([
      { id: 'col-1', name: 'Todo' },
      { id: 'col-2', name: 'Done' },
    ]);
    const cols = await wf.listColumns(ENV, BOARD);
    expect(ad.calls.listColumns).toBe(2);
    expect(cols).toHaveLength(2);
  });

  it('caches listCards per filter — different filters do not clobber each other', async () => {
    const { adapter, calls } = makeAdapter({ cards: [makeCard('c1')] });
    let clock = 1000;
    const wf = wrapWorkflowWithCache(adapter, {
      store: createContextStore(),
      now: () => clock,
      validationTtlMs: TTL,
    });

    await wf.listCards(ENV, BOARD);
    await wf.listCards(ENV, BOARD, { columnId: 'col-1' });
    await wf.listCards(ENV, BOARD); // cached
    await wf.listCards(ENV, BOARD, { columnId: 'col-1' }); // cached

    expect(calls.listCards).toBe(2);
  });
});

describe('wrapWorkflowWithCache — writes invalidate', () => {
  it('updateCard drops the card entry and list views, forcing a re-fetch', async () => {
    const { adapter, calls } = makeAdapter({ cards: [makeCard('c1')] });
    let clock = 1000;
    const wf = wrapWorkflowWithCache(adapter, {
      store: createContextStore(),
      now: () => clock,
      validationTtlMs: TTL,
    });

    await wf.getCard(ENV, BOARD, 'c1');
    await wf.listCards(ENV, BOARD);
    await wf.updateCard(ENV, BOARD, 'c1', { title: 'changed' });

    // Both re-fetch on next read despite being inside the TTL window.
    await wf.getCard(ENV, BOARD, 'c1');
    await wf.listCards(ENV, BOARD);
    expect(calls.getCard).toBe(2);
    expect(calls.listCards).toBe(2);
  });

  it('addComment invalidates that card’s comments only', async () => {
    const { adapter, calls } = makeAdapter({ cards: [makeCard('c1')] });
    let clock = 1000;
    const wf = wrapWorkflowWithCache(adapter, {
      store: createContextStore(),
      now: () => clock,
      validationTtlMs: TTL,
    });

    await wf.listComments(ENV, BOARD, 'c1');
    await wf.listComments(ENV, BOARD, 'c1'); // cached
    expect(calls.listComments).toBe(1);

    await wf.addComment(ENV, BOARD, 'c1', 'hi');
    await wf.listComments(ENV, BOARD, 'c1'); // re-fetch
    expect(calls.listComments).toBe(2);
  });
});

describe('wrapWorkflowWithCache — park + restore (the stateless-host handoff)', () => {
  it('a restored store serves board reads with no source access', async () => {
    const store = createContextStore();
    const clock = 5000;
    const live = makeAdapter({
      cards: [makeCard('c1', { title: 'Hello' })],
      columns: [{ id: 'col-1', name: 'Todo' }],
    });
    const warm = wrapWorkflowWithCache(live.adapter, {
      store,
      now: () => clock,
      validationTtlMs: TTL,
    });

    // Warm the cache, then park it.
    await warm.getCard(ENV, BOARD, 'c1');
    await warm.listColumns(ENV, BOARD);
    const blob = store.serialize();

    // Another (stateless) host picks it up and wraps a source that
    // would throw if touched — within the grace window, it isn't.
    const restored = createContextStore({ serialized: blob });
    const picked = wrapWorkflowWithCache(throwingAdapter, {
      store: restored,
      now: () => clock,
      validationTtlMs: TTL,
    });

    const card = await picked.getCard(ENV, BOARD, 'c1');
    expect(card.title).toBe('Hello');
    const cols = await picked.listColumns(ENV, BOARD);
    expect(cols).toEqual([{ id: 'col-1', name: 'Todo' }]);
  });
});
