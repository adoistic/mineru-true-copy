import * as admin from 'firebase-admin';
import path from 'path';

let initialized = false;

function getApp(): admin.app.App {
  if (initialized) {
    return admin.app();
  }

  // Resolve service account path
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './.firebase-service-account.json';
  const absolutePath = path.isAbsolute(credPath) ? credPath : path.resolve(process.cwd(), '..', credPath);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const serviceAccount = require(absolutePath);
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
