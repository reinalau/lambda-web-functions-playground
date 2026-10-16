/**
 * Strands tool that fetches a compact daily weather forecast from the
 * Open-Meteo forecast API (no API key required).
 */
import { tool } from "@strands-agents/sdk";
import { z } from "zod";

/** A single day of forecast data. */
export interface ForecastDay {
  date: string;
  temperatureMax: number;
  temperatureMin: number;
  precipitationProbabilityMax: number;
  precipitationSum: number;
  weatherCode: number;
}

/** Successful forecast result. */
export interface ForecastResult {
  days: ForecastDay[];
}

/** Structured error returned when the forecast request fails. */
export interface ForecastError {
  error: "upstream_failure";
  detail: string;
}

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const DAILY_FIELDS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "precipitation_sum",
  "weathercode",
].join(",");

const DEFAULT_DAYS = 7;

/** Shape of the Open-Meteo daily payload we rely on. */
interface OpenMeteoDaily {
  time?: string[];
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  precipitation_probability_max?: number[];
  precipitation_sum?: number[];
  weathercode?: number[];
}

/**
 * Tool: get_forecast
 *
 * Returns a small array of per-day forecast objects for the given coordinates.
 * Returns a structured error object instead of throwing on failure.
 */
export const getForecastTool = tool({
  name: "get_forecast",
  description:
    "Fetch a compact daily weather forecast for a given latitude/longitude.",
  inputSchema: z.object({
    latitude: z.number().describe("Latitude in decimal degrees."),
    longitude: z.number().describe("Longitude in decimal degrees."),
    days: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe("Number of forecast days (1-16). Defaults to 7."),
  }),
  callback: async ({
    latitude,
    longitude,
    days,
  }): Promise<ForecastResult | ForecastError> => {
    const forecastDays = days ?? DEFAULT_DAYS;
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      daily: DAILY_FIELDS,
      timezone: "auto",
      forecast_days: String(forecastDays),
    });

    try {
      const response = await fetch(`${FORECAST_URL}?${params.toString()}`);
      if (!response.ok) {
        return {
          error: "upstream_failure",
          detail: `HTTP ${response.status}`,
        };
      }

      const payload = (await response.json()) as { daily?: OpenMeteoDaily };
      const daily = payload.daily ?? {};
      const dates = daily.time ?? [];

      const result: ForecastDay[] = dates.map((date, index) => ({
        date,
        temperatureMax: daily.temperature_2m_max?.[index] ?? 0,
        temperatureMin: daily.temperature_2m_min?.[index] ?? 0,
        precipitationProbabilityMax:
          daily.precipitation_probability_max?.[index] ?? 0,
        precipitationSum: daily.precipitation_sum?.[index] ?? 0,
        weatherCode: daily.weathercode?.[index] ?? 0,
      }));

      return { days: result };
    } catch (cause) {
      return {
        error: "upstream_failure",
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }
  },
});
