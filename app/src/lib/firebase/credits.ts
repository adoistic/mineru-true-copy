import { getFirestore } from './admin';
import { ActivationKey, UsageLog, JobType } from '@/types';

const KEYS_COLLECTION = 'keys';
const USAGE_COLLECTION = 'usage_logs';

export async function reserveCredits(keyId: string, amount: number, jobId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const db = getFirestore();
  const keyRef = db.collection(KEYS_COLLECTION).doc(keyId);

  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(keyRef);
      if (!doc.exists) throw new Error('Key not found');

      const data = doc.data() as ActivationKey;

      if (data.status !== 'active') {
        throw new Error('Key is not active');
      }

      if (new Date(data.expires_at) < new Date()) {
        throw new Error('Key has expired');
      }

      const available = data.credit_balance - data.credits_reserved;
      if (available < amount) {
        throw new Error(`Insufficient credits. Need ${amount}, available ${available}`);
      }

      tx.update(keyRef, {
        credits_reserved: data.credits_reserved + amount,
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
  const keyRef = db.collection(KEYS_COLLECTION).doc(keyId);

  await db.runTransaction(async (tx) => {
    const doc = await tx.get(keyRef);
    if (!doc.exists) throw new Error('Key not found');

    const data = doc.data() as ActivationKey;

    // Release reservation and charge actual amount
    const refund = params.creditsReserved - params.creditsCharged;
    tx.update(keyRef, {
      credit_balance: data.credit_balance - params.creditsCharged,
      credits_reserved: Math.max(0, data.credits_reserved - params.creditsReserved),
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
  const doc = await db.collection(KEYS_COLLECTION).doc(keyId).get();
  if (!doc.exists) return null;

  const data = doc.data() as ActivationKey;
  return {
    balance: data.credit_balance,
    reserved: data.credits_reserved,
    available: data.credit_balance - data.credits_reserved,
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
