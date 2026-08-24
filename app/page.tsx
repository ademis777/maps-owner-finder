"use client";

import { ChangeEvent, FormEvent, useMemo, useRef, useState } from "react";

type Analysis = {
  business: {
    name?: string; address?: string; city?: string; state?: string; zip?: string; phone?: string; website?: string; category?: string;
    mapsUrl: string; mapsInputUrl?: string; mapsStatus: "resolved" | "partial" | "shell_only" | "blocked" | "timeout" | "error"; mapsHttpStatus?: number; mapsStatusReason?: string; mapsAddressParseError?: string;
    mapsFieldEvidence?: Record<string, { value: string; source: string; confidence: number; evidence?: string }>;
    mapsStrategies?: Array<{ strategy: string; status: string; fieldsFound: string[]; durationMs: number; reason?: string }>;
  };
  ownerCandidates: Array<{
    name: string;
    title?: string;
    relationshipType: "owner_relationship" | "decision_maker" | "registered_agent" | "unknown";
    confidence: number;
    phones: string[];
    emails: string[];
    contacts: Array<{
      value: string;
      sourceUrl: string;
      evidenceText: string;
      contactType: "verified_direct" | "possible_direct" | "business" | "general_email" | "press_media" | "unknown";
      confidence: number;
      reason: string;
      kind: "phone" | "email";
    }>;
    sources: Array<{ label: string; url: string; snippet?: string; phones?: string[]; emails?: string[]; sourceName?: string; evidenceText?: string; companyMatchEvidence?: string; relationshipType?: string }>;
  }>;
  warnings: string[];
  debug?: {
    ownerDiscoveryMode: "registry_confirmed" | "registry_no_match_web_fallback" | "registry_ambiguous_web_fallback" | "unsupported_state_web_fallback";
    webFallback: { fallbackStarted: boolean; budgetMs: number; elapsedMs: number; queriesPlanned: string[]; queriesExecuted: string[]; queriesSkipped: string[]; ddgCalls: number; bingCalls: number; pagesFetched: number; earlyStopReason?: string; budgetExceeded: boolean };
    timing: Array<{ stage: string; status: string; durationMs: number; reason?: string }>;
    sources: Array<{
      sourceName: string; attempted: boolean; input: string; status: string; reason?: string;
      state?: string; registryStatus?: string; lookupQuery?: string; recordsReturned?: number; executionTimeMs?: number;
      companyMatches: Array<{ companyName: string; sourceUrl: string; score: number; evidence: string }>;
      rejectedMatches: Array<{ companyName: string; sourceUrl?: string; score: number; reason: string }>;
      people: Array<{ name: string; role: string; relationshipType: string; sourceUrl: string; evidenceText: string; companyMatchEvidence: string; identityConfidence: number }>;
    }>;
    contactEnrichment: Array<{
      personName: string; companyName: string;
      sources: Array<{
        sourceName: string; attempted: boolean; input: string; status: string; reason?: string;
        searchQuery?: string; carrierMatches?: string[]; personMatch?: boolean; mcUsd?: string; historicalPhone?: string; currentCompanyPhone?: string; classificationReason?: string; durationMs?: number;
        candidatesFound: Array<{ kind: string; value: string; normalizedValue: string; sourceUrl: string; evidenceText: string }>;
        acceptedCandidates: Array<{ kind: string; value: string; normalizedValue: string; sourceUrl: string; evidenceText: string; contactType: string; confidence: number; reason: string }>;
        rejectedCandidates: Array<{ value?: string; sourceUrl: string; reason: string; evidenceText: string }>;
      }>;
    }>;
    queries: Array<{
      query: string;
      duckduckgo: { status: string; httpStatus?: number; parsedCount: number; acceptedCount: number; rejectedCount: number; reason?: string };
      bing: { status: string; httpStatus?: number; parsedCount: number; acceptedCount: number; rejectedCount: number; reason?: string };
      results: Array<{
        engine: "duckduckgo" | "bing";
        title: string;
        url: string;
        originalUrl: string;
        snippet: string;
        accepted: boolean;
        relevanceScore: number;
        relevanceReason: string;
        extracted: Array<{ name: string; title: string }>;
      }>;
    }>;
  };
};

