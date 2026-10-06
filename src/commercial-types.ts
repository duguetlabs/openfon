/** Server-owned commercial configuration. Never serialize this into customer DTOs. */
export interface CommercialBindings {
  DODO_API_KEY?: string;
  DODO_WEBHOOK_SECRET?: string;
  DODO_MODE?: "test" | "live";
  DODO_PRODUCTS_JSON?: string;
  DODO_METERS_JSON?: string;
  COMMERCIAL_BILLING_VERIFIED?: string;
  COMMERCIAL_CHARGING_ENABLED?: string;
  COMMERCIAL_ANNUAL_POLICY?: "upfront";
  COMMERCIAL_TAX_POLICY?: "inclusive" | "exclusive";
  COMMERCIAL_PUBLIC_ORIGIN?: string;
  COMMERCIAL_OPERATOR_TOKEN?: string;
  TELNYX_PURCHASES_ENABLED?: string;
  TELNYX_CARRIER_VERIFIED?: string;
  TELNYX_PURCHASE_COUNTRY?: string;
  TELNYX_MAX_SETUP_MINOR?: string;
  TELNYX_MAX_MONTHLY_MINOR?: string;
  TELNYX_PURCHASE_CURRENCY?: string;
}

export type PlanId = "flex" | "small" | "growth";
export type BillingCadence = "monthly" | "annual";
export const PLANS = [
  {
    id: "flex",
    name: "Flex",
    monthlyMinor: 1900,
    annualEquivalentMinor: 1700,
    includedMinutes: 0,
    monthlyOverageMinorPerMinute: 16,
    annualOverageMinorPerMinute: 15,
  },
  {
    id: "small",
    name: "Small",
    monthlyMinor: 6900,
    annualEquivalentMinor: 5800,
    includedMinutes: 500,
    monthlyOverageMinorPerMinute: 9,
    annualOverageMinorPerMinute: 8,
  },
  {
    id: "growth",
    name: "Growth",
    monthlyMinor: 23900,
    annualEquivalentMinor: 20900,
    includedMinutes: 2500,
    monthlyOverageMinorPerMinute: 9,
    annualOverageMinorPerMinute: 8,
  },
] as const;

export interface UsageMetrics {
  /** Decimal seconds from provider usage, not browser or local wall time. */
  voiceSessionSeconds?: string;
  inputTokens?: number;
    inputAudioTokens?: number;
    inputTextTokens?: number;
    cachedAudioTokens?: number;
    cachedTextTokens?: number;
    outputAudioTokens?: number;
    outputTextTokens?: number;

  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}
export interface UsageObservation {
  eventId: string;
  callId?: string;
  jobId?: string;
  source: "azure_voice" | "azure_reasoning" | "azure_text" | "azure_realtime" | "azure_realtime_session";
  providerSessionId: string;
  providerResponseId?: string;
  observedAt: string;
  final: boolean;
  metrics: UsageMetrics;
  model?: string;
}

export interface BillingView {
  plan: PlanId | null;
  cadence: BillingCadence | null;
  status:
    | "unconfigured"
    | "none"
    | "pending"
    | "active"
    | "past_due"
    | "canceled"
    | "unpaid";
  currency: "EUR";
  cycle: { start: string; end: string } | null;
  usage: {
    durationMs: number;
    includedMs: number;
    overageMs: number;
    overageMinor: number;
    provisional: boolean;
  };
  plans: typeof PLANS;
  checkoutAvailable: boolean;
  availableCadences: BillingCadence[];
  cancellation?: { termEnd: string; status: string } | null;
  portalAvailable: boolean;
  unavailableReason: string | null;
}
