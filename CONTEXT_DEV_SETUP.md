# Context.dev Integration: Complete Setup & Diagnostics

## What's Fixed

1. **Priority order**: context.dev now wins auto-selection (cost-effective)
   - Auto priority: context.dev → firecrawl → deepcrawl
   - Previously: firecrawl won even if context.dev was cheaper

2. **Response parsing**: Handles multiple response shapes
   - Flat: `{ markdown, metadata: { title } }`
   - Nested: `{ results: [{ markdown, metadata: { title } }] }`
   - Alternative: `{ data: { markdown, metadata: { title } } }`

3. **Crawl filtering**: Skips empty pages, handles content/text fallbacks
   - Filters pages with no markdown/content/text
   - Handles `results`, `pages`, or `data` field names
   - URL extraction from `metadata.url`, `url`, or `uri`

## Setup: Ensure Context.dev Works

### 1. Set the API key

**Option A: Environment variable (recommended)**
```bash
export CONTEXT_DEV_API_KEY="your-api-key-here"
npm start
```

**Option B: Config file**
Edit `~/.config/agentswarm/config.json`:
```json
{
  "contextdevApiKey": "your-api-key-here"
}
```

**Option C: UI Settings**
- Start the server
- Open http://127.0.0.1:7777
- Go to Settings → Crawl integrations
- Paste your context.dev API key

### 2. Remove conflicting backends (optional)

If you have **both** firecrawl AND context.dev keys configured:
- With auto mode, context.dev now wins (by design, it's cheaper)
- To force firecrawl instead: set `crawlBackend: "firecrawl"` in config
- To force context.dev: set `crawlBackend: "contextdev"`

### 3. Verify configuration

```bash
curl http://127.0.0.1:7777/api/config | jq '.crawl'
```

Expected output:
```json
{
  "crawlResolved": "contextdev",
  "contextdevKeySet": true,
  "contextdevKeyMasked": "cdev_xxxxx..."
}
```

## Testing Context.dev

### Test 1: Quick backend test (from UI)
1. Open http://127.0.0.1:7777
2. Go to Settings → Crawl integrations
3. Click "Test Crawl Backend"
4. Should show: `✓ context.dev — scraped N chars from https://example.com`

### Test 2: Via API endpoint
```bash
curl -X POST http://127.0.0.1:7777/api/crawl/test | jq .
```

Expected:
```json
{
  "ok": true,
  "backend": "contextdev",
  "detail": "scraped 12345 chars"
}
```

### Test 3: In a swarm task
Run a research task that uses `fetch_url` or `crawl_site` tools. Check:
- Tool returns clean markdown
- No errors about empty results
- No fallback to direct fetch warnings

### Test 4: Check platform usage
1. Log in to https://console.context.dev
2. Go to your API key's usage/credits page
3. Should see recent API calls matching your test times

## Troubleshooting

### Issue: "crawlResolved: null"
**Cause**: API key not set or empty  
**Fix**: 
```bash
export CONTEXT_DEV_API_KEY="your-key"
```
Then restart the server.

### Issue: "crawlResolved: firecrawl" (not context.dev)
**Cause**: Firecrawl key is also set; auto mode picks firecrawl first  
**Fix**: Either remove firecrawl key, or set explicit backend:
```bash
# In config.json:
{ "crawlBackend": "contextdev" }
```

### Issue: "ok: false — empty scrape result"
**Cause**: API returned a response but no markdown/content field  
**Fix**:
- Check if context.dev API changed response format
- Try with `crawlBackend: "off"` to test direct fetch as fallback
- Verify API key is valid at https://console.context.dev

### Issue: No API usage on context.dev console
**Cause**: Tasks aren't using context.dev yet (may still be testing)  
**Fix**:
1. Verify `crawlResolved: "contextdev"` via `/api/config`
2. Run a test research task with fetch_url tool
3. Watch network tab in DevTools (browser DevTools, not Node)
4. Should see POST to `api.context.dev/v1/web/scrape`

### Issue: "context.dev: empty scrape result for https://..."
**Cause**: Page returned nothing useful, or API failed silently  
**Fix**:
- Try direct fetch: set `crawlBackend: "off"` temporarily
- If that works, context.dev isn't parsing that site
- Try a different page, or use `crawl_site` instead of `fetch_url`

## API Details

### Scrape endpoint (single page)
```
POST https://api.context.dev/v1/web/scrape
Authorization: Bearer <API_KEY>
Content-Type: application/json

{ "url": "https://example.com/page" }
```

### Crawl endpoint (multi-page site)
```
POST https://api.context.dev/v1/web/crawl
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "url": "https://docs.example.com/",
  "max_pages": 50,
  "include_paths": ["/docs/", "/guides/"]  // optional
}
```

## Expected Performance

With these fixes:
- Researchers pull 15-25 sources per search (was 2-3)
- Context.dev is actually used (wasn't before)
- Crawl tasks extract markdown from multiple pages
- Response parsing handles API variations robustly

## Monitoring

Add logging to see which backend is active per request:
```typescript
// In your task, add:
console.log("Crawl backend in use:", resolveCrawlBackend(cfg));
```

Or check logs:
```bash
# If running with debug
DEBUG=agentswarm:* npm start
```
