# Cal.flare

Self-hosted scheduling on Cloudflare.

A port of [Cal.diy](https://github.com/calcom/cal.diy), built with Astro, React, Cloudflare Workers, and D1.
Create booking pages, set your availability, and let people book time with you.

[Deploy to Cloudflare](apps/flare/SETUP.md#deploy-to-cloudflare-workers) ·
[Local setup](apps/flare/SETUP.md) ·
[Development guide](apps/flare/README.md)

## Features

- Publish booking pages and a public event directory.
- Reuse availability schedules with timezones, weekly hours, and date overrides.
- Connect Google Calendar to check conflicts and create calendar events.
- Reschedule or cancel bookings, manage them as the owner, and download calendar files.

## Get started

You'll need a Cloudflare account with Workers and D1 access, plus a Google OAuth web client.
The [setup guide](apps/flare/SETUP.md) walks through Google access, configuration, deployment, and upgrades.

## Development

Install [Mise](https://mise.jdx.dev/), then run:

```sh
git clone https://github.com/ralphbibera/cal.flare.git
cd cal.flare
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run dev
```

Mise selects Bun 1.4.4 for dependency installation and JavaScript/TypeScript tooling.
Complete the [local configuration](apps/flare/SETUP.md#create-local-configuration) to enable Google sign-in and bookings.
See the [development guide](apps/flare/README.md) for build and test commands.

## Project status

Cal.flare is under active development. The current app supports one organizer and Google Calendar,
with calendar events written to the owner's primary calendar. Full Cal.diy parity is still in progress.

Local checks use mocked Google responses. Live Google delivery and production deployment still need verification.
The [development guide](apps/flare/README.md) documents supported behavior and verification limits.
The [porting guide](docs/porting/cloudflare-astro.md) records architecture decisions and migration history.

## License

[MIT](LICENSE). Based on Cal.diy and the work of Cal.com and its contributors.
Copyright (c) 2020-present Cal.com, Inc.
