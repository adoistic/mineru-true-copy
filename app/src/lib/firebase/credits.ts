import { getFirestore } from './admin';
import { ActivationKey, UsageLog, JobType } from '@/types';

const KEYS_COLLECTION = 'keys';
const USAGE_COLLECTION = 'usage_logs';

// Helper to read credit_balance from either field name (app uses credit_balance, admin uses credits)
function readCreditBalance(data: Record<string, unknown>): number {
  return (data.credit_balance as number) ?? (data.credits as number) ?? 0;
}

function readCreditsReserved(data: Record<string, unknown>): number {
  return (data.credits_reserved as number) ?? 0;
}

// Resolve a keyId (could be doc ID or key string) to the actual Firestore doc ref
async function resolveKeyRef(db: FirebaseFirestore.Firestore, keyId: string) {
  // Try by document ID first
  const docRef = db.collection(KEYS_COLLECTION).doc(keyId);
  const doc = await docRef.get();
  if (doc.exists) return { ref: docRef, doc };

  // Fallback: lookup by key field
  const snapshot = await db.collection(KEYS_COLLECTION)
    .where('key', '==', keyId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { ref: snapshot.docs[0].ref, doc: snapshot.docs[0] };
}

export async function reserveCredits(keyId: string, amount: number, jobId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const db = getFirestore();

  try {
    // Resolve the key ref first (outside transaction for the query fallback)
    const resolved = await resolveKeyRef(db, keyId);
    if (!resolved) throw new Error('Key not found');

    const keyRef = resolved.ref;

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(keyRef);
      if (!doc.exists) throw new Error('Key not found');

      const data = doc.data() as Record<string, unknown>;

      if (data.status !== 'active') {
        throw new Error('Key is not active');
      }

      if (data.expires_at && new Date(data.expires_at as string) < new Date()) {
        throw new Error('Key has expired');
      }

      const balance = readCreditBalance(data);
      const reserved = readCreditsReserved(data);
      const available = balance - reserved;
      if (available < amount) {
        throw new Error(`Insufficient credits. Need ${amount}, available ${available}`);
      }

      tx.update(keyRef, {
        credits_reserved: reserved + amount,
        updated_at: new Date().toISOString(),
      });
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function finalizeCredits(keyId: string, params: {
  jobId: string;
  creditsReserved: number;
  creditsCharged: number;
  jobType: JobType;
  fileName: string;
  pagesProcessed: number;
  status: 'success' | 'partial' | 'failed';
  errorMessage?: string;
}): Promise<void> {
  const db = getFirestore();

  // Resolve the key ref first
  const resolved = await resolveKeyRef(db, keyId);
  if (!resolved) throw new Error('Key not found');
  const keyRef = resolved.ref;

  await db.runTransaction(async (tx) => {
    const doc = await tx.get(keyRef);
    if (!doc.exists) throw new Error('Key not found');

    const data = doc.data() as Record<string, unknown>;
    const balance = readCreditBalance(data);
    const reserved = readCreditsReserved(data);

    // Release reservation and charge actual amount
    const newBalance = balance - params.creditsCharged;
    const newReserved = Math.max(0, reserved - params.creditsReserved);
    tx.update(keyRef, {
      credit_balance: newBalance,
      credits_reserved: newReserved,
      updated_at: new Date().toISOString(),
    });
  });

  // Log usage
  const usageLog: UsageLog = {
    key_id: keyId,
    job_type: params.jobType,
    file_name: params.fileName,
    pages_processed: params.pagesProcessed,
    credits_charged: params.creditsCharged,
    status: params.status,
    error_message: params.errorMessage ?? null,
    timestamp: new Date().toISOString(),
  };

  await db.collection(USAGE_COLLECTION).add(usageLog);
}

export async function getBalance(keyId: string): Promise<{
  balance: number;
  reserved: number;
  available: number;
} | null> {
  const db = getFirestore();

  // Try by document ID first
  let doc = await db.collection(KEYS_COLLECTION).doc(keyId).get();

  // If not found, try looking up by the key field (handles key string vs doc ID)
  if (!doc.exists) {
    const snapshot = await db.collection(KEYS_COLLECTION)
      .where('key', '==', keyId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    doc = snapshot.docs[0];
  }

  const data = doc.data() as Record<string, unknown>;
  const balance = readCreditBalance(data);
  const reserved = readCreditsReserved(data);
  return {
    balance,
    reserved,
    available: balance - reserved,
  };
}

export async function getUsageLogs(keyId: string, limit = 100): Promise<UsageLog[]> {
  const db = getFirestore();
  const snapshot = await db.collection(USAGE_COLLECTION)
    .where('key_id', '==', keyId)
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map(doc => doc.data() as UsageLog);
}

export function calculateCredits(jobType: JobType, pageCount: number, languageCount = 1): number {
  switch (jobType) {
    case 'ocr':
      return pageCount; // 1 credit/page
    case 'heading_correction':
      return pageCount; // 1 credit/page
    case 'extract':
      return 1; // 1 credit flat
    case 'wizard':
      return 5; // 5 credits/session
    case 'translate':
      return pageCount * 2 * languageCount; // 2 credits/page/language
    default:
      return 0;
  }
}
