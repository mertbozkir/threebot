# Contributing

```sh
npm run setup
npm run check
```

`npm run dev` serves the web app on port 5180 and proxies to a gateway on `127.0.0.1:3780`. `scripts/fixture.mts` runs the real gateway against a scripted T3, so most work needs no real agents.

To see the app with disposable data, run `node scripts/fixture.mts --scenario <name>` and open the printed URL, or `node scripts/local-pwa-dev.mts --scenario <name>` for hot reload. `interactions` covers questions, approvals and secret cards; `latest-t3` covers what newer T3 Code versions add (a child's approval in its parent chat, Force stop, one-time and policy-blocked routines, a Bot whose project was archived in T3 Code). `avatars` has many object avatars and answers the avatar editor's background drawings with a scripted definition. `release-notes` offers a fake next release with notes in T3 Code's format, gives the running version GitHub's generated notes and shows the "Updated to" notice, for Settings → Updates and the update button's popover (the button needs an installed copy run as a service, so it doesn't show in a fixture). `activity` puts fourteen Bots in different activities at once, with Alpha walking through a scripted turn and Theta waking for short runs, for checking the avatars. When T3 Code changes a contract Threebot reads, add it to a scenario in `scripts/fixture-scenarios.mts` and a check in `scripts/fixture.test.mts`.

Keep changes small and include a test. Bots are threads, not roles: new features should build on T3 Code's primitives rather than duplicate them.
