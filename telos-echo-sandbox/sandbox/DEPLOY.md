# Telōs Echō Sandbox — deploy (about 15 min)

Needs a computer with Node 20+ for steps 1–3. Everything after that works from your iPhone.
Until step 5 is done the Worker **refuses every request** (fails closed), so it is never exposed half-configured.

**1. Install** — unzip, then in Terminal: `cd sandbox && npm install`
**2. Sign in** — `npx wrangler login` (opens a browser, sign in to your Cloudflare account)
**3. Deploy** — `npx wrangler deploy`  → note the URL `https://telos-echo-sandbox.<you>.workers.dev`

**4. Turn on Cloudflare Access (your login gate)**
1. dash.cloudflare.com → **Zero Trust**. First time: choose a team name and the **Free** plan (a card may be requested; $0).
   Your team domain is `<team>.cloudflareaccess.com`.
2. **Workers & Pages → telos-echo-sandbox → Settings → Domains & Routes** → on the `workers.dev` row choose **Enable Cloudflare Access**.
3. Zero Trust → **Access → Applications** → open that app → **Policies**: one **Allow** rule, **Include → Emails → your email only**. Login method: One-time PIN.
4. On the application's overview copy the **Application Audience (AUD) tag**.
(Menu names move around; if one differs, the goal is: an Access application covering the workers.dev URL, allow-list = your email.)

**5. Set the four secrets** — one per command, Terminal asks you to paste the value (hidden; nothing is shown or sent to chat):
```
npx wrangler secret put OPENAI_API_KEY        # key from the dedicated Telōs OpenAI project
npx wrangler secret put OWNER_EMAIL           # the email in your Access policy
npx wrangler secret put ACCESS_TEAM_DOMAIN    # e.g. myteam.cloudflareaccess.com  (no https://)
npx wrangler secret put ACCESS_AUD            # the AUD tag from 4.4
```
(Alternative: Worker → Settings → Variables and Secrets → add each as type **Secret**.)

**6. Open the URL on your iPhone** (Safari) → enter your email → type the PIN emailed to you → sandbox loads.
Share → Add to Home Screen if you like.

**7. First real test, cheap:** add a character + 1–2 references, Generate with **Quality: low, 1 image**. Confirm the cost in the OpenAI dashboard and compare it with the app's estimate on the Usage tab.

## Safety defaults (edit `[vars]` in `wrangler.toml`, then `npx wrangler deploy`)
- 20 image calls/day, $3/day, $8/month estimated spend, max 3 per batch, 5 s between submits, identical request blocked for 2 min unless you tick “allow repeat”. Your OpenAI $10 hard limit remains the real backstop.
- `ALLOW_LOW_MODERATION=false` and `OWNER_ADULT_ATTESTED=false`. Only set both to `"true"` if you want the Adult surface and the manual `low` moderation choice to appear. Even then `low` is used only when you pick it for that run, on the Adult surface. `low` loosens OpenAI’s filter; it does not make anything allowed that OpenAI’s policies forbid.
- Never set `DEV_BYPASS_AUTH` on the deployed Worker. It only works for localhost anyway.

## If something fails
- Page says `AUTH_NOT_CONFIGURED` / `BAD_AUDIENCE`: a secret in step 5 is missing or wrong (AUD and team domain are the usual culprits).
- `OPENAI_KEY_MISSING`: step 5, first secret.
- Job fails `IMAGE_PROVIDER_HTTP_403/404`: the project may lack access to the image model (some image models need OpenAI organization verification). Tap the red job pill for details.
- `IMAGE_PROVIDER_HTTP_400`: OpenAI refused the request (moderation or a parameter). Tap the pill. Nothing is retried or reworded automatically.
- Erase everything: Usage tab → Erase all sandbox data.

## Run the tests yourself
`npm test` (unit, instant) · `npm run e2e` (starts the real Worker locally against a mock; no key, no cost)
