Read this before every task; add to it after every task. Short bullets, no secrets.

## Facts (things checked, each with source + date)

- Fork of https://github.com/jamesondh/chimera-vocal-synth under mikelism. GitHub reports `fork: true`, parent `jamesondh/chimera-vocal-synth`, license MIT on both. `LICENSE` is still the MIT text (Copyright (c) 2026 Jameson Hodge). Attribution "Choir 95 demo built on Chimera by jamesondh (MIT)." is in `README.md` and the `/choir95` About dialog (`src/ui/choir95/Choir95.tsx`). 98.css (MIT, Jordan Scales) is credited in `README.md`, `src/ui/choir95/choir95.css`, and that About dialog. Source: GitHub repository `mikelism/chimera-vocal-synth`, `LICENSE`, `README.md`, `src/ui/choir95/Choir95.tsx`, `src/ui/choir95/choir95.css`. 2026-11-21.
- Engine is Rust compiled to WASM and committed as `vendor/chimera.wasm` (1,066,292 bytes) so a Vercel build needs no Rust when `CHIMERA_PREBUILT=1`. UI is React + Vite, installed with Bun (`package.json`, `bun.lock`). `CHIMERA_PREBUILT=1 bun run build` printed `using prebuilt vendor/chimera.wasm (1066292 bytes)` and wrote `dist/`. Source: `scripts/ensure-wasm.mjs`, `vendor/chimera.wasm`, `package.json`, that command. 2026-11-21.
- Vercel project `chimera-choir95` (`prj_NonSfjiLwUmoSATRBnLjpRasbTSz`) is on team Diverse greier, slug `diverse-greier`, id `team_wIjRi4lHgBbgx2dHVXFLSJ1d`. Settings: framework vite, Node `22.x`, install `bun install --frozen-lockfile`, build `CHIMERA_PREBUILT=1 bun run build`, output `dist`. Source: Vercel `get_team` and `get_project`, `vercel.json`, `package.json` `engines.node`. 2026-11-21.
- Public alias https://chimera-choir95.vercel.app/choir95 returns HTTP 200 with no login. Deployment URL https://chimera-choir95-jg919bh3b-diverse-greier.vercel.app returns HTTP 302 to `https://vercel.com/sso-api`. Project SSO protection is on, `deploymentType` `all_except_custom_domains`. Source: `curl -sI` on both URLs, Vercel `get_project` `ssoProtection`. 2026-11-21.
- Deployment `dpl_tHXmgKX7MyjZWhoaWhVDyuCQkFcP` is the project's only deployment, state READY, target production. Every listed domain is a `vercel.app` hostname (no custom domain). Source: Vercel `get_deployment`, `list_deployments` (count 1), `get_project` `domains`. 2026-11-21.
- Sound Recorder takes stop at 60 seconds (`ChoirEngine.maxSeconds = 60`). WAV export writes 16-bit PCM (`encodeWav` in `src/ui/choir95/wav.ts`, called from `src/ui/choir95/Choir95.tsx`). Source: those files. 2026-11-21.

## Decisions (what we chose, why, date)

- 2026-11-13: Deploy ONLY to Vercel team diverse-greier, never another team or personal scope; confirm scope before every deploy; if the team isn't accessible, stop and tell the user instead of falling back. Why: user's hard requirement.
- 2026-11-13: Vercel preview-style deploys only: no custom domains, no paid spend, no secrets in commits. Why: user rule relayed via Iris.
- 2026-11-13: Build one focused demo (Choir 95, a Win95 choir keyboard at /choir95) on the fork rather than a new repo. Why: user likes keyboard instruments + Win95/90s nostalgia.
- 2026-11-13: Commit the prebuilt WASM so Vercel needs no Rust toolchain. Why: simpler, free builds.
- 2026-11-21: Adopt shared project notes (this file). Why: new team rule.

## Open questions (what's unknown or failing, and who owns it)

- Merge PR #1 into main? Owner: user. Not merged (`gh pr view 1` state OPEN, mergedAt null, 2026-11-21).
- Keep the first deploy as production target, or move to preview-only deploys? Owner: user.
- Keep Vercel SSO on deployment URLs (public alias works) or relax protection? Owner: user.
