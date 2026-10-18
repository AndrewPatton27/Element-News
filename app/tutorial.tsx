// /tutorial: replays the first-run tour (components/Tutorial.tsx). Linked from Me and
// About. Finishing or skipping marks the tour seen and goes to the feed (or sign-up).

import { router } from 'expo-router';
import { Tutorial } from '../components/Tutorial';
import { markTutorialSeen } from '../lib/tutorialLogic';
import { defaultStore } from '../lib/storage';

export default function TutorialScreen() {
  return (
    <Tutorial
      onExit={(how) => {
        markTutorialSeen(defaultStore());
        router.replace((how === 'signup' ? '/signin?mode=signup' : `/?tab=top&t=${Date.now()}`) as never);
      }}
    />
  );
}
