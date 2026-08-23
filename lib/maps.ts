import * as cheerio from "cheerio";

export type Business = {
  name?: string;
  address?: string;
  phone?: string;
  website?: string;
  category?: string;
  mapsUrl: string;
};

function clean(value?: string | null) {
  return value?.replace(/\\u0026/g, "&").replace(/\\u003d/g, "=").replace(/\\u002f/g, "/").replace(/\\n/g, " ").trim();
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
}

export async function resolveGoogleMapsBusiness(inputUrl: string): Promise<Business> {
  const parsed = new URL(inputUrl);
  const host = parsed.hostname.toLowerCase();
  if (!host.includes("google.") && host !== "maps.app.goo.gl" && host !== "goo.gl") {
    throw new Error("Please paste a Google Maps company link.");
  }

  const response = await fetch(inputUrl, {
    redirect: "follow",
    cache: "no-store",
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) throw new Error(`Google Maps returned HTTP ${response.status}.`);

  const finalUrl = response.url || inputUrl;
  const html = await response.text();
  const $ = cheerio.load(html);
  const title = $("meta[property='og:title']").attr("content") || $("title").text();
  const description = $("meta[property='og:description']").attr("content") || "";
  const text = `${html}\n${description}`;

  let name = clean(title)?.replace(/\s*-\s*Google Maps.*$/i, "").replace(/\s*·\s*Google.*$/i, "");
  if (!name) {
    try {
      const urlName = decodeURIComponent(new URL(finalUrl).pathname.split("/place/")[1]?.split("/")[0] || "").replace(/\+/g, " ");
      name = clean(urlName);
    } catch {}
  }

  const phone = firstMatch(text, [
    /\"formatted_phone_number\"\s*:\s*\"([^\"]+)\"/i,
    /\"telephone\"\s*:\s*\"([^\"]+)\"/i,
    /\[(?:null,)?\"(\+?\d[\d\s().-]{7,}\d)\"\s*,\s*\"tel:/i,
  ]);

  const address = firstMatch(text, [
    /\"streetAddress\"\s*:\s*\"([^\"]+)\"/i,
    /\"address\"\s*:\s*\{[^}]*\"streetAddress\"\s*:\s*\"([^\"]+)\"/i,
    /\"formatted_address\"\s*:\s*\"([^\"]+)\"/i,
  ]) || clean(description.split("·")[0]);

  const website = firstMatch(text, [
    /\"url\"\s*:\s*\"(https?:\\?\/\\?\/[^\"]+)\"\s*,\s*\"sameAs\"/i,
    /\"website\"\s*:\s*\"(https?:\\?\/\\?\/[^\"]+)\"/i,
  ]);

  const category = firstMatch(text, [
    /\"@type\"\s*:\s*\"([^\"]+)\"/i,
    /\"category\"\s*:\s*\"([^\"]+)\"/i,
  ]);

  return { name, address, phone, website, category, mapsUrl: finalUrl };
}
