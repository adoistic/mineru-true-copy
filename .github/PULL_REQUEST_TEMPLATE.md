## Summary

<!-- 1-3 bullets: what changed and why -->

-

## Test plan

<!-- What did you actually run? Check what applies. Add lines for anything project-specific. -->

- [ ] `npm run lint` (in `app/`) — clean
- [ ] `npx vitest run` (in `app/`) — all green
- [ ] `cargo check` (in `src-tauri/`) — clean
- [ ] `pytest lib/tests/` — all green (or noted exemption: e.g., frontend-only change with no Python venv)
- [ ] Manual smoke test in `tauri dev` — describe what you exercised

## Checklist

- [ ] Linked the relevant issue (`Closes #N`) — or noted that there isn't one
- [ ] `NOTICE` updated if a new third-party dependency was added (package, license, copyright holder)
- [ ] Documentation updated if user-facing (README, CONTRIBUTING, ARCHITECTURE, ROADMAP, or HELP-WANTED as appropriate)
- [ ] No forbidden post-AGPL-relaunch symbols reintroduced (`firebase`, `deductCredit`, `activationKey`, `ActivationScreen`) — the CI strip-clean job will block merge if so

## Anything else

<!-- screenshots, follow-ups, known gaps, deferred work -->
