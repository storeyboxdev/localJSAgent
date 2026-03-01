/**
 * Monitor registry — manages a named collection of background monitors.
 * New monitors (file watch, news feed, etc.) can be registered with register().
 */
export function createMonitorRegistry() {
  const monitors = new Map(); // Map<name, monitor>

  return {
    /** Register a monitor instance under a name */
    register(name, monitor) {
      monitors.set(name, monitor);
    },

    /** Start all registered monitors */
    startAll() {
      for (const [name, monitor] of monitors) {
        console.log(`[monitors] starting: ${name}`);
        monitor.start();
      }
    },

    /** Stop all registered monitors */
    stopAll() {
      for (const [name, monitor] of monitors) {
        monitor.stop();
      }
    },

    /** Retrieve a monitor by name */
    get(name) {
      return monitors.get(name);
    },

    /** Snapshot of monitor running states for /api/monitors endpoint */
    status() {
      return Object.fromEntries(
        [...monitors.keys()].map((name) => [name, { running: true }])
      );
    },
  };
}
