# Community extension

- Keep the existing game and website unchanged unless a specific integration
  requires a small, reviewable edit. The user wants the original developer to
  be able to review and reuse this contribution easily.
- Put addon code, build configuration and reproducible runtime patches here.
  Preserve original release bundles; generate local copies under `.runtime/`.
- For catalogue controls, reuse original Phaser controls and their bitmap fonts
  where a matching game control exists. Cropping its texture into a CSS button
  is not equivalent reuse.
- Follow the approved execution plan in `../docs/plans/custom-maps-execution-plan.md`.
  Gate verified statistics on independently checked adapter parity and strict
  validation. Never trust submitted snapshots, AI actions or claimed victory.
- Players remain anonymous. Curator authorization is separate from public play.
- Keep the public player experience on one unchanged URL; catalog, map details,
  gameplay and return navigation must not change its path, query or fragment.
- Keep personal profiles, secrets, generated runtime copies and scratch captures
  out of commits. Commit only the files owned by the assigned task.
- The coordinator owns shared contracts, dependencies and integration. Use
  isolated task branches/worktrees for concurrent changes and report exact checks.
- Tests run through `npm test -- tests/example.test.ts`; `npm run build` checks
  types. Native Node TypeScript execution does not perform type checking.
