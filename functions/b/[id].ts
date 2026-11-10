// Cloudflare Pages Function for the shared-card page /b/<id>. Serves the app's index.html with the card's
// Open Graph / Twitter tags (headline as title, first sentence of the blurb as description, never an image),
// so a pasted link shows a preview. The app's own route app/b/[id].tsx then renders the card.
// All the logic is in lib/share/shareFunction.ts (tested in lib/__tests__/sharePage.test.ts); any problem
// falls back to the normal static answer (context.next()). Uses only the Supabase publishable key (rule 10).
// See functions/functions.md.

import { handleShareRequest, type ShareEnv } from '../../lib/share/shareFunction.ts';

interface PagesContext {
  request: Request;
  params: { id?: string | string[] };
  env: ShareEnv & { ASSETS: { fetch(input: string | Request): Promise<Response> } };
  next(): Promise<Response>;
}

export const onRequest = (context: PagesContext): Promise<Response> => {
  const raw = context.params.id;
  return handleShareRequest({
    request: context.request,
    id: Array.isArray(raw) ? raw[0] : raw,
    env: context.env,
    asset: (url) => context.env.ASSETS.fetch(url),
    fallback: () => context.next(),
  });
};
