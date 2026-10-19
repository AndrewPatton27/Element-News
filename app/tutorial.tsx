// /tutorial: replays the first-run tour (components/Tutorial.tsx). Linked from Me and
// About. Finishing or skipping marks the tour seen and goes to the feed (or sign-up).
// The tour is loaded on demand so it stays out of the shared first-load chunk.

import { lazy, Suspense } from 'react';
import { router } from 'expo-router';
import { markTutorialSeen } from '../lib/tutorial/tutorialLogic';
import { defaultStore } from '../lib/storage/storage';

const Tutorial = lazy(() => import('../components/tutorial/Tutorial').then((module) => ({ default: module.Tutorial })));

export default function TutorialScreen() {
  return (
    <Suspense fallback={null}>
      <Tutorial
        onExit={(how) => {
          markTutorialSeen(defaultStore());
          router.replace((how === 'signup' ? '/signin?mode=signup' : `/?tab=top&t=${Date.now()}`) as never);
        }}
      />
    </Suspense>
  );
}
