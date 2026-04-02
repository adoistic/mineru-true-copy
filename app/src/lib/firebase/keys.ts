import { getFirestore } from './admin';
import { ActivationKey, KeyStatus } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const KEYS_COLLECTION = 'keys';

function generateActivationKey(): string {
  // Format: XXXX-XXXX-XXXX-XXXX (alphanumeric, uppercase)
  const segments = Array.from({ length: 4 }, () =>
    crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 4)
  );
  return segments.join('-');
}

export async function createKey(params: {
  client_label: string;
  credit_balance: number;
  can_whitelabel?: boolean;
  expires_at: string;
  app_name?: string;
}): Promise<ActivationKey> {
  const db = getFirestore();
  const key = generateActivationKey();
  const id = uuidv4();
  const now = new Date().toISOString();

  const keyDoc: ActivationKey = {
    key,
    client_label: params.client_label,
    credit_balance: params.credit_balance,
    credits_reserved: 0,
    can_whitelabel: params.can_whitelabel ?? false,
    status: 'active',
    device_id: null,
    app_name: params.app_name ?? null,
    created_at: now,
    expires_at: params.expires_at,
    updated_at: now,
  };

  await db.collection(KEYS_COLLECTION).doc(id).set(keyDoc);
  return keyDoc;
}

export async function validateKey(key: string, deviceId: string): Promise<{
  valid: boolean;
  key_id?: string;
  data?: ActivationKey;
  error?: string;
}> {
  const db = getFirestore();
  const snapshot = await db.collection(KEYS_COLLECTION)
    .where('key', '==', key)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return { valid: false, error: 'Invalid activation key' };
  }

  const doc = snapshot.docs[0];
  const data = doc.data() as ActivationKey;

  if (data.status === 'revoked') {
    return { valid: false, error: 'This key has been revoked' };
  }

  if (new Date(data.expires_at) < new Date()) {
    return { valid: false, error: 'This key has expired' };
  }

  // Device locking
  if (data.device_id && data.device_id !== deviceId) {
    return { valid: false, error: 'This key is locked to another device' };
  }

  // Lock to device on first use
  if (!data.device_id) {
    await doc.ref.update({
      device_id: deviceId,
      updated_at: new Date().toISOString(),
    });
  }

  return { valid: true, key_id: doc.id, data: { ...data, device_id: data.device_id || deviceId } };
}

export async function getKeyById(keyId: string): Promise<ActivationKey | null> {
  const db = getFirestore();
  const doc = await db.collection(KEYS_COLLECTION).doc(keyId).get();
  if (!doc.exists) return null;
  return doc.data() as ActivationKey;
}

export async function getKeyByKey(key: string): Promise<{ id: string; data: ActivationKey } | null> {
  const db = getFirestore();
  const snapshot = await db.collection(KEYS_COLLECTION)
    .where('key', '==', key)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, data: snapshot.docs[0].data() as ActivationKey };
}

export async function topUpCredits(keyId: string, amount: number): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(KEYS_COLLECTION).doc(keyId);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error('Key not found');
    const data = doc.data() as ActivationKey;
    tx.update(ref, {
      credit_balance: data.credit_balance + amount,
      updated_at: new Date().toISOString(),
    });
  });
}

export async function revokeKey(keyId: string): Promise<void> {
  const db = getFirestore();
  await db.collection(KEYS_COLLECTION).doc(keyId).update({
    status: 'revoked' as KeyStatus,
    updated_at: new Date().toISOString(),
  });
}

export async function resetDeviceLock(keyId: string): Promise<void> {
  const db = getFirestore();
  await db.collection(KEYS_COLLECTION).doc(keyId).update({
    device_id: null,
    updated_at: new Date().toISOString(),
  });
}

export async function listKeys(): Promise<Array<{ id: string; data: ActivationKey }>> {
  const db = getFirestore();
  const snapshot = await db.collection(KEYS_COLLECTION).orderBy('created_at', 'desc').get();
  return snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() as ActivationKey }));
}

export async function updateWhitelabel(keyId: string, canWhitelabel: boolean): Promise<void> {
  const db = getFirestore();
  await db.collection(KEYS_COLLECTION).doc(keyId).update({
    can_whitelabel: canWhitelabel,
    updated_at: new Date().toISOString(),
  });
}
