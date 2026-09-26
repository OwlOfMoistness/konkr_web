# Reviewed engine configuration coverage

The machine-readable policy is `shared/supported-configurations.json`. It admits
exact ordered plugin sequences for the pinned 2.35.30 main digest
`29377f4e0a30607db86558af7f09cfe546dca5e9993fb87060fdb2eb160cd98a` and
adapter `konkr-node-1`. The adapter separately pins the vendor digest. All other
engine versions or plugin sequences fail closed.

| Ordered map plugins | Normal | Hard | Evidence |
| --- | --- | --- | --- |
| `[]` | Supported | Supported | Tiny complete wins, purchase win, defeat, genuine surrender and unfinished play; Prison first round |
| `["spawn-gifts", "buy-gifts"]` | Supported | Supported | Original-price gift purchase and two rounds of automatic spawning in Escalating Quickly |

This is simulation support evidence. Production statistics still require the
independent validation/recording review and the service integration gates in the
execution plan. The policy is not deployment authorization.

## Gift-rule evidence

`tests/fixtures/modifier-cases.json` contains two fresh original-browser cases,
each captured twice using pinned Chromium 153.0.8010.12. Each starts from the
supplied canonical Escalating Quickly map, whose content digest is
`154dd5bbbaf0d5a8bbf51bce3cffe2717e193d50e9dfeaf1dd9befa423c4f49a`.
The sequence buys a present at hex 704 from region 16, then ends two player turns.
The actual shop price is 10 coins, and the purchase consumes all ten coins in
that region. New gifts appear in each of the following neutral phases, beyond
the purchased gift. The map remains unfinished on turn three.

Each difficulty has 16 checkpoints covering the initial state, purchase, player
turn endings, each AI faction and neutral turn. Browser repeat digests match,
and Node reproduces every checkpoint and the complete projected trace digest.
The public validation worker independently returns the same non-winning result.
The two difficulties happen to produce identical states in this short supplied
map trace; both were actually selected and run in fresh original browser contexts.

All raw checkpoint fields are retained. The only comparison exclusion is the
generated region name, for the source-backed reason recorded in
`adapter-parity.md`. Arrays, seeds, faction order, treasuries, pawn identities,
turns and plugin order remain intact. No later snapshot repairs the simulation.

Adversarial purchase tests cover insufficient treasury after the first purchase,
an opposing buyer region, an occupied town destination, a town absent from the
shop, and an injected zero-price parameter. A present purchase without the gift
shop modifier is rejected. These checks call the same boundary as ordinary play;
there is no modifier-specific privileged command path.

## Unsupported combinations

The reversed gift sequence, either gift modifier alone, zombies, landing setup,
always-retreat, buy-towns, capture-towns, low-upkeep and any other combination are
unsupported. Their presence in the map-format parser means they are recognized
data, not that they are approved for publication or scored play. Scripted maps,
custom AI/rules, custom win conditions and fixed difficulty remain outside the
accepted map subset. Surrender uses the same original offer predicate as ordinary
play; modifiers cannot submit an internal winning event directly.

Publication, run creation and worker construction must receive the same loaded
policy through the shared `supports` contract. Preserve plugin order when saving
a revision or comparing its run binding. Do not turn an unsupported result into
a fallback configuration or auto-add a configuration after an upload succeeds.
New coverage requires genuine browser repetitions, exact Node parity, strict
player-decision tests and review before expanding the JSON policy.

## Reproduction

From `community/`, normal verification consumes the committed evidence:

```sh
npm test -- tests/modifier-parity.test.ts tests/validation.test.ts tests/adapter-parity.test.ts
npm run build
```

To regenerate only the modifier evidence in fresh browser contexts using an
already installed pinned Chromium, explicitly enable fixture writing:

```sh
PLAYWRIGHT_BROWSERS_PATH=/path/to/pinned-cache KONKR_CAPTURE_MODIFIERS=1 npm test -- tests/modifier-parity.test.ts
```

The generator uses the committed canonical map, binds a local loopback server,
blocks external requests and verifies browser version and repeat equality before
writing the fixture. Generated runtime copies remain ignored. Review any fixture
change; regenerated hashes do not independently approve gameplay differences.
