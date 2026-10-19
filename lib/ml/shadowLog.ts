// Shadow logging for the ranking experiments (docs/work/ml-integration-plan.md).
// The server returns a `page_id` with each feed page for signed-in readers. The app remembers it per
// card and surface, and sends it back with the `view` event together with the slot (the card's
// position on screen as the reader saw it, after any client re-ordering) and the surface.
// Everything here is a no-op when page_id is absent (guests, sample mode, old server).

export const SHADOW_SURFACES = ['trending', 'latest', 'for_you', 'following', 'search'] as const;
export type ShadowSurface = (typeof SHADOW_SURFACES)[number];

/** Argument names of the new optional api.track parameters (Bob's B2: p_page, p_slot, p_surface). */
export interface ShadowTrackArgs {
  p_page?: string;
  p_slot?: number;
  p_surface?: ShadowSurface;
}

export interface ShadowContext {
  pageId: string;
  slot: number;
  surface: ShadowSurface;
}

const MAX_SLOT = 499;
const MAX_ENTRIES = 2000;

export function surfaceForTab(tab: string): ShadowSurface | null {
  if (tab === 'top') return 'trending';
  if (tab === 'latest') return 'latest';
  if (tab === 'for_you') return 'for_you';
  return null;
}

export function isShadowSurface(x: unknown): x is ShadowSurface {
  return typeof x === 'string' && (SHADOW_SURFACES as readonly string[]).includes(x);
}

/** The reader's position of a card in the list as displayed; null when not found or out of range. */
export function displayedSlot(shown: ReadonlyArray<{ id: string }>, cardId: string): number | null {
  const i = shown.findIndex((c) => c.id === cardId);
  return i >= 0 && i <= MAX_SLOT ? i : null;
}

export interface PageIdMap {
  /** Records the page for every card on it; the first page seen for a card and surface is kept. */
  note(surface: ShadowSurface | null, page: { items: ReadonlyArray<{ id: string }>; page_id?: unknown }): void;
  get(surface: ShadowSurface, cardId: string): string | undefined;
  clear(): void;
}

export function createPageIdMap(max = MAX_ENTRIES): PageIdMap {
  const m = new Map<string, string>();
  return {
    note(surface, page) {
      if (!surface || typeof page.page_id !== 'string' || page.page_id === '') return;
      for (const c of page.items) {
        const k = `${surface}|${c.id}`;
        if (m.has(k)) continue;
        if (m.size >= max) m.delete(m.keys().next().value as string);
        m.set(k, page.page_id);
      }
    },
    get: (surface, cardId) => m.get(`${surface}|${cardId}`),
    clear: () => m.clear(),
  };
}

/** The app-wide map (one per page load). */
export const pageIds = createPageIdMap();

/** Builds the context for a view event, or null when there is nothing valid to send. */
export function shadowContext(surface: ShadowSurface | null, shown: ReadonlyArray<{ id: string }>, cardId: string, map: PageIdMap = pageIds): ShadowContext | null {
  if (!surface) return null;
  const pageId = map.get(surface, cardId);
  const slot = displayedSlot(shown, cardId);
  if (!pageId || slot === null) return null;
  return { pageId, slot, surface };
}

/** The extra RPC arguments; empty (so the call is exactly the old one) without a valid context. */
export function shadowArgs(ctx: ShadowContext | null | undefined): ShadowTrackArgs {
  if (!ctx || !ctx.pageId || !Number.isInteger(ctx.slot) || ctx.slot < 0 || ctx.slot > MAX_SLOT || !isShadowSurface(ctx.surface)) return {};
  return { p_page: ctx.pageId, p_slot: ctx.slot, p_surface: ctx.surface };
}

/** True when a failed track call looks like the server not knowing the new arguments (migration not applied). */
export function isUnknownArgsError(status: number): boolean {
  return status === 404 || status === 400;
}
