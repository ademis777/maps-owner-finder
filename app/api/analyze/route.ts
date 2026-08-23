import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveGoogleMapsBusiness } from "@/lib/maps";
import { findOwnerCandidates } from "@/lib/owners";

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

function prefer(value?: string, fallback?: string) {
  const clean = value?.trim();
  return clean || fallback?.trim() || undefined;
}

export async function POST(request: Request) {
  try {
    const input = Input.parse(await request.json());
    const resolved = await resolveGoogleMapsBusiness(input.url);
    const business = {
      ...resolved,
      name: prefer(resolved.name, input.seed?.name),
      address: prefer(resolved.address, input.seed?.address),
      phone: prefer(resolved.phone, input.seed?.phone),
      website: prefer(resolved.website, input.seed?.website),
      category: prefer(resolved.category, input.seed?.category),
    };

    const ownerCandidates = await findOwnerCandidates(business);

    const warnings: string[] = [];
    if (resolved.mapsFetchWarning) warnings.push(resolved.mapsFetchWarning);
    if (!resolved.phone && input.seed?.phone) warnings.push("Phone came from the uploaded CSV because Google Maps did not expose it in public HTML.");
    if (!resolved.website && input.seed?.website) warnings.push("Website came from the uploaded CSV because Google Maps did not expose it in public HTML.");
    if (!resolved.address && input.seed?.address) warnings.push("Address came from the uploaded CSV because Google Maps did not expose it in public HTML.");
    if (ownerCandidates.length === 0) warnings.push("No owner candidate was strong enough to return from the public search results checked.");

    return NextResponse.json({ business, ownerCandidates, warnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to analyze this company.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
