import * as cheerio from "cheerio";

export type Business = {
  name?: string;
  address?: string;
  phone?: string;
  website?: string;
  category?: string;
  mapsUrl: string;
  mapsFetchWarning?: string;
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

function nameFromMapsUrl(url: string) {
  try {
    const parsed = new URL(url);
    const placePart = parsed.pathname.split("/place/")[1]?.split("/")[0];
    if (placePart) return clean(decodeURIComponent(placePart).replace(/\+/g, " "));

    const query = parsed.searchParams.get("query") || parsed.searchParams.get("q");
    if (query) return clean(decodeURIComponent(query).replace(/\+/g, " "));
  } catch {}
}

export async function resolveGoogleMapsBusiness(inputUrl: string): Promise<Business> {
  const parsed = new URL(inputUrl);
  const host = parsed.hostname.toLowerCase();
  if (!host.includes("google.") && host !== "maps.app.goo.gl" && host !== "goo.gl") {
    throw new Error("Please paste a Google Maps company link.");
  }

  let finalUrl = inputUrl;
  let html = "";
  let mapsFetchWarning: string | undefined;

  try {
    const response = await fetch(inputUrl, {
      redirect: "follow",
      cache: "no-store",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      mapsFetchWarning = `Google Maps returned HTTP ${response.status}; continuing with data available in the URL/CSV.`;
    } else {
      finalUrl = response.url || inputUrl;
      html = await response.text();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "request failed";
    mapsFetchWarning = `Google Maps fetch failed (${reason}); continuing with data available in the URL/CSV.`;
  }

  if (!html) {
    return {
      name: nameFromMapsUrl(finalUrl) || nameFromMapsUrl(inputUrl),
      mapsUrl: finalUrl,
      mapsFetchWarning,
    };
  }

  const $ = cheerio.load(html);
  const title = $("meta[property='og:title']").attr("content") || $("title").text();
  const description = $("meta[property='og:description']").attr("content") || "";
  const text = `${html}\n${description}`;

  let name = clean(title)?.replace(/\s*-\s*Google Maps.*$/i, "").replace(/\s*·\s*Google.*$/i, "");
  if (!name) name = nameFromMapsUrl(finalUrl) || nameFromMapsUrl(inputUrl);

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

  return { name, address, phone, website, category, mapsUrl: finalUrl, mapsFetchWarning };
}
