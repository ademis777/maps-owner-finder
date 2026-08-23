import * as cheerio from "cheerio";
import type { Business } from "./maps";

export type OwnerCandidate = {
  name: string;
  title?: string;
  confidence: number;
  sources: Array<{ label: string; url: string; snippet?: string }>;
};

const titlePattern = /(owner|founder|co-founder|president|ceo|managing member|principal|proprietor)/i;
const personPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,2})\b/;

async function duckDuckGoSearch(query: string) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
  });
  if (!response.ok) return [];
  const $ = cheerio.load(await response.text());
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  $(".result").slice(0, 8).each((_, element) => {
    const title = $(element).find(".result__a").text().trim();
    const href = $(element).find(".result__a").attr("href") || "";
    const snippet = $(element).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: href, snippet });
  });
  return results;
}

export async function findOwnerCandidates(business: Business): Promise<OwnerCandidate[]> {
  if (!business.name) return [];

  const location = business.address ? ` ${business.address}` : "";
  const queries = [
    `"${business.name}" owner${location}`,
    `"${business.name}" founder${location}`,
    `"${business.name}" president${location}`,
  ];

  const pages = (await Promise.all(queries.map(duckDuckGoSearch))).flat();
  const candidates = new Map<string, OwnerCandidate>();

  for (const result of pages) {
    const combined = `${result.title}. ${result.snippet}`;
    const titleMatch = combined.match(titlePattern);
    if (!titleMatch) continue;

    const people = combined.match(new RegExp(personPattern.source, "g")) || [];
    for (const name of people.slice(0, 3)) {
      if (/Google Maps|Better Business|LinkedIn|Facebook|Yellow Pages/i.test(name)) continue;
      const key = name.toLowerCase();
      const existing = candidates.get(key);
      const source = { label: result.title, url: result.url, snippet: result.snippet };
      if (existing) {
        if (!existing.sources.some((item) => item.url === source.url)) existing.sources.push(source);
        existing.confidence = Math.min(95, existing.confidence + 18);
      } else {
        candidates.set(key, {
          name,
          title: titleMatch[1],
          confidence: 52,
          sources: [source],
        });
      }
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.confidence - a.confidence || b.sources.length - a.sources.length)
    .slice(0, 5);
}
