import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  query,
  where,
  orderBy,
  increment,
} from "firebase/firestore";
import { getDb } from "./firebase";

export interface ActivationKey {
  id: string;
  key: string;
  client_label: string;
  credit_balance: number;
  status: "active" | "revoked" | "expired";
  device_id: string | null;
  created_at: string;
  expires_at: string | null;
  can_whitelabel: boolean;
}

export interface UsageLog {
  id: string;
  key_id: string;
  action: string;
  credits_used: number;
  timestamp: string;
}

function generateKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const segment = () =>
    Array.from(
      { length: 4 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  return `${segment()}-${segment()}-${segment()}-${segment()}`;
}

export async function listKeys(): Promise<ActivationKey[]> {
  const q = query(collection(getDb(), "keys"), orderBy("created_at", "desc"));
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as ActivationKey[];
}

export async function createKey(params: {
  client_label: string;
  credits: number;
  expires_at: Date | null;
  whitelabel: boolean;
}): Promise<string> {
  const key = generateKey();
  const docRef = await addDoc(collection(getDb(), "keys"), {
    key,
    client_label: params.client_label,
    credit_balance: params.credits,
    status: "active",
    device_id: null,
    created_at: new Date().toISOString(),
    expires_at: params.expires_at ? params.expires_at.toISOString() : null,
    can_whitelabel: params.whitelabel,
  });
  return docRef.id;
}

export async function topUpCredits(
  keyId: string,
  amount: number
): Promise<void> {
  const keyRef = doc(getDb(), "keys", keyId);
  await updateDoc(keyRef, {
    credit_balance: increment(amount),
  });
}

export async function revokeKey(keyId: string): Promise<void> {
  const keyRef = doc(getDb(), "keys", keyId);
  await updateDoc(keyRef, {
    status: "revoked",
  });
}

export async function resetDeviceLock(keyId: string): Promise<void> {
  const keyRef = doc(getDb(), "keys", keyId);
  await updateDoc(keyRef, {
    device_id: null,
  });
}

export async function getUsageLogs(keyId: string): Promise<UsageLog[]> {
  const q = query(
    collection(getDb(), "usage_logs"),
    where("key_id", "==", keyId),
    orderBy("timestamp", "desc")
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as UsageLog[];
}
