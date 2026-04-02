import * as admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';

// Load env from parent directory
const parentEnvPath = path.resolve(process.cwd(), '..', '.env');
if (fs.existsSync(parentEnvPath)) {
  require('dotenv').config({ path: parentEnvPath });
}

let initialized = false;

function getApp(): admin.app.App {
  if (initialized) {
    return admin.app();
  }

  // Resolve service account path — check multiple locations
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '.firebase-service-account.json';
  const candidates = [
    path.isAbsolute(credPath) ? credPath : null,
    path.resolve(process.cwd(), '..', credPath),
    path.resolve(process.cwd(), credPath),
    path.resolve(process.cwd(), '..', '.firebase-service-account.json'),
  ].filter(Boolean) as string[];

  const absolutePath = candidates.find(p => fs.existsSync(p));
  if (!absolutePath) {
    throw new Error(`Firebase service account not found. Searched: ${candidates.join(', ')}`);
  }

  try {
    const serviceAccount = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    initialized = true;
    console.log('[Firebase] Admin SDK initialized');
  } catch (err) {
    console.error('[Firebase] Failed to initialize:', err);
    throw new Error('Firebase Admin SDK initialization failed. Check GOOGLE_APPLICATION_CREDENTIALS path.');
  }

  return admin.app();
}

export function getFirestore(): admin.firestore.Firestore {
  getApp();
  return admin.firestore();
}

export { admin };
