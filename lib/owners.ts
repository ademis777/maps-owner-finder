import * as cheerio from "cheerio";
import type { Business } from "./maps";

export type OwnerCandidate = {
  name: string;
  title?: string;
  confidence: number;
  phones: string[];
  emails: string[];
  sources: Array<{ label: string; url: string; snippet?: string; phones?: string[]; emails?: string[] }>;
};

type SearchResult = { title: string; url: string; snippet: string; engine: "duckduckgo" | "bing" };

const rolePattern = /(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)/i;
const personName = `[A-Z][a-zA-Z'.-]+(?:\\s+[A-Z][a-zA-Z'.-]+){1,2}`;
const blockedWords = new Set(["because", "for", "and", "the", "with", "from", "at", "of", "in", "to", "by", "is", "as", "a", "an", "no-brainer"]);
const blockedPhrases = ["google maps", "better business", "linkedin", "facebook", "yellow pages", "registered agent", "discover company principals", "customer service", "company profile", "business profile", "contact information"];

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function looksLikePerson(name: string, businessName: string) {
  const normalized = normalize(name);
  const businessNormalized = normalize(businessName);
  if (!normalized || normalized === businessNormalized) return false;
  if (businessNormalized.includes(normalized) || normalized.includes(businessNormalized)) return false;
  if (blockedPhrases.some((phrase) => normalized.includes(phrase))) return false;
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  if (words.some((word) => blockedWords.has(word.toLowerCase()))) return false;
  if (words.some((word) => !/^[A-Z][a-zA-Z'.-]+$/.test(word))) return false;
  return true;
}

function extractPeopleNearRoles(text: string, businessName: string) {
  const matches: Array<{ name: string; title: string }> = [];
  const patterns = [
    new RegExp(`(${personName})\\s*[-–—,:|]\\s*(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)`, "g"),
    new RegExp(`(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)\\s*[-–—,:|]?\\s*(${personName})`, "gi"),
    new RegExp(`(${personName})\\s+(?:is|as|serves as|works as)?\\s*(?:the\\s+)?(owner|founder|co-founder|president|ceo|managing member|member|principal|proprietor)`, "g"),
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const first = match[1] || "";
      const second = match[2] || "";
      const firstIsRole = rolePattern.test(first);
      const name = firstIsRole ? second : first;
      const title = firstIsRole ? first : second;
      if (looksLikePerson(name, businessName)) matches.push({ name: name.trim(), title: title.trim() });
    }
  }
  return matches;
}

function uniq(values: string[]) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function extractPhones(text: string) {
  const matches = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}/g) || [];
  return uniq(matches).slice(0, 6);
}

function extractEmails(text: string) {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return uniq(matches).filter((email) => !/example\.(com|org|net)$/i.test(email)).slice(0, 6);
}

function extractNearby(text: string, needle: string, radius = 220) {
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const chunks: string[] = [];
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(target, from);
    if (index === -1) break;
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + target.length + radius);
    chunks.push(text.slice(start, end));
    from = index + target.length;
    if (chunks.length >= 8) break;
  }
  return chunks.join(" ");
}

function extractVerifiedContacts(text: string, ownerName: string) {
  const nearby = extractNearby(text, ownerName, 220);
  if (!nearby) return { phones: [] as string[], emails: [] as string[] };
  return { phones: extractPhones(nearby), emails: extractEmails(nearby) };
}

function decodeDuckDuckGoUrl(href: string) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return href;
  }
}

function parseDdgHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $(".result").slice(0, 10).each((_, element) => {
    const title = $(element).find(".result__a").text().trim();
    const href = $(element).find(".result__a").attr("href") || "";
    const snippet = $(element).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: decodeDuckDuckGoUrl(href), snippet, engine: "duckduckgo" });
  });
  return results;
}

function parseDdgLite(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $("a.result-link").slice(0, 10).each((_, element) => {
    const title = $(element).text().trim();
    const href = $(element).attr("href") || "";
    const row = $(element).closest("tr");
    const snippet = row.next().text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: decodeDuckDuckGoUrl(href), snippet, engine: "duckduckgo" });
  });
  return results;
}

