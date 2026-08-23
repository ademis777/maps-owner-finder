# Maps Owner Finder

Free-first prototype for researching local businesses from a Google Maps company URL.

## Current flow

1. Paste a Google Maps business link.
2. Resolve public business metadata from the Maps page.
3. Extract available name, address, phone, website and category.
4. Search public web results for owner/founder/president signals.
5. Return candidates with sources and confidence instead of inventing an owner.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## V0.1 limitations

Google can omit phone and website data from server-rendered HTML, and free search endpoints can rate-limit or change markup. These cases are reported as missing data. The next development step is to add additional free resolvers/fallbacks and stronger owner verification across company websites, business registries and public directories.

## Planned next steps

- fallback parser for short Maps links and alternate Google page payloads
- company website crawler: About / Team / Contact / schema.org
- state registry adapters
- BBB and public directory adapters where permitted
- source deduplication and stronger confidence scoring
- CSV/batch queue for 300–500 companies
- persistent results database
- optional paid APIs only after free-source validation
