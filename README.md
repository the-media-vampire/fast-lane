# Fast Lane

An editable film studio prototype: **Brief → Concept → Assets → Shots → Direct → Cut**. Astra is the conversational collaborator; the shared scene sampler drives the camera view, overhead blocking view and animatic timeline.

This release contains the application source, local fonts and their licenses, offline checks, and original illustrative storyboard placeholders. It starts with a new local database. It includes no private projects, database backups, credentials, generated films or account connections.

## Run locally

Use Node 22.13 or newer. Fresh installs and production builds were verified on Ubuntu 24.04 with Node **22.13.1 and 24.10.0**, using pnpm **10.32.1**. Install ffmpeg/ffprobe before running the checks; they are also needed for media inspection and capture work. For example, on Ubuntu: `sudo apt-get install ffmpeg`.

```sh
git clone https://github.com/the-media-vampire/fast-lane.git
cd fast-lane
npm install --global pnpm@10.32.1
pnpm install --frozen-lockfile --ignore-scripts
cp .env.example .env.local
pnpm build
pnpm start --hostname 127.0.0.1
```

Open http://localhost:3100. The sample project is illustrative. `FASTLANE_LIVE=off` and `FASTLANE_WORKER=off` are the example defaults. The app stores new work under `./data`; use `FASTLANE_DATA_DIR` to choose another location.

For development, use `pnpm dev --hostname 127.0.0.1` instead of the build/start commands. Install Chromium with `pnpm exec playwright-core install chromium` only if using grey-frame captures; those browser captures were not part of the fresh-install acceptance.

## First useful agent task: edit and export a camera plan

With the local server running and services off, an agent can use ordinary HTTP requests:

1. `POST /api/sample` with `{}` to obtain an illustrative project's `id`.
2. `GET /api/projects/{id}` and select a shot from `shots.items`.
3. `POST /api/projects/{id}/ops` with the selected shot ID:

   ```json
   {"op":"direct_shot","input":{"shotId":"REPLACE_WITH_SHOT_ID","commands":[{"op":"set_lens","mm":50}],"summary":"Adjust the camera plan."}}
   ```

4. `GET /api/projects/{id}/shots/{shotId}/blocking` to save the scene and sampled camera plan as JSON. It includes the blocking revision, frame rate, camera samples and lens values. The edited plan persists across a server restart.

Send JSON requests with `Content-Type: application/json`. The sample frames are illustrative SVGs. This task edits reusable scene data; it does not render footage or invoke paid services. See [the executable first-run check](scripts/check-first-run.mjs) for the complete create/edit/export/restart sequence, including rejected-input verification.

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
pnpm build
pnpm check:first-run
```

`pnpm check` passed TypeScript and 618 offline assertions on both tested Node versions. The first-run check starts its own built server on port 3197, uses a new `data/acceptance-*` directory, and leaves its database and `first-run.json` receipt there for inspection. It keeps provider credentials blank and services off. Choose a different port with `FASTLANE_ACCEPTANCE_PORT` if needed.

The [verified CI run](https://github.com/the-media-vampire/fast-lane/actions/runs/41143587934) also isolates the first-run server from external networking. Running the command locally does not itself create that network boundary. See [.github/workflows/first-run.yml](.github/workflows/first-run.yml) for the Linux isolation command and [RELEASE.json](RELEASE.json) for exact validation limits. No paid generation or finished-film acceptance is claimed.

Contributions can extend the adapters, add tests or compare production methods. Discuss workflows at [Veyrul](https://veyrul.com/docs/join).

## License

Application source is MIT licensed. Bundled Inter and Instrument Serif fonts retain their SIL Open Font Licenses in `app/fonts/`. Dependencies keep their own licenses.
