# Settings UI Guide: Configure All Keys & Persist

## Overview

The web UI **Settings** page lets you configure all API keys and options. Changes are saved to `~/.agentswarm/config.json` and persist across sessions. No need to restart.

Access it at: **http://127.0.0.1:7777** → Settings

---

## 1. Model Provider

**Section**: "Model provider"

Configure your LLM provider (Anthropic, OpenAI, etc.) and API keys.

### Fields:
- **Provider**: Dropdown to select which LLM service to use
- **Model**: Your chosen model within that provider
- **API Key**: (if required) Paste your provider's API key
  - Hint shows: `••••• (leave blank to keep)` if already saved
  - Blank input = keep current, change only if you paste a new value

### Secondary Models (per role):
- **Conductor Model**: Orchestrates multi-agent tasks
- **Cheap Model**: Fast/cheap work (exploration, drafts)
- **Strong Model**: Complex reasoning (final synthesis)

Once you pick a provider, the **API key** field will appear if required. All keys are stored locally in:
```
~/.agentswarm/config.json (chmod 600)
```

---

## 2. Web Search

**Section**: "Web search"

Configure optional search engine upgrades.

### Fields:
- **Search backend**: 
  - `DuckDuckGo + Bing` (default, built-in, free)
  - `TinyFish only` (premium, faster, requires key)
  - `Auto` (uses TinyFish if key set, falls back to free)

- **TinyFish API key**: (optional)
  - Get at: https://tinyfish.ai
  - Adds a third hosted search engine to the mix
  - Even without it, DuckDuckGo + Bing work great

### Test:
Click "Test search engines" to verify all engines respond. Shows:
- ✓ DuckDuckGo: 15 results
- ✓ Bing: 12 results  
- ✓ TinyFish: N/A (if no key) or result count

---

## 3. Crawl Integrations

**Section**: "Crawl integrations"

Configure web scraping/crawling backends. Gives agents:
- `crawl_site` tool: ingest entire documentation sites
- `fetch_url` upgrade: clean markdown + JS rendering

### Backend Priority (Auto mode):
1. **context.dev** (fast, cost-effective) ← tries first
2. **Firecrawl** (full-featured)
3. **deepcrawl** (custom, self-hosted)

### Fields:

#### Crawl backend (dropdown)
- `Auto` (default) — uses first configured service
  - If both context.dev AND Firecrawl are set, context.dev wins
- `Firecrawl` — force Firecrawl only
- `context.dev` — force context.dev only
- `deepcrawl` — force your custom crawler
- `Off` — disable crawl_site tool

#### API Keys (all optional, set the ones you want):
- **Firecrawl API key**
  - Get at: https://firecrawl.dev
  - Enterprise web scraping with JavaScript rendering
  
- **context.dev API key**
  - Get at: https://context.dev
  - Cost-effective, fast, real browser rendering
  
- **deepcrawl API key**
  - Your own custom crawler endpoint
  - Requires: deepcrawl base URL

#### deepcrawl base URL
- Only needed if using deepcrawl
- Must implement POST /crawl endpoint
- Format: `https://your-crawler.example.com`

### Save & Clear:
- **Save**: Type any new keys, click "Save Settings"
  - Blank fields = keep current values
  - Paste a new key = update that service
  
- **Remove**: Listed below API key fields
  - Click "clear firecrawl" / "clear context.dev" / etc. to delete a saved key
  - One-click removal, no need to save again

### Test:
Click "Test crawl backend" to verify the active backend works.
- Scrapes example.com and reports character count
- Shows: `✓ context.dev — scraped 12345 chars`
- If error: `✕ contextdev: empty scrape result`

---

## 4. Sandbox (Execution Runtime)

**Section**: "Sandbox"

Where agents run shell commands. Options:

- **None** (default) — per-run temp workspace, fast, no setup
- **E2B** — cloud container, strongest isolation, requires API key
- **Modal** — serverless compute, requires 2 secrets
- **Vercel** — serverless functions, requires token + team/project IDs
- **Docker** — local container, requires Docker daemon
- **Auto** — uses strongest one you've configured

### API Keys for each sandbox:
- **E2B API Key**: https://e2b.dev
- **Modal Token ID & Secret**: https://modal.com
- **Vercel Token**: https://vercel.com/account/tokens
- **Vercel Team & Project IDs**: from your Vercel account

### Test:
Click "Test sandbox" to verify execution works. Shows which runtime is active.

---

## 5. Numeric Limits

**Section**: (top of settings)

