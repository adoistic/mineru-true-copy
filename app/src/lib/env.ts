import path from 'path';

// Load .env from project root (parent of app/)
const envPath = path.resolve(process.cwd(), '..', '.env');
require('dotenv').config({ path: envPath });

// Also try loading from current directory
require('dotenv').config();

export const env = {
  // OpenRouter
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  modelPrimary: process.env.OPENROUTER_MODEL_PRIMARY || 'x-ai/grok-4.20',
  modelFallback: process.env.OPENROUTER_MODEL_FALLBACK || 'google/gemini-3.1-flash-lite-preview',

  // MinerU
  mineruApiUrl: process.env.MINERU_API_URL || 'http://localhost:51820',

  // App
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
};
