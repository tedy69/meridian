# Dependency security status

## Production install policy

Install production dependencies with:

```bash
npm ci --ignore-scripts
npm run postinstall
```

The committed `.npmrc` disables dependency lifecycle scripts by default. The
explicit postinstall applies the reviewed Node ESM compatibility patch and
verifies that `bigint-buffer` has no native `.node` binding. The same verifier
runs when Meridian loads its runtime configuration, so a process fails closed
if an unsafe install is detected.

## Current upstream exception

As of 2026-08-26, `npm audit --omit=dev --audit-level=high` still reports
`bigint-buffer@1.1.5` through the Meteora DLMM and legacy Solana Web3 stack.
There is no patched release available on that dependency path. The advisory is
for its optional native addon; Meridian prevents that addon from being built or
loaded and uses the package's built-in JavaScript fallback instead.

The audit also retains moderate `uuid` findings through legacy `jayson` and
`node-cron` dependency paths without a non-breaking upstream fix.

Reassess this exception before any live release and no later than 2026-09-25.
Remove the mitigation once Meteora's SDK can use a patched Solana client stack.