### Fields:
- **Agents in parallel**: 1-32 (default 10)
  - How many researchers/workers run at once
  
- **Task limit**: 1-1000 (default 100)
  - Max tasks per mission before auto-stop
  
- **Steps per task**: 3-200 (default 50)
  - Tool calls allowed per task before timeout
  
- **Token budget**: 50K - 2B (default 100K)
  - Spend cap per mission, stops early if hit

---

## 6. Model Config (Advanced)

**Section**: (at top)

- **Verification**: On/Off
  - Agents run an adversarial verifier after completing tasks
  
- **Extended thinking**: On/Off
  - If your model supports it (Claude 3.7+), enables longer reasoning
  
- **Reasoning effort**: `low` / `medium` / `high`
  - For models that support structured reasoning (Claude 3.7+)
  
- **Safe mode**: On/Off
  - Strict content policies, blocks some results

---

## 7. Search Backend (Advanced)

**Section**: (top)

The web search method agents use. Usually auto-detected, but you can pin it:
- `duckduckgo` — always use DDG
- `bing` — always use Bing
- `tinyfish` — always use TinyFish (if key set)
- `auto` — best available

---

## File Storage

All settings are saved to a local JSON file:
```
~/.agentswarm/config.json
```

Permissions are `600` (user-only readable/writable). Secrets are **never** sent to external services except:
- Anthropic API (Claude calls)
- Your chosen model provider (LLM requests)
- Configured search/crawl backends (when agents use them)

---

## Workflow: Add a New Service

### Example: Set up context.dev

1. **Get a key**: Go to https://context.dev, sign up, copy your API key
2. **Paste in Settings**:
   - Open http://127.0.0.1:7777 → Settings
   - Scroll to "Crawl integrations"
   - Paste key in "context.dev API key" field
3. **Save**: Click "Save Settings" at the bottom
4. **Test**: Click "Test crawl backend"
   - Should show: `✓ context.dev — scraped 12345 chars`
5. **Done**: Next fetch_url or crawl_site call uses context.dev

### Example: Switch to TinyFish search

1. **Get a key**: https://tinyfish.ai
2. **Paste**: Settings → "Web search" → "TinyFish API key"
3. **Choose backend**:
   - Keep "Auto" if you want DDG+Bing as fallback
   - Or select "TinyFish only"
4. **Save & test**

---

## Removing/Clearing Keys

**To remove a saved key without editing JSON**:

1. Settings → section (e.g., "Crawl integrations")
2. Look for "Remove a saved key:" line
3. Click the X next to the service name
4. Done — key is deleted from config.json, takes effect immediately

This is safer than manually editing the config file.

---

## Env Vars Alternative

If you prefer environment variables instead of the UI:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export CONTEXT_DEV_API_KEY="cdev_..."
export FIRECRAWL_API_KEY="fc-..."
export TINYFISH_API_KEY="tf_..."
npm start
```

Env vars are read at startup **and** can be updated via the Settings UI (UI takes priority after first save).

---

## Persistence & Sessions

- **Settings auto-save** to `~/.agentswarm/config.json`
- **No restart needed** — changes take effect immediately
- **Next time you start** the server, your keys and options are loaded
- **Keys are masked** in the UI (shown as `•••••• ...`)
- **Leave blank** when editing to keep current value

---

## Troubleshooting

### "Could not save settings"
- Check file permissions: `ls -la ~/.agentswarm/config.json`
- Should be `600` or `644` (user readable/writable)
- If missing/broken, delete and restart (will regenerate)

### "Key saved but not being used"
- In Settings, verify the service is the active backend
  - `Crawl backend: auto` should show "resolves to: contextdev"
  - Or explicitly select the service in the dropdown
- Click "Test" to verify

### Can't see "Test" button
- Only appears if at least one key is saved
- Paste a key, click Save, then the Test button appears

### Keys don't persist after restart
- Check: `cat ~/.agentswarm/config.json | grep -i "context\|tinyfish"`
- Should show your saved keys
- If not, the save failed — check permissions or logs

---

## Security Notes

1. **Local-only storage**: Keys never leave your machine (unless sent to their respective APIs)
2. **File permissions**: `~/.agentswarm/config.json` is `600` (user-only)
3. **Masked in UI**: Keys shown as `••••• (current: xxxxx...)` to prevent shoulder-surfing
4. **Clear button**: Click to delete any key permanently from config
5. **No logging**: Keys are not logged to console or disk (except in config.json)

Always treat your config.json as a secret — treat it like your `~/.ssh/id_rsa`.