type CsvRow = Record<string, string>;
type BulkResult = { row: CsvRow; status: "queued" | "processing" | "done" | "error"; analysis?: Analysis; error?: string };

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]; const next = text[i + 1];
    if (char === '"' && quoted && next === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && next === "\n") i++; row.push(field); field = ""; if (row.some((value) => value.length > 0)) rows.push(row); row = []; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvEscape(value: unknown) { const text = String(value ?? ""); return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }

async function analyze(url: string, seed?: CsvRow): Promise<Analysis> {
  const response = await fetch("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, seed: seed ? { name: seed.name, address: seed.address, phone: seed.phone, website: seed.website, category: seed.category } : undefined }) });
  const body = await response.json(); if (!response.ok) throw new Error(body.error || "Analysis failed"); return body;
}

export default function Home() {
  const [url, setUrl] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [data, setData] = useState<Analysis | null>(null);
  const [bulk, setBulk] = useState<BulkResult[]>([]); const [bulkRunning, setBulkRunning] = useState(false); const [bulkMessage, setBulkMessage] = useState(""); const [fileName, setFileName] = useState(""); const stopRequested = useRef(false);
  const completed = useMemo(() => bulk.filter((item) => item.status === "done").length, [bulk]); const failed = useMemo(() => bulk.filter((item) => item.status === "error").length, [bulk]);

  async function submit(event: FormEvent) { event.preventDefault(); setError(""); setData(null); setLoading(true); try { setData(await analyze(url)); } catch (err) { setError(err instanceof Error ? err.message : "Analysis failed"); } finally { setLoading(false); } }

  async function loadCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return; stopRequested.current = false; setBulkMessage(""); setError(""); setFileName(file.name);
    const rows = parseCsv(await file.text()); if (!rows.length) { setBulk([]); setError("CSV is empty or could not be parsed."); return; }
    if (!("gmaps_url" in rows[0])) { setBulk([]); setError("CSV must contain a gmaps_url column."); return; }
    setBulk(rows.filter((row) => row.gmaps_url?.trim()).map((row) => ({ row, status: "queued" })));
  }

  function stopBulk() { stopRequested.current = true; setBulkMessage("Stopping after the current company finishes…"); }

  async function runBulk() {
    if (!bulk.length || bulkRunning) return; stopRequested.current = false; setBulkRunning(true); setBulkMessage(""); setError(""); let consecutiveErrors = 0;
    for (let index = 0; index < bulk.length; index++) {
      if (stopRequested.current) { setBulkMessage("Stopped manually. Click Resume to continue queued companies."); break; }
      const current = bulk[index]; if (current.status === "done") continue;
      setBulk((items) => items.map((item, i) => i === index ? { ...item, status: "processing", error: undefined } : item));
      try { const analysis = await analyze(current.row.gmaps_url, current.row); consecutiveErrors = 0; setBulk((items) => items.map((item, i) => i === index ? { ...item, status: "done", analysis } : item)); }
      catch (err) { consecutiveErrors++; setBulk((items) => items.map((item, i) => i === index ? { ...item, status: "error", error: err instanceof Error ? err.message : "Analysis failed" } : item)); if (consecutiveErrors >= 5) { stopRequested.current = true; setBulkMessage("Auto-stopped after 5 consecutive errors. This may indicate rate limiting, blocking, or a network/IP problem. You can resume later."); break; } }
    }
    setBulkRunning(false);
  }

  function exportCsv() {
    if (!bulk.length) return;
    const originalHeaders = Object.keys(bulk[0].row);
    const extraHeaders = ["owner_name", "owner_title", "owner_phone", "owner_email", "owner_confidence", "owner_sources", "owner_status", "owner_error"];
    const lines = [[...originalHeaders, ...extraHeaders].map(csvEscape).join(",")];
    for (const item of bulk) {
      const owner = item.analysis?.ownerCandidates?.[0];
      const values = [...originalHeaders.map((header) => item.row[header] ?? ""), owner?.name ?? "", owner?.title ?? "", owner?.phones?.join(" | ") ?? "", owner?.emails?.join(" | ") ?? "", owner?.confidence ?? "", owner?.sources.map((source) => source.url).join(" | ") ?? "", item.status, item.error ?? ""];
      lines.push(values.map(csvEscape).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }); const href = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = href; link.download = `owner-results-${Date.now()}.csv`; link.click(); URL.revokeObjectURL(href);
  }

  return <main className="shell">
    <section className="hero"><div className="eyebrow">Public-source business research</div><h1>Maps Owner Finder</h1><p className="subtitle">Check one Google Maps company or upload a CSV with a <strong>gmaps_url</strong> column for bulk owner research.</p></section>

    <section className="panel">
      <h2 className="sectionTitle">Single company</h2>
      <form className="form" onSubmit={submit}><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.google.com/maps/place/..." required /><button className="button" disabled={loading}>{loading ? "Searching…" : "Find owner"}</button></form>
      <p className="note">External public sources are opened and parsed for concrete contact data. Company websites are not used in the current workflow.</p>
      {error && <div className="error">{error}</div>}

      {data && <div className="results">
        <article className="card"><h2>Business</h2><div className="grid">{Object.entries({ Name: data.business.name, Address: data.business.address, City: data.business.city, State: data.business.state, ZIP: data.business.zip, Phone: data.business.phone, Website: data.business.website, Category: data.business.category, "Maps status": data.business.mapsStatus }).map(([label, value]) => <div className="field" key={label}><span className="label">{label}</span><span className="value">{value || "Not found"}</span></div>)}</div>{data.business.mapsStatusReason && <p className="note">{data.business.mapsStatusReason}</p>}</article>
        <article className="card"><h2>Maps resolution</h2><div className="source"><div className="note">Input URL</div><div className="value">{data.business.mapsInputUrl || "—"}</div><div className="note" style={{ marginTop: 8 }}>Resolved / canonical URL</div><a href={data.business.mapsUrl} target="_blank" rel="noreferrer">{data.business.mapsUrl}</a><div className="note" style={{ marginTop: 8 }}>HTTP {data.business.mapsHttpStatus ?? "—"} · Maps status <strong>{data.business.mapsStatus}</strong></div></div>
          <h3>Strategies attempted</h3>{data.business.mapsStrategies?.map((strategy, index) => <div className="source" key={`${strategy.strategy}-${index}`}><strong>{strategy.strategy} — {strategy.status} · {strategy.durationMs} ms</strong><div className="note">Fields: {strategy.fieldsFound.length ? strategy.fieldsFound.join(", ") : "none"}{strategy.reason ? ` · ${strategy.reason}` : ""}</div></div>)}
          <h3>Final field evidence</h3><div className="grid">{Object.entries(data.business.mapsFieldEvidence || {}).map(([field, evidence]) => <div className="field" key={field}><span className="label">{field}</span><span className="value">{evidence.value}</span><span className="note">{evidence.source} · confidence {evidence.confidence}{evidence.evidence ? ` · ${evidence.evidence}` : ""}</span></div>)}</div>{data.business.mapsAddressParseError && <div className="error">{data.business.mapsAddressParseError}</div>}
        </article>
        <article className="card"><h2>Owner candidates</h2>{data.ownerCandidates.length === 0 ? <p>No owner was confirmed from the sources checked.</p> : data.ownerCandidates.map((candidate, index) => { const possiblePhones = candidate.contacts?.filter((contact) => contact.kind === "phone" && contact.contactType === "possible_direct") || []; const possibleEmails = candidate.contacts?.filter((contact) => contact.kind === "email" && contact.contactType === "possible_direct") || []; return <div className="source" key={`${candidate.name}-${index}`}>
          <strong>{candidate.name}{candidate.title ? ` — ${candidate.title}` : ""}</strong><span className="badge">{candidate.relationshipType} · Confidence {candidate.confidence}%</span>
          <div className="grid" style={{ marginTop: 12 }}>
            <div className="field"><span className="label">Owner phone</span><span className="value">{candidate.phones?.length ? candidate.phones.join(" | ") : "Not found"}</span></div>
            <div className="field"><span className="label">Owner email</span><span className="value">{candidate.emails?.length ? candidate.emails.join(" | ") : "Not found"}</span></div>
            <div className="field"><span className="label">Possible owner phone</span><span className="value">{possiblePhones.length ? possiblePhones.map((contact) => contact.value).join(" | ") : "Not found"}</span></div>
            <div className="field"><span className="label">Possible owner email</span><span className="value">{possibleEmails.length ? possibleEmails.map((contact) => contact.value).join(" | ") : "Not found"}</span></div>
          </div>
          <div className="sources" style={{ marginTop: 10 }}>{candidate.sources.map((source) => <div key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>{(source.phones?.length || source.emails?.length) ? <div className="note">Parsed: {[...(source.phones || []), ...(source.emails || [])].join(" · ")}</div> : null}</div>)}</div>
        </div>; })}</article>

        {data.debug && <article className="card"><h2>Debug search log</h2><p className="note">Owner discovery mode: <strong>{data.debug.ownerDiscoveryMode}</strong></p><h3>Timing / pipeline decisions</h3>{data.debug.timing.map((stage, index) => <div className="note" key={`${stage.stage}-${index}`}>{stage.stage}: {stage.status} · {stage.durationMs} ms{stage.reason ? ` · ${stage.reason}` : ""}</div>)}<h3>Web fallback budget</h3><div className="source"><div className="note">Started: {data.debug.webFallback.fallbackStarted ? "yes" : "no"} · budget {data.debug.webFallback.budgetMs} ms · elapsed {data.debug.webFallback.elapsedMs} ms · exceeded {data.debug.webFallback.budgetExceeded ? "yes" : "no"}</div><div className="note">Queries: {data.debug.webFallback.queriesExecuted.length}/{data.debug.webFallback.queriesPlanned.length} executed · {data.debug.webFallback.queriesSkipped.length} skipped · DDG {data.debug.webFallback.ddgCalls} calls · Bing {data.debug.webFallback.bingCalls} calls · pages fetched {data.debug.webFallback.pagesFetched}</div>{data.debug.webFallback.earlyStopReason && <div className="note">Stop: {data.debug.webFallback.earlyStopReason}</div>}</div>{data.debug.sources.map((source, sourceIndex) => <details key={`${source.sourceName}-${sourceIndex}`} style={{ marginBottom: 12 }} open>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>{source.state ? `${source.state} · ` : ""}{source.sourceName} — {source.registryStatus || source.status} ({source.people.length} people)</summary>
          <div className="note">{source.attempted ? "attempted" : "skipped"}: {source.lookupQuery || source.input}{source.recordsReturned !== undefined ? ` · ${source.recordsReturned} records · ${source.executionTimeMs} ms` : ""}</div>{source.reason && <div className="note">{source.reason}</div>}
          {source.companyMatches.map((match) => <div className="source" key={match.sourceUrl}><strong>Matched: {match.companyName} · score {match.score}</strong><div className="note">{match.evidence}</div><a href={match.sourceUrl} target="_blank" rel="noreferrer">Evidence record</a></div>)}
          {source.rejectedMatches.slice(0, 5).map((match, index) => <div className="note" key={`${match.companyName}-${index}`}>Rejected: {match.companyName} · score {match.score} · {match.reason}</div>)}
          {source.people.map((person, index) => <div className="source" key={`${person.name}-${index}`}><strong>{person.name} — {person.role} ({person.relationshipType})</strong><div className="note">Confidence {person.identityConfidence}: {person.evidenceText}</div><a href={person.sourceUrl} target="_blank" rel="noreferrer">Source</a></div>)}
        </details>)}<h3>Contact enrichment</h3>{data.debug.contactEnrichment?.map((entry, entryIndex) => <details key={`${entry.personName}-${entryIndex}`} style={{ marginBottom: 12 }} open>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>{entry.personName} — {entry.companyName}</summary>
          {entry.sources.map((source, sourceIndex) => <div className="source" key={`${source.sourceName}-${sourceIndex}`}><strong>{source.sourceName} — {source.status}{source.durationMs !== undefined ? ` · ${source.durationMs} ms` : ""}</strong><div className="note">{source.attempted ? "attempted" : "skipped"}: {source.input}</div>{source.reason && <div className="note">{source.reason}</div>}
            {source.sourceName === "FMCSA CONTACT ENRICHMENT" && <div className="note">Query: {source.searchQuery || "—"}<br />Carrier/entity matches: {source.carrierMatches?.join(" | ") || "none"}<br />Person match: {source.personMatch === undefined ? "—" : source.personMatch ? "yes" : "no"}<br />MC/USDOT: {source.mcUsd || "—"}<br />Historical phone: {source.historicalPhone || "—"}<br />Current company phone: {source.currentCompanyPhone || "—"}<br />Classification: {source.classificationReason || "—"}</div>}
            {source.acceptedCandidates.map((contact, index) => <div className="note" key={`accepted-${index}`}>Accepted: {contact.value} → {contact.contactType} ({contact.confidence}) · {contact.reason}<br /><a href={contact.sourceUrl} target="_blank" rel="noreferrer">Evidence source</a>: {contact.evidenceText}</div>)}
            {source.rejectedCandidates.slice(0, 10).map((contact, index) => <div className="note" key={`rejected-${index}`}>Rejected{contact.value ? ` ${contact.value}` : ""}: {contact.reason}<br /><a href={contact.sourceUrl} target="_blank" rel="noreferrer">Source</a>: {contact.evidenceText}</div>)}
          </div>)}
        </details>)}{data.debug.queries.map((entry, qIndex) => <details key={`${entry.query}-${qIndex}`} style={{ marginBottom: 12 }} open={qIndex === 0}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>{entry.query} — DDG {entry.duckduckgo.status} {entry.duckduckgo.acceptedCount}/{entry.duckduckgo.parsedCount}, Bing {entry.bing.status} {entry.bing.acceptedCount}/{entry.bing.parsedCount}</summary>
          <div className="note">DDG HTTP {entry.duckduckgo.httpStatus ?? "—"}: {entry.duckduckgo.reason || `${entry.duckduckgo.rejectedCount} rejected`}</div><div className="note">Bing HTTP {entry.bing.httpStatus ?? "—"}: {entry.bing.reason || `${entry.bing.rejectedCount} rejected`}</div>
          <div style={{ marginTop: 10 }}>{entry.results.length === 0 ? <div className="note">No search results returned.</div> : entry.results.map((result, rIndex) => <div className="source" key={`${result.url}-${rIndex}`}>
            <strong>[{result.engine}] {result.accepted ? "accepted" : "rejected"} score {result.relevanceScore} — {result.title}</strong>
            <div className="note" style={{ marginTop: 6 }}>{result.snippet || "No snippet"}</div>
            <div className="note" style={{ marginTop: 6 }}>{result.relevanceReason}</div>
            {result.originalUrl !== result.url && <div className="note" style={{ marginTop: 6 }}>Original: {result.originalUrl}<br />Decoded: {result.url}</div>}
            <div className="note" style={{ marginTop: 6 }}>Extracted: {result.extracted.length ? result.extracted.map((person) => `${person.name} (${person.title})`).join(" | ") : "none"}</div>
          </div>)}</div>
        </details>)}</article>}
      </div>}
    </section>

    <section className="panel bulkPanel">
      <div className="bulkHeader"><div><h2 className="sectionTitle">Bulk CSV check</h2><p className="note bulkNote">Current CSV format with gmaps_url is supported.</p></div><label className="fileButton">Choose CSV<input type="file" accept=".csv,text/csv" onChange={loadCsv} hidden /></label></div>
      {fileName && <p className="fileName">{fileName} — {bulk.length} Google Maps links loaded</p>}{bulkMessage && <div className="error">{bulkMessage}</div>}
      {bulk.length > 0 && <><div className="bulkActions"><button className="button" onClick={runBulk} disabled={bulkRunning}>{bulkRunning ? `Processing ${completed + failed}/${bulk.length}…` : (completed || failed ? `Resume (${completed + failed}/${bulk.length})` : `Run ${bulk.length} companies`)}</button>{bulkRunning && <button className="secondaryButton" onClick={stopBulk}>Stop</button>}<button className="secondaryButton" onClick={exportCsv} disabled={!completed && !failed}>Export results CSV</button></div>
      <div className="tableWrap"><table><thead><tr><th>#</th><th>Company</th><th>Company phone</th><th>Status</th><th>Owner</th><th>Owner phone</th><th>Email</th><th>Confidence</th></tr></thead><tbody>{bulk.map((item, index) => { const owner = item.analysis?.ownerCandidates?.[0]; return <tr key={`${item.row.gmaps_url}-${index}`}><td>{index + 1}</td><td>{item.row.name || item.analysis?.business.name || "—"}</td><td>{item.row.phone || item.analysis?.business.phone || "—"}</td><td><span className={`status status-${item.status}`}>{item.status}</span></td><td>{owner?.name || (item.status === "error" ? item.error : "—")}</td><td>{owner?.phones?.join(" | ") || "—"}</td><td>{owner?.emails?.join(" | ") || "—"}</td><td>{owner ? `${owner.confidence}%` : "—"}</td></tr>; })}</tbody></table></div></>}
    </section>
  </main>;
}
