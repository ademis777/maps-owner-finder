import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveGoogleMapsBusiness } from "@/lib/maps";
import { findOwnerCandidates } from "@/lib/owners";

const Input = z.object({ url: z.string().url() });

export async function POST(request: Request) {
  try {
    const input = Input.parse(await request.json());
    const business = await resolveGoogleMapsBusiness(input.url);
    const ownerCandidates = await findOwnerCandidates(business);

    const warnings: string[] = [];
    if (!business.phone) warnings.push("Phone was not exposed in the public Google Maps HTML for this request.");
    if (!business.website) warnings.push("Website was not exposed in the public Google Maps HTML for this request.");
    if (ownerCandidates.length === 0) warnings.push("No owner candidate was strong enough to return from the public search results checked.");

    return NextResponse.json({ business, ownerCandidates, warnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to analyze this company.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
