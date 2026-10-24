# Archived Cal.diy workflows

These inherited workflows are outside `.github/workflows` so GitHub Actions cannot run them automatically or expose them as manually dispatched workflows.

They target the retired Next.js, Prisma, API v2, Atoms, Playwright, translation, release, cron, and report infrastructure. The old PR-label CI dispatcher and upstream welcome message are archived with them. Reusable workflow paths inside this archive are historical and are not runnable in place.

Active application CI is `.github/workflows/ci.yml`. It checks the root Astro/Workers workspace with the vendored Yarn executable and does not require repository secrets or deploy anything. Issue staleness, PR labels, PR title validation, and cache cleanup remain active maintenance workflows.

Restoring an archived workflow requires reviewing its triggers, permissions, secrets, commands, and workspace paths for the current project. In particular, do not restore the legacy `pull_request_target` CI graph that runs PR code with inherited secrets.

Branch protection settings are managed outside this repository. Replace required legacy job names with `Astro and Workers checks` when adopting this CI.
