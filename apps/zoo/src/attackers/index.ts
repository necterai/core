import type { Attacker } from '../lib/types.js';
import { fetchers } from './fetchers.js';
import { browsers } from './browsers.js';
import { playwrightPython } from './playwright-python.js';
import { playwrightMcp } from './playwright-mcp.js';
import { extensionAgentSim } from './extension-agent.js';
import { xdotoolSim } from './xdotool-sim.js';
import { atNvdaSim } from './at-nvda-sim.js';
import { passwordManagerSim } from './password-manager-sim.js';

export const ALL_ATTACKERS: Attacker[] = [...fetchers, ...browsers, playwrightPython, playwrightMcp, extensionAgentSim, xdotoolSim, atNvdaSim, passwordManagerSim];

const names = new Set<string>();
for (const a of ALL_ATTACKERS) {
  if (names.has(a.name)) throw new Error(`duplicate attacker name ${a.name}`);
  names.add(a.name);
}