function parseBingHtml(html: string): SearchResult[] {
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $("li.b_algo").slice(0, 10).each((_, element) => {
    const link = $(element).find("h2 a").first();
    const title = link.text().trim();
    const href = link.attr("href") || "";
    const snippet = $(element).find(".b_caption p, p").first().text().replace(/\s+/g, " ").trim();
    if (title && href) results.push({ title, url: href, snippet, engine: "bing" });
  });
  return results;
}

const searchHeaders = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

async function duckDuckGoSearch(query: string) {
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: searchHeaders,
    });
    if (response.ok) {
      const results = parseDdgHtml(await response.text());
      if (results.length) return results;
    }
  } catch {}

  try {
    const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: searchHeaders,
    });
    if (response.ok) return parseDdgLite(await response.text());
  } catch {}

  return [];
}

async function bingSearch(query: string) {
  try {
    const response = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-US`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: searchHeaders,
    });
    if (response.ok) return parseBingHtml(await response.text());
  } catch {}
  return [];
}

async function searchOwnerWeb(query: string) {
  const ddg = await duckDuckGoSearch(query);
  if (ddg.length >= 3) return ddg;
  const bing = await bingSearch(query);
  const seen = new Set<string>();
  return [...ddg, ...bing].filter((item) => {
    const key = item.url || `${item.title}|${item.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchPublicSource(url: string, ownerName: string) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
      headers: searchHeaders,
    });
    if (!response.ok) return { phones: [] as string[], emails: [] as string[] };
    const html = await response.text();
    const $ = cheerio.load(html);
    $("script,style,noscript,svg").remove();
    const visible = $("body").text().replace(/\s+/g, " ");
    return extractVerifiedContacts(visible, ownerName);
  } catch {
    return { phones: [] as string[], emails: [] as string[] };
  }
}

export async function findOwnerCandidates(business: Business): Promise<OwnerCandidate[]> {
  if (!business.name) return [];
  const location = business.address ? ` ${business.address}` : "";
  const queries = [
    `"${business.name}" owner${location}`,
    `"${business.name}" president${location}`,
    `"${business.name}" founder${location}`,
    `"${business.name}" "managing member"${location}`,
  ];

  const pages: SearchResult[] = [];
  for (const query of queries) {
    const results = await searchOwnerWeb(query);
    pages.push(...results);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  const candidates = new Map<string, OwnerCandidate>();

  // Owner discovery is intentionally independent from phone/email enrichment.
  for (const result of pages) {
    const combined = `${result.title}. ${result.snippet}`;
    const people = extractPeopleNearRoles(combined, business.name);
    for (const person of people) {
      const key = normalize(person.name);
      const source = { label: result.title, url: result.url, snippet: result.snippet, phones: [] as string[], emails: [] as string[] };
      const existing = candidates.get(key);

      if (existing) {
        if (!existing.sources.some((item) => item.url === source.url)) existing.sources.push(source);
        existing.confidence = Math.min(98, existing.confidence + 18);
      } else {
        let confidence = 64;
        if (/bbb|bizapedia|opencorporates|crunchbase|linkedin/i.test(`${result.title} ${result.url}`)) confidence += 8;
        if (normalize(combined).includes(normalize(business.name))) confidence += 8;
        if (result.engine === "bing") confidence += 2;
        candidates.set(key, {
          name: person.name,
          title: person.title,
          confidence: Math.min(confidence, 90),
          phones: [],
          emails: [],
          sources: [source],
        });
      }
    }
  }

  const ranked = [...candidates.values()]
    .filter((candidate) => candidate.confidence >= 60)
    .sort((a, b) => b.confidence - a.confidence || b.sources.length - a.sources.length)
    .slice(0, 5);

  // Only after the owner is known do we attempt verified contact enrichment.
  for (const candidate of ranked) {
    for (const source of candidate.sources.slice(0, 3)) {
      const snippetContact = extractVerifiedContacts(`${source.label}. ${source.snippet || ""}`, candidate.name);
      const pageContact = await fetchPublicSource(source.url, candidate.name);
      source.phones = uniq([...snippetContact.phones, ...pageContact.phones]);
      source.emails = uniq([...snippetContact.emails, ...pageContact.emails]);
      candidate.phones = uniq([...candidate.phones, ...source.phones]);
      candidate.emails = uniq([...candidate.emails, ...source.emails]);
    }
    if (candidate.phones.length || candidate.emails.length) candidate.confidence = Math.min(98, candidate.confidence + 3);
  }

  return ranked;
}
