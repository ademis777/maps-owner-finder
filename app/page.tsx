"use client";

import { FormEvent, useState } from "react";

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

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Analysis | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setData(null);
    setLoading(true);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Analysis failed");
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="eyebrow">Public-source business research</div>
        <h1>Maps Owner Finder</h1>
        <p className="subtitle">Paste one Google Maps company link. The app resolves the public business details and then searches open web sources for likely owners, founders or executives.</p>
      </section>

      <section className="panel">
        <form className="form" onSubmit={submit}>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.google.com/maps/place/..." required />
          <button className="button" disabled={loading}>{loading ? "Searching…" : "Find owner"}</button>
        </form>
        <p className="note">V0.1 uses public pages only. No Google Maps API key or paid people-data API is required.</p>
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

            {data.warnings.length > 0 && <article className="card"><h2>Notes</h2>{data.warnings.map((warning) => <p key={warning}>{warning}</p>)}</article>}
          </div>
        )}
      </section>
    </main>
  );
}
