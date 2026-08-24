import { NextResponse } from "next/server";
import { z } from "zod";
import { mergeMapsWithSeed, resolveGoogleMapsBusiness } from "@/lib/maps";
import { findOwnerCandidatesWithDebug } from "@/lib/owners";

const Input = z.object({
  url: z.string().url(),
  seed: z.object({
    name: z.string().optional(),
    address: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
    category: z.string().optional(),
  }).optional(),
});

export async function POST(request: Request) {
  try {
    const totalStarted = performance.now();
    const input = Input.parse(await request.json());
    const mapsStarted = performance.now();
    const resolved = await resolveGoogleMapsBusiness(input.url);
    const mapsDurationMs = Math.round(performance.now() - mapsStarted);
    const business = mergeMapsWithSeed(resolved, input.seed);

    const { ownerCandidates, debug } = await findOwnerCandidatesWithDebug(business);
    debug.timing.unshift({ stage: "maps_fetch", status: "completed", durationMs: mapsDurationMs });
    debug.timing.push({ stage: "api_total", status: "completed", durationMs: Math.round(performance.now() - totalStarted) });

    const warnings: string[] = [];
    if (resolved.mapsFetchWarning) warnings.push(resolved.mapsFetchWarning);
    if (!resolved.phone && input.seed?.phone) warnings.push("Phone came from the uploaded CSV because Google Maps did not expose it in public HTML.");
    if (!resolved.website && input.seed?.website) warnings.push("Website came from the uploaded CSV because Google Maps did not expose it in public HTML.");
    if (!resolved.address && input.seed?.address) warnings.push("Address came from the uploaded CSV because Google Maps did not expose it in public HTML.");
    if (business.mapsAddressParseError) warnings.push(business.mapsAddressParseError);
    if (ownerCandidates.length === 0) warnings.push("No owner candidate was strong enough to return from the public search results checked.");

    return NextResponse.json({ business, ownerCandidates, warnings, debug });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to analyze this company.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
