/**
 * Apple App Store IAP receipt validation.
 *
 * Apple's verifyReceipt endpoint takes a base64 receipt and returns the
 * full purchase record. The recipe Apple recommends:
 *   1. POST to PRODUCTION endpoint first.
 *   2. If status === 21007, retry against SANDBOX endpoint.
 *
 * 21007 means "this is a sandbox receipt sent to production"; 21008 is
 * the converse. Both are noisy in dev because TestFlight builds carry
 * sandbox receipts. We swap automatically.
 *
 * Modern Apple recommends App Store Server Notifications (S2S) + the
 * App Store Server API over verifyReceipt. F2 ships the simpler
 * verifyReceipt path because StoreKit 2's client-side verification is
 * still the friction-minimum starting point. The model can swap later.
 */

const PRODUCTION_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

export type AppleEnvironment = 'production' | 'sandbox';

export interface AppleVerifyInput {
  /** base64-encoded receipt blob from StoreKit */
  receiptData: string;
  /** Apple shared secret (from App Store Connect) — server-only env var */
  sharedSecret: string;
}

export interface AppleVerifyResult {
  ok: true;
  environment: AppleEnvironment;
  /** App-Store-side state of the latest receipt entry. */
  latestReceiptInfo: AppleLatestReceiptInfo[];
  /** Pass-through of the full Apple response for debugging. */
  raw: unknown;
}

export interface AppleVerifyError {
  ok: false;
  status: number;
  message: string;
}

export interface AppleLatestReceiptInfo {
  product_id: string;
  transaction_id: string;
  original_transaction_id: string;
  expires_date_ms: string;       // Apple returns ms-epoch as a numeric string
  cancellation_date_ms?: string;
  is_in_intro_offer_period?: string;
}

/**
 * Validate a receipt against Apple. Auto-falls-back from production to
 * sandbox per Apple's documented dance.
 */
export async function verifyAppleReceipt(input: AppleVerifyInput): Promise<AppleVerifyResult | AppleVerifyError> {
  const result = await callApple(PRODUCTION_URL, input);
  if (result.ok && result.environment === 'production') return result;
  if (!result.ok) return result;
  // status === 21007 from production → retry against sandbox.
  if (result.environment === 'sandbox') {
    return callApple(SANDBOX_URL, input);
  }
  return result;
}

interface AppleResponse {
  status: number;
  environment?: 'Production' | 'Sandbox';
  latest_receipt_info?: AppleLatestReceiptInfo[];
  receipt?: { in_app?: AppleLatestReceiptInfo[] };
}

async function callApple(url: string, input: AppleVerifyInput): Promise<AppleVerifyResult | AppleVerifyError> {
  const body = {
    'receipt-data': input.receiptData,
    'password': input.sharedSecret,
    // Returns auto-renew / expired state for subscriptions.
    'exclude-old-transactions': true,
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 599,
      message: `Could not reach Apple verifyReceipt: ${(err as Error).message}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: `Apple verifyReceipt returned HTTP ${res.status}`,
    };
  }
  const json = (await res.json()) as AppleResponse;
  // 21007 means: this is a sandbox receipt and you sent it to prod.
  // Bubble that up so the caller can retry against sandbox.
  if (json.status === 21007) {
    return {
      ok: true,
      environment: 'sandbox', // signal: caller should retry
      latestReceiptInfo: [],
      raw: json,
    };
  }
  if (json.status !== 0) {
    return {
      ok: false,
      status: json.status,
      message: `Apple verifyReceipt status=${json.status}`,
    };
  }
  // Apple puts the latest active subscription info in `latest_receipt_info`
  // for auto-renewable subscriptions. Older one-shot purchases are in
  // `receipt.in_app`. We accept either.
  const latest = json.latest_receipt_info ?? json.receipt?.in_app ?? [];
  return {
    ok: true,
    environment: json.environment === 'Sandbox' ? 'sandbox' : 'production',
    latestReceiptInfo: latest,
    raw: json,
  };
}

/**
 * Pulls the most relevant subscription entry out of the response. Apple
 * returns multiple `latest_receipt_info` rows for renewals; the freshest
 * one is the row with the latest `expires_date_ms`.
 */
export function pickActiveEntry(
  entries: AppleLatestReceiptInfo[],
): AppleLatestReceiptInfo | null {
  if (entries.length === 0) return null;
  return entries
    .slice()
    .sort((a, b) => Number(b.expires_date_ms) - Number(a.expires_date_ms))[0];
}
