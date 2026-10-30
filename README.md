# Cal.flare

Cal.flare runs a single-owner scheduling app on Cloudflare Workers with static assets and D1.
Astro and React serve one configured organizer with multiple events, Google sign-in, owner settings,
conflict-calendar selection, public booking, attendee and owner changes, calendar exports, and durable recovery.
Google event operations use the owner's primary calendar. Selected calendars can block availability.
The owner creates and selects events at `/` using stable event IDs. Each event has independent details,
booking rules, and a public slug page. Working hours, timezone, dated overrides, and conflict calendars
are shared. Renaming a slug preserves pending requests, receipts, and historical private booking links.
Deletion, duplication, hiding, reusable schedules, additional organizers, and destination calendars are not supported.

Local Worker, D1, and browser checks use mocked Google responses.
Live Google authorization, invitation arrival, deployed behavior, and production usage remain unverified.
These checks establish neither full Cal.diy feature or visual parity nor suitability for any Cloudflare plan.

## Install and build locally

Use Git, [Mise](https://mise.jdx.dev/), Node 24.22.1, and the bundled Yarn 4.12.0.
Run these commands in your checkout. If the pinned Node version is already active, omit `mise exec --`.

```sh
git clone https://github.com/ralphbibera/cal.flare.git
cd cal.flare
mise install
mise exec -- node .yarn/releases/yarn-4.12.0.cjs install --immutable
mise exec -- node .yarn/releases/yarn-4.12.0.cjs build
```

The build produces `apps/flare/dist/server/wrangler.json` and static assets in `apps/flare/dist/client`.
This is a local artifact check. Deployment requires a fresh build after production configuration.

## Configure, deploy, and accept

Follow [Configure and run Cal.flare](apps/flare/SETUP.md) in order.
It covers local configuration, Google consent, local D1, and the production procedure.
For production, prepare a Cloudflare account with Workers and D1 access, its account ID and Workers subdomain,
a Google OAuth web client, and the owner's verified Google email.
The guide uses a Workers hostname, private Wrangler secret prompts, D1 migrations, and an explicit deploy command.
Complete its post-deploy checklist before relying on bookings, then use its upgrade and recovery steps.

For local commands and implementation details, use the [development guide](apps/flare/README.md).
The [architecture and migration history](docs/porting/cloudflare-astro.md) records the original plan and experiments.

## License and upstream history

Cal.flare is an independent port of [Cal.diy](https://github.com/calcom/cal.diy).
The [MIT license](LICENSE) retains Copyright (c) 2020-present Cal.com, Inc.
Preserve that copyright and permission notice when redistributing this work.
The [pinned upstream README](https://github.com/calcom/cal.diy/blob/0f19cc46ef6b6426ee398c670575b3c96be7af9e/README.md)
preserves the inherited application's documentation and attribution.
