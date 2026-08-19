# Deploying Sonic Morse to Vercel

This repository contains a Vercel import configuration. The Vite client is built and copied to `public/` during the Vercel build, while `server.ts` exports the Express application as a serverless function. Vercel serves the static client through its CDN and invokes the server only for application routes such as tRPC, OAuth, and protected ElevenLabs voice readout.

## Import steps

Open [Vercel’s new-project import page](https://vercel.com/new), choose `itsjustayush/sonicwavegg`, and retain the repository root as the project root. Vercel will read `vercel.json`; no custom framework preset, build command, or output directory needs to be entered manually. Before pressing **Deploy**, add the environment variables listed in `.env.example` for Production, Preview, and Development as appropriate.

| Variable | Why it is required |
| --- | --- |
| `ELEVENLABS_API_KEY` | Enables optional server-side voice readout. Do not expose it as a `VITE_` variable. |
| `DATABASE_URL` | Supports the application’s user database. |
| `JWT_SECRET` | Signs session cookies. Use a newly generated high-entropy value. |
| `OAUTH_SERVER_URL`, `VITE_APP_ID`, `VITE_OAUTH_PORTAL_URL` | Required if retaining the included Manus OAuth flow. The OAuth callback must allow `https://sonicwavegg.vercel.app/api/oauth/callback`. |
| `BUILT_IN_FORGE_*` variables | Needed only for the corresponding Manus-backed functions retained in the template. |

## Compatibility caveats

The acoustic sender and receiver run locally in the user’s browser using the Web Audio and MediaDevices APIs; that core behavior is compatible with Vercel. However, a Vercel import does not copy managed Manus database, OAuth, storage, or secret infrastructure. Before relying on the external deployment, replace or configure those integrations with services that are valid outside Manus. In particular, the protected ElevenLabs readout needs a Vercel environment variable, and the login flow needs an OAuth configuration whose callback allows the Vercel domain.

This project is configured for the expected public URL `https://sonicwavegg.vercel.app`. If Vercel assigns a different project slug, update the OAuth allowlist and any environment variables that reference the site URL.
