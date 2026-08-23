import * as cheerio from "cheerio";
import type { Business } from "./maps";

export type OwnerCandidate = {
  name: string;
  title?: string;
  confidence: number;
  sources: Array<{ label: string; url: string; snippet?: string }>;
};

const roleSource = "[Oo]wner|[Ff]ounder|[Cc]o-[Ff]ounder|[Pp]resident|CEO|[Cc]eo|[Mm]anaging [Mm]ember|[Mm]ember|[Pp]rincipal|[Pp]roprietor";
const rolePattern = new RegExp(`^(?:${roleSource})$`);
const personName = `[A-Z][a-zA-Z'.-]+(?:\\s+[A-Z][a-zA-Z'.-]+){1,2}`;

const blockedWords = new Set([
  "because", "for", "from", "with", "about", "the", "and", "or", "of", "in", "at", "to", "as", "is",
  "company", "business", "service", "services", "locksmith", "roofing", "plumbing", "principal", "agent",
  "discover", "registered", "customer", "profile", "contact", "information", "providing", "excellent",
]);

const blockedPhrases = [
  "google maps",
  "better business",
  "linkedin",
  "facebook",
  "yellow pages",
  "registered agent",
  "discover company principals",
  "customer service",
  "company profile",
  "business profile",
  "contact information",
];

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function looksLikePerson(name: string, businessName: string) {
  const trimmed = name.trim().replace(/[.,;:]+$/g, "");
  const normalized = normalize(trimmed);
  const businessNormalized = normalize(businessName);

  if (!normalized || normalized === businessNormalized) return false;
  if (businessNormalized.includes(normalized) || normalized.includes(businessNormalized)) return false;
  if (blockedPhrases.some((phrase) => normalized.includes(phrase))) return false;

  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;

  // Every token must actually look like a proper-name token. Do not use an
  // /i regex here: it was the reason phrases such as "because" were accepted.
  if (words.some((word) => !/^[A-Z][a-zA-Z'.-]+$/.test(word))) return false;
  if (words.some((word) => blockedWords.has(word.toLowerCase()))) return false;

  // Avoid obvious all-caps acronyms and business/legal suffixes.
  if (words.some((word) => /^(LLC|INC|CORP|LTD|CO)$/i.test(word))) return false;

  return true;
}

function extractPeopleNearRoles(text: string, businessName: string) {
  const matches: Array<{ name: string; title: string }> = [];

  // Deliberately case-sensitive for person names. Role variants are encoded
  // explicitly in roleSource so lowercase prose cannot be mistaken for names.
  const patterns = [
    new RegExp(`(${personName})\\s*[-–—,:|]\\s*(${roleSource})`, "g"),
    new RegExp(`(${roleSource})\\s*[-–—,:|]?\\s*(${personName})`, "g"),
    new RegExp(`(${personName})\\s+(?:is|as|serves as|works as)?\\s*(?:the\\s+)?(${roleSource})`, "g"),
    new RegExp(`(${personName})\\s*[-–—,:|]\\s*(?:the\\s+)?(${roleSource})\\s+(?:of|for|at)\\b`, "g"),
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const first = match[1] || "";
      const second = match[2] || "";
      const firstIsRole = rolePattern.test(first);
      const name = (firstIsRole ? second : first).trim();
      const title = (firstIsRole ? first : second).trim();
      if (looksLikePerson(name, businessName)) matches.push({ name, title });
    }
  }

  return matches;
}

async function duckDuckGoSearch(query: string) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
  });
  if (!response.ok) return [];
  const $ = cheerio.load(await response.text());
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  $(".result").slice(0, 10).each((_, element) => {
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
    `"${business.name}" "managing member"${location}`,
  ];

  const pages = (await Promise.all(queries.map(duckDuckGoSearch))).flat();
  const candidates = new Map<string, OwnerCandidate>();

  for (const result of pages) {
    const combined = `${result.title}. ${result.snippet}`;
    const people = extractPeopleNearRoles(combined, business.name);

    for (const person of people) {
      const key = normalize(person.name);
      const source = { label: result.title, url: result.url, snippet: result.snippet };
      const existing = candidates.get(key);

      if (existing) {
        if (!existing.sources.some((item) => item.url === source.url)) existing.sources.push(source);
        existing.confidence = Math.min(98, existing.confidence + 18);
        if (!existing.title && person.title) existing.title = person.title;
      } else {
        let confidence = 64;
        if (/linkedin|bbb|bizapedia|opencorporates|crunchbase/i.test(`${result.title} ${result.url}`)) confidence += 8;
        if (normalize(combined).includes(normalize(business.name))) confidence += 8;
        candidates.set(key, {
          name: person.name,
          title: person.title,
          confidence: Math.min(confidence, 90),
          sources: [source],
        });
      }
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.confidence >= 60)
    .sort((a, b) => b.confidence - a.confidence || b.sources.length - a.sources.length)
    .slice(0, 5);
}
