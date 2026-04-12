import path from 'path';

// Load .env from project root (parent of app/)
const envPath = path.resolve(process.cwd(), '..', '.env');
require('dotenv').config({ path: envPath });

// Also try loading from current directory
require('dotenv').config();

export const env = {
  // Firebase
  googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || './.firebase-service-account.json',

  // OpenRouter
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  modelPrimary: process.env.OPENROUTER_MODEL_PRIMARY || 'x-ai/grok-4.20',
  modelFallback: process.env.OPENROUTER_MODEL_FALLBACK || 'google/gemini-3.1-flash-lite-preview',

  // MinerU
  mineruApiUrl: process.env.MINERU_API_URL || 'http://localhost:51820',

  // Firebase Web SDK (for admin app)
  firebaseApiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
  firebaseAuthDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '',
  firebaseProjectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '',
  firebaseStorageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '',
  firebaseMessagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '',
  firebaseAppId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',

  // Admin
  adminEmail: process.env.ADMIN_EMAIL || 'adnan@thothica.com',

  // App
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
};
