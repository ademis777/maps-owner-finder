"use client";

import { ChangeEvent, FormEvent, useMemo, useRef, useState } from "react";

type Analysis = {
  business: {
    name?: string;
    address?: string;
    phone?: string;
    website?: string;
    category?: string;
    mapsUrl: string;
  };
  ownerCandidates: Array<{
    name: string;
    title?: string;
    confidence: number;
    sources: Array<{ label: string; url: string; snippet?: string }>;
  }>;
  warnings: string[];
};

type CsvRow = Record<string, string>;
type BulkResult = {
  row: CsvRow;
  status: "queued" | "processing" | "done" | "error";
  analysis?: Analysis;
  error?: string;
};

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length < 2) return [];
  const headers = rows[0].map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function analyze(url: string, seed?: CsvRow): Promise<Analysis> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      seed: seed ? {
        name: seed.name,
        address: seed.address,
        phone: seed.phone,
        website: seed.website,
        category: seed.category,
      } : undefined,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Analysis failed");
  return body;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Analysis | null>(null);
  const [bulk, setBulk] = useState<BulkResult[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkMessage, setBulkMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const stopRequested = useRef(false);

  const completed = useMemo(() => bulk.filter((item) => item.status === "done").length, [bulk]);
  const failed = useMemo(() => bulk.filter((item) => item.status === "error").length, [bulk]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setData(null);
    setLoading(true);
    try {
      setData(await analyze(url));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    stopRequested.current = false;
    setBulkMessage("");
    setError("");
    setFileName(file.name);
    const rows = parseCsv(await file.text());
    if (!rows.length) {
      setBulk([]);
      setError("CSV is empty or could not be parsed.");
      return;
    }
    if (!("gmaps_url" in rows[0])) {
      setBulk([]);
      setError("CSV must contain a gmaps_url column.");
      return;
    }
    setBulk(rows.filter((row) => row.gmaps_url?.trim()).map((row) => ({ row, status: "queued" })));
  }

  function stopBulk() {
    stopRequested.current = true;
    setBulkMessage("Stopping after the current company finishes…");
  }

  async function runBulk() {
    if (!bulk.length || bulkRunning) return;
    stopRequested.current = false;
    setBulkRunning(true);
    setBulkMessage("");
    setError("");
    let consecutiveErrors = 0;

    for (let index = 0; index < bulk.length; index++) {
      if (stopRequested.current) {
        setBulkMessage("Stopped manually. Click Resume to continue queued companies.");
        break;
      }

      const current = bulk[index];
      if (current.status === "done") continue;

      setBulk((items) => items.map((item, i) => i === index ? { ...item, status: "processing", error: undefined } : item));
      try {
        const analysis = await analyze(current.row.gmaps_url, current.row);
        consecutiveErrors = 0;
        setBulk((items) => items.map((item, i) => i === index ? { ...item, status: "done", analysis } : item));
      } catch (err) {
        consecutiveErrors++;
        setBulk((items) => items.map((item, i) => i === index ? { ...item, status: "error", error: err instanceof Error ? err.message : "Analysis failed" } : item));

        if (consecutiveErrors >= 5) {
          stopRequested.current = true;
          setBulkMessage("Auto-stopped after 5 consecutive errors. This may indicate rate limiting, blocking, or a network/IP problem. You can resume later.");
          break;
        }
      }
    }
    setBulkRunning(false);
  }

  function exportCsv() {
    if (!bulk.length) return;
    const originalHeaders = Object.keys(bulk[0].row);
    const extraHeaders = ["owner_name", "owner_title", "owner_confidence", "owner_sources", "owner_status", "owner_error"];
    const lines = [[...originalHeaders, ...extraHeaders].map(csvEscape).join(",")];

    for (const item of bulk) {
      const owner = item.analysis?.ownerCandidates?.[0];
      const values = [
        ...originalHeaders.map((header) => item.row[header] ?? ""),
        owner?.name ?? "",
        owner?.title ?? "",
        owner?.confidence ?? "",
        owner?.sources.map((source) => source.url).join(" | ") ?? "",
        item.status,
        item.error ?? "",
      ];
      lines.push(values.map(csvEscape).join(","));
    }

    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `owner-results-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(href);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="eyebrow">Public-source business research</div>
        <h1>Maps Owner Finder</h1>
        <p className="subtitle">Check one Google Maps company or upload a CSV with a <strong>gmaps_url</strong> column for bulk owner research.</p>
      </section>

      <section className="panel">
        <h2 className="sectionTitle">Single company</h2>
        <form className="form" onSubmit={submit}>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.google.com/maps/place/..." required />
          <button className="button" disabled={loading}>{loading ? "Searching…" : "Find owner"}</button>
        </form>
        <p className="note">No paid Maps or people-data API is required in this version.</p>
        {error && <div className="error">{error}</div>}

        {data && (
          <div className="results">
            <article className="card">
              <h2>Business</h2>
              <div className="grid">
                {Object.entries({ Name: data.business.name, Address: data.business.address, Phone: data.business.phone, Website: data.business.website, Category: data.business.category }).map(([label, value]) => (
                  <div className="field" key={label}><span className="label">{label}</span><span className="value">{value || "Not found"}</span></div>
                ))}
              </div>
            </article>

            <article className="card">
              <h2>Owner candidates</h2>
              {data.ownerCandidates.length === 0 ? <p>No owner was confirmed from the sources checked.</p> : data.ownerCandidates.map((candidate, index) => (
                <div className="source" key={`${candidate.name}-${index}`}>
                  <strong>{candidate.name}{candidate.title ? ` — ${candidate.title}` : ""}</strong>
                  <span className="badge">Confidence {candidate.confidence}%</span>
                  <div className="sources" style={{ marginTop: 10 }}>
                    {candidate.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label}</a>)}
                  </div>
                </div>
              ))}
            </article>
          </div>
        )}
      </section>

      <section className="panel bulkPanel">
        <div className="bulkHeader">
          <div>
            <h2 className="sectionTitle">Bulk CSV check</h2>
            <p className="note bulkNote">Your current format is supported: name, category, phone, website, address, rating, reviews, niche, location, gmaps_url.</p>
          </div>
          <label className="fileButton">
            Choose CSV
            <input type="file" accept=".csv,text/csv" onChange={loadCsv} hidden />
          </label>
        </div>

        {fileName && <p className="fileName">{fileName} — {bulk.length} Google Maps links loaded</p>}
        {bulkMessage && <div className="error">{bulkMessage}</div>}

        {bulk.length > 0 && (
          <>
            <div className="bulkActions">
              <button className="button" onClick={runBulk} disabled={bulkRunning}>{bulkRunning ? `Processing ${completed + failed}/${bulk.length}…` : (completed || failed ? `Resume (${completed + failed}/${bulk.length})` : `Run ${bulk.length} companies`)}</button>
              {bulkRunning && <button className="secondaryButton" onClick={stopBulk}>Stop</button>}
              <button className="secondaryButton" onClick={exportCsv} disabled={!completed && !failed}>Export results CSV</button>
            </div>

            <div className="tableWrap">
              <table>
                <thead><tr><th>#</th><th>Company</th><th>Phone</th><th>Status</th><th>Owner</th><th>Confidence</th></tr></thead>
                <tbody>
                  {bulk.map((item, index) => {
                    const owner = item.analysis?.ownerCandidates?.[0];
                    return (
                      <tr key={`${item.row.gmaps_url}-${index}`}>
                        <td>{index + 1}</td>
                        <td>{item.row.name || item.analysis?.business.name || "—"}</td>
                        <td>{item.row.phone || item.analysis?.business.phone || "—"}</td>
                        <td><span className={`status status-${item.status}`}>{item.status}</span></td>
                        <td>{owner?.name || (item.status === "error" ? item.error : "—")}</td>
                        <td>{owner ? `${owner.confidence}%` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
