'use strict';

// The plugin's clock. Everything that depends on the time of day (polling
// window, quiet hours, "has the lesson ended?") asks clock.now(); the tests
// pin it with clock.set(ms) and move it with clock.advance(ms).

let fixed = null;

module.exports = {
  now: () => (fixed == null ? Date.now() : fixed),
  set(ms) { fixed = ms == null ? null : Number(ms); },
  advance(ms) { fixed = (fixed == null ? Date.now() : fixed) + Number(ms); },
};
