import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// The in-game part runs against stand-ins for Etterna's Lua functions (tests/theme/harness.lua).
const lua = spawnSync('lua', ['-v'], { encoding: 'utf8' });

describe('the in-game part', () => {
  it.skipIf(lua.error !== undefined)('plays through Sync, Apply, Undo, an uncertain answer and a silent page', () => {
    const run = spawnSync('lua', ['tests/theme/harness.lua'], { encoding: 'utf8' });
    expect(run.stdout).toContain('all passed');
    expect(run.status).toBe(0);
  });
});
