// The fixtures are dated 2026-10-03..17 and the tests inject a fixed `now` (DRY_NOW). Production date
// windows were widened later (CPSC 180 days, SEC 90, NASA/Federal Register 90, BEA/Fed 120), which pulls in more
// fixture rows than the old assertions expect. Importing this file pins the windows the fixtures were
// written for, for this test process only. Production values in config.ts are not changed.
import { config } from '../../src/config.ts';

const c = config as unknown as Record<string, any>;
c.fedMaxAgeDays = 14;
c.beaMaxAgeDays = 30;
c.fedRegister.maxAgeDays = 14;
c.cpsc.lookbackDays = 14;
c.cpsc.maxPerRun = 5;
c.nasa.maxAgeDays = 14;
c.secLookbackDays = 14;
c.secLookbackDays = 10;
