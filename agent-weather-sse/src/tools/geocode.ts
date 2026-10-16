/**
 * Strands tool that resolves a city name to geographic coordinates using the
 * Open-Meteo geocoding API (no API key required).
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";

/** Successful geocoding result. */
export interface GeocodeResult {
  latitude: number;
  longitude: number;
  name: string;
  country: string;
}

/** Structured error returned when geocoding fails. */
export interface GeocodeError {
  error: "city_not_found" | "upstream_failure";
  city?: string;
  detail?: string;
}

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

/**
 * Tool: geocode
 *
 * Looks up the first matching location for a given city name and returns its
 * coordinates. Returns a structured error object instead of throwing so the
 * agent can reason about failures.
 */
export const geocodeTool = tool({
  name: "geocode",
  description:
    "Resolve a city name into latitude/longitude coordinates and country.",
  inputSchema: z.object({
    city: z.string().describe("City name to look up, e.g. 'Buenos Aires'."),
  }),
  callback: async ({ city }): Promise<GeocodeResult | GeocodeError> => {
    const url = `${GEOCODING_URL}?name=${encodeURIComponent(city)}&count=1`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return {
          error: "upstream_failure",
          detail: `HTTP ${response.status}`,
        };
      }

      const payload = (await response.json()) as {
        results?: Array<{
          latitude: number;
          longitude: number;
          name: string;
          country: string;
        }>;
      };

      const first = payload.results?.[0];
      if (!first) {
        return { error: "city_not_found", city };
      }

      return {
        latitude: first.latitude,
        longitude: first.longitude,
        name: first.name,
        country: first.country,
      };
    } catch (cause) {
      return {
        error: "upstream_failure",
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }
  },
});
