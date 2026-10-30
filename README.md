# Fast Lane

An editable film studio prototype: **Brief → Concept → Assets → Shots → Direct → Cut**. Astra is the conversational collaborator; the shared scene sampler drives the camera view, overhead blocking view and animatic timeline.

This release contains the application source, local fonts and their licenses, offline checks, and original illustrative storyboard placeholders. It starts with a new local database. It includes no private projects, database backups, credentials, generated films or account connections.

## Run locally

Use Node 22.13 or newer and pnpm. ffmpeg/ffprobe are needed for media inspection and capture work. Install Chromium with `pnpm exec playwright-core install chromium` if using grey-frame captures.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Open http://localhost:3100. The sample project is illustrative. `FASTLANE_LIVE=off` and `FASTLANE_WORKER=off` are the example defaults. The app stores new work under `./data`; use `FASTLANE_DATA_DIR` to choose another location.

## Connect your services

For Astra and planning, add your own `ANTHROPIC_API_KEY` and remove `FASTLANE_LIVE=off` when you intend to make paid calls. Never put credentials in browser code or Git. The background worker normally starts with the server; remove `FASTLANE_WORKER=off` when ready to run queued jobs.

**Media generation is not connected in this prototype.** Implement `MediaServices` in `lib/adapters/media.ts` using the shapes in `lib/adapters/contract.ts`. The interface covers image/video submission and polling, voice, music, file publishing, inspection and assembly. The existing adapter returns a clear `not_connected` error. Provider keys in `.env.example` are blank suggestions for an implementation, not bundled service access.

Map the placeholder voice IDs in `lib/voices.ts` to voices available under your own provider account.

Preserve `MediaError` semantics: an uncertain paid submission is `ambiguous` and held for reconciliation; never submit it again merely because a response timed out. Billing gates are in `lib/billing.ts` and `lib/providers.ts`.

## Explore and extend

- `lib/blocking/`: one scene sampler, camera/framing logic, actor and prop motion, exports.
- `components/blocking/`: camera, overhead and timeline views.
- `lib/agent/astra.ts`: agent instructions and tools.
- `lib/approvals.ts`, `lib/ops.ts`, `lib/jobs.ts`: edit, approval and job behavior.
- `lib/adapters/`: the media integration boundary.
- `app/api/`: local application routes.

Direct exports scene/camera data for an external production pipeline. Its three.js blocking preview is not a rendered performance or a claim of completed film production. This prototype is intended for local use; review authentication, isolation and deployment requirements before exposing a multi-user service.

## Checks

```sh
pnpm check
```

The checks use controlled providers. See `RELEASE.json` for the exact release checks that were run; defining a check does not prove it passed. Contributions can extend the adapters, add tests or compare production methods. Discuss workflows at [Veyrul](https://veyrul.com/docs/join).

## License

Application source is MIT licensed. Bundled Inter and Instrument Serif fonts retain their SIL Open Font Licenses in `app/fonts/`. Dependencies keep their own licenses.
